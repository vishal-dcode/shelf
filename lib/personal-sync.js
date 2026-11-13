// Account sync: your own spaces (not ones shared through Share) follow your
// account to every browser you sign in on. Runs in the background worker as
// part of lib/sync.js's rounds.
//
// The server keeps one copy per account, encrypted at rest with a key the
// Worker holds. It is not end-to-end like shared
// spaces: that is what lets a brand-new browser get everything back with
// nothing but a sign-in. This browser remembers the last copy it synced
// (`base`) so edits made in two browsers merge (lib/merge.js mergeSpaces).

import { loadState, update } from "./store.js";
import { api, ApiError } from "./api.js";
import { PERSONAL_KEY, SYNC_KEY } from "./account.js";
import { mergeSpaces, sanitizePersonal, shareableSpace } from "./merge.js";
import { EMPTY_PROFILE, PROFILE_KEY, newerProfile, readProfile, sanitizeProfile } from "./profile.js";

// The background worker skips a round for a profile write this file made.
let lastProfileApplied = null;
export function isOwnProfileWrite(profile) {
  return lastProfileApplied !== null && canon(sanitizeProfile(profile)) === lastProfileApplied;
}

// Compares content, not key order (merged and stored copies list fields in
// different orders).
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const same = (a, b) => canon(a) === canon(b);

// What is synced: each of your own spaces, without per-browser view state.
export function personalPart(state) {
  return state.spaces.filter((s) => !s.shared).map((s) => ({ id: s.id, ...shareableSpace(s) }));
}

// The background worker skips a round for storage changes that this file
// made itself.
let lastApplied = null;
export function isOwnWrite(state) {
  return lastApplied !== null && canon(personalPart(state)) === lastApplied;
}

function takenByShared(state) {
  const taken = new Set();
  for (const s of state.spaces) {
    if (!s.shared) continue;
    taken.add(s.id);
    for (const c of s.collections) {
      taken.add(c.id);
      for (const l of c.links) taken.add(l.id);
    }
  }
  return taken;
}

// A browser's untouched starting space shouldn't pile up as one more empty
// "Personal" every time someone signs in somewhere new.
function withoutStarter(local, remote) {
  if (remote.length === 0) return local;
  return local.filter((s) => s.collections.length > 0 || s.name !== "Personal");
}

// Puts the merged spaces in place, keeping shared spaces where they were and
// each shelf's folded/unfolded state. With `replace`, everything that was
// here goes (another account had been using this browser).
async function apply(merged, expected, { replace = false } = {}) {
  let applied = false;
  await update(
    (d) => {
      if (!replace && !same(personalPart(d), expected)) return; // edited meanwhile: next round
      const collapsed = new Map(d.spaces.flatMap((s) => s.collections.map((c) => [c.id, c.collapsed])));
      const result = merged.map((s) => ({
        ...structuredClone(s),
        collections: s.collections.map((c) => ({ ...structuredClone(c), collapsed: collapsed.get(c.id) ?? false })),
      }));
      if (!replace) {
        // Each shared space goes back after the space it followed before.
        d.spaces.forEach((s, i) => {
          if (!s.shared) return;
          let at = 0;
          for (let j = i - 1; j >= 0; j--) {
            const k = result.findIndex((x) => x.id === d.spaces[j].id);
            if (k !== -1) {
              at = k + 1;
              break;
            }
          }
          result.splice(at, 0, s);
        });
      }
      while (result.length > 100) {
        const k = result.findLastIndex((s) => !s.shared);
        if (k === -1) break;
        result.splice(k, 1);
      }
      if (result.length === 0) result.push({ id: crypto.randomUUID(), name: "Personal", collections: [] });
      d.spaces = result;
      if (!d.spaces.some((s) => s.id === d.activeSpaceId)) d.activeSpaceId = d.spaces[0].id;
      applied = true;
    },
    { sync: true },
  );
  return applied;
}

// One round. Returns true if anything changed here or on the server.
export async function syncPersonal(userId) {
  const stored = (await chrome.storage.local.get(PERSONAL_KEY))[PERSONAL_KEY];
  let otherAccount = Boolean(stored?.userId && stored.userId !== userId);
  let meta = stored?.userId === userId ? stored : null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await loadState();
    const local = personalPart(state);
    const localProfile = await readProfile();
    const baseProfile = meta?.profile ? sanitizeProfile(meta.profile) : EMPTY_PROFILE;
    const remote = await api(`/v1/sync${meta?.version ? `?have=${meta.version}` : ""}`);
    if (remote.unchanged && same(local, meta.base) && same(localProfile, baseProfile)) {
      lastApplied = canon(local);
      return false;
    }
    const theirs = remote.unchanged ? meta.base : remote.data ? sanitizePersonal(remote.data, takenByShared(state)) : null;
    // A copy saved without a profile (or by a server that doesn't keep one)
    // counts as holding what this browser last sent.
    const theirsProfile =
      remote.data && "profile" in remote.data ? sanitizeProfile(remote.data.profile) : otherAccount ? EMPTY_PROFILE : baseProfile;
    const profile = otherAccount ? theirsProfile : newerProfile(localProfile, theirsProfile);
    // A base only counts if the server hasn't been reset since.
    const base = meta && remote.version >= meta.version ? meta.base : null;

    let merged;
    if (otherAccount) merged = theirs ?? []; // never carry someone else's tabs into this account
    else if (!theirs) merged = local; // nothing stored yet (or unreadable): this browser's copy
    else merged = mergeSpaces(base, base ? local : withoutStarter(local, theirs), theirs);

    let version = remote.version;
    if (!theirs || !same(merged, theirs) || !same(profile, theirsProfile)) {
      const data = { v: 1, spaces: merged };
      if (profile.updatedAt > 0) data.profile = profile;
      try {
        ({ version } = await api("/v1/sync", { method: "PUT", body: { baseVersion: remote.version, data } }));
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          meta = meta && { ...meta, version: 0 }; // fetch the full copy again
          continue;
        }
        throw err;
      }
    }

    if (otherAccount) {
      // Park what was here, so nothing is lost, then start this account clean.
      await chrome.storage.local.set({ [`shelf:state:previous-account-${Date.now()}`]: state });
      await chrome.storage.local.remove(SYNC_KEY);
    }
    const applied = !otherAccount && same(merged, local) ? true : await apply(merged, local, { replace: otherAccount });
    if (!same(profile, localProfile) && (otherAccount || same(await readProfile(), localProfile))) {
      lastProfileApplied = canon(profile);
      if (profile.updatedAt > 0) await chrome.storage.local.set({ [PROFILE_KEY]: profile });
      else await chrome.storage.local.remove(PROFILE_KEY);
    }
    otherAccount = false;
    meta = { userId, version, base: merged, profile };
    await chrome.storage.local.set({ [PERSONAL_KEY]: meta });
    if (applied) {
      lastApplied = canon(personalPart(await loadState()));
      return true;
    }
    // Edited while we were talking to the server: the next pass merges it.
  }
  throw new ApiError(409, "Another browser keeps saving at the same moment. Shelf will try again shortly.", "conflict");
}
