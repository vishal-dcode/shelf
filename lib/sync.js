// Keeps shared spaces in step with the server. Runs in the background worker
// (on a timer, after local edits, and when a page asks); the share dialog
// calls the exported actions directly.
//
// The server only ever sees ciphertext (lib/crypto.js). For each shared space
// we remember the last version we synced and its plaintext (`base`) under
// SYNC_KEY, so edits on both sides merge instead of overwriting each other
// (lib/merge.js).

import { activeSpace, getSpace, loadPlan, loadState, uid, update } from "./store.js";
import { api, ApiError } from "./api.js";
import { readAuth } from "./auth.js";
import { accountsConfigured, SYNC_KEY } from "./account.js";
import { decryptSpace, deviceKey, encryptSpace, generateSpaceKey, unwrapSpaceKey, wrapSpaceKey } from "./crypto.js";
import { mergeSpace, sanitizeShared, shareableSpace } from "./merge.js";
import { syncPersonal } from "./personal-sync.js";

export const SYNC_STATUS_KEY = "shelf:sync-status";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function readMeta() {
  return (await chrome.storage.local.get(SYNC_KEY))[SYNC_KEY] ?? {};
}

function writeMeta(meta) {
  return chrome.storage.local.set({ [SYNC_KEY]: meta });
}

const keyCache = new Map(); // `${id}:${keyVersion}` -> CryptoKey

async function spaceKeyFrom(detail, device) {
  const cacheKey = `${detail.id}:${detail.keyVersion}`;
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);
  const mine = detail.myWraps?.find((w) => w.keyId === device.keyId);
  if (!mine) return null; // nobody has wrapped the key for this browser yet
  const key = await unwrapSpaceKey(mine.wrapped, device.privateKey, {
    spaceId: detail.id,
    keyVersion: detail.keyVersion,
    keyId: device.keyId,
  });
  keyCache.set(cacheKey, key);
  return key;
}

async function wrapFor(spaceKey, spaceId, keyVersion, keys) {
  return Promise.all(
    keys.map(async (k) => ({
      userId: k.userId,
      keyId: k.keyId,
      wrapped: await wrapSpaceKey(spaceKey, k.publicKey, { spaceId, keyVersion, keyId: k.keyId }),
    })),
  );
}

// Writes the merged space into local state, unless the person edited it while
// we were talking to the server; then the next round merges that edit too.
async function applyLocal(sharedId, role, content, expected) {
  let applied = false;
  await update(
    (d) => {
      const space = d.spaces.find((s) => s.shared?.id === sharedId);
      if (space) {
        if (expected && !same(shareableSpace(space), expected)) return;
        const collapsed = new Map(space.collections.map((c) => [c.id, c.collapsed]));
        space.name = content.name;
        if (content.icon) space.icon = content.icon;
        else delete space.icon;
        space.collections = content.collections.map((c) => ({ ...c, collapsed: collapsed.get(c.id) ?? false }));
        space.shared = { id: sharedId, role };
      } else {
        d.spaces.push({ id: uid(), ...structuredClone(content), shared: { id: sharedId, role } });
      }
      applied = true;
    },
    { sync: true },
  );
  return applied;
}

async function syncOne(remote, meta, device, state, status) {
  const local = state.spaces.find((s) => s.shared?.id === remote.id);
  const m = meta[remote.id];
  const localNow = local ? shareableSpace(local) : null;
  const changedHere = Boolean(local && m && remote.role !== "view" && !same(localNow, m.base));
  const changedThere = !m || remote.version !== m.version || remote.keyVersion !== m.keyVersion;
  if (!local || changedHere || changedThere) {
    const detail = await api(`/v1/spaces/${encodeURIComponent(remote.id)}`);
    const spaceKey = await spaceKeyFrom(detail, device);
    if (!spaceKey) {
      status.waiting.push(remote.id);
      return;
    }
    // Ids used anywhere else in this browser; a shared item may not reuse one.
    const taken = new Set();
    for (const s of state.spaces) {
      if (s === local) continue;
      taken.add(s.id);
      for (const c of s.collections) {
        taken.add(c.id);
        for (const l of c.links) taken.add(l.id);
      }
    }
    if (local) taken.add(local.id);
    const theirs = sanitizeShared(
      await decryptSpace(spaceKey, detail, { spaceId: detail.id, keyVersion: detail.keyVersion }),
      taken,
    );
    // Without a synced base we can't tell whose edits are newer: the server
    // copy wins, so nobody else's work is overwritten.
    let merged = local && m ? mergeSpace(m.base, localNow, theirs) : theirs;
    let version = detail.version;
    if (remote.role !== "view" && !same(merged, theirs)) {
      const sealed = await encryptSpace(spaceKey, merged, { spaceId: detail.id, keyVersion: detail.keyVersion });
      try {
        ({ version } = await api(`/v1/spaces/${encodeURIComponent(remote.id)}`, {
          method: "PUT",
          body: { baseVersion: detail.version, keyVersion: detail.keyVersion, ...sealed },
        }));
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          status.retry = true; // someone saved first: merge with theirs next round
          return;
        }
        throw err;
      }
    }
    if (remote.role === "view") merged = theirs;
    const applied = await applyLocal(remote.id, remote.role, merged, localNow);
    meta[remote.id] = { version, keyVersion: detail.keyVersion, base: applied ? merged : (m?.base ?? merged) };
    if (!applied) status.retry = true;
    // Hand the space key to members' browsers that don't have it yet.
    if (remote.role !== "view" && detail.missingWraps?.length) {
      const wraps = await wrapFor(spaceKey, detail.id, detail.keyVersion, detail.missingWraps);
      await api(`/v1/spaces/${encodeURIComponent(remote.id)}/wraps`, {
        method: "POST",
        body: { keyVersion: detail.keyVersion, wraps },
      });
    }
  } else if (local.shared.role !== remote.role) {
    await applyLocal(remote.id, remote.role, localNow, localNow);
  }
}

// One full round. Safe to call often: rounds queue behind each other.
export function syncNow() {
  return navigator.locks.request("shelf-sync", async () => {
    if (!accountsConfigured()) return;
    const auth = await readAuth();
    if (!auth?.userId) return;
    const status = { lastSync: Date.now(), waiting: [], retry: false, error: null, account: "ok" };
    // Your own spaces first (lib/personal-sync.js), then shared ones.
    try {
      await syncPersonal(auth.userId);
    } catch (err) {
      if (err?.name === "SignedOutError") {
        await chrome.storage.local.set({ [SYNC_STATUS_KEY]: status });
        return status;
      }
      console.error("Shelf: account sync failed", err);
      status.account = err instanceof ApiError && err.code === "config" ? "off" : "error";
      status.error = err instanceof ApiError ? err.message : "Couldn't sync your spaces. Shelf will try again.";
    }
    try {
      const device = await deviceKey(auth.userId);
      const meta = await readMeta();
      const { spaces } = await api("/v1/spaces");
      const ids = new Set(spaces.map((s) => s.id));
      for (const remote of spaces) {
        try {
          await syncOne(remote, meta, device, await loadState(), status);
        } catch (err) {
          console.error("Shelf: sync failed for a space", err);
          status.error = err instanceof ApiError ? err.message : "Couldn't sync a shared space.";
        }
      }
      // No longer shared with you (stopped, or you were removed): keep what
      // you had as an ordinary local space.
      if ((await loadState()).spaces.some((s) => s.shared && !ids.has(s.shared.id))) {
        await update(
          (d) => {
            for (const s of d.spaces) if (s.shared && !ids.has(s.shared.id)) delete s.shared;
          },
          { sync: true },
        );
      }
      for (const id of Object.keys(meta)) if (!ids.has(id)) delete meta[id];
      await writeMeta(meta);
    } catch (err) {
      if (err?.name !== "SignedOutError") {
        console.error("Shelf: sync failed", err);
        status.error = err instanceof ApiError ? err.message : "Couldn't sync shared spaces.";
      }
    }
    await chrome.storage.local.set({ [SYNC_STATUS_KEY]: status });
    return status;
  });
}

// ---------------------------------------------------------------- actions

// Starts sharing one of your spaces. Pro only (the server checks too).
export async function shareSpace(spaceId) {
  return navigator.locks.request("shelf-sync", async () => {
    if ((await loadPlan()) !== "pro") throw new ApiError(402, "Sharing spaces is part of Shelf Pro.", "pro_required");
    const auth = await readAuth();
    const state = await loadState();
    const space = getSpace(state, spaceId);
    if (!space) throw new Error("Space not found");
    if (space.shared) return space.shared.id;
    const device = await deviceKey(auth.userId);
    const sharedId = crypto.randomUUID();
    const spaceKey = await generateSpaceKey();
    const content = shareableSpace(space);
    const sealed = await encryptSpace(spaceKey, content, { spaceId: sharedId, keyVersion: 1 });
    const wraps = await wrapFor(spaceKey, sharedId, 1, [{ userId: auth.userId, keyId: device.keyId, publicKey: device.publicJwk }]);
    const { version } = await api("/v1/spaces", { method: "POST", body: { id: sharedId, keyVersion: 1, ...sealed, wraps } });
    keyCache.set(`${sharedId}:1`, spaceKey);
    await update(
      (d) => {
        const s = getSpace(d, spaceId);
        if (s) s.shared = { id: sharedId, role: "owner" };
      },
      { sync: true },
    );
    const meta = await readMeta();
    meta[sharedId] = { version, keyVersion: 1, base: content };
    await writeMeta(meta);
    return sharedId;
  });
}

// A fresh space key for everyone still in the space, so someone who was
// removed can't read anything saved after they left.
export async function rotateSpaceKey(sharedId) {
  return navigator.locks.request("shelf-sync", async () => {
    const auth = await readAuth();
    const device = await deviceKey(auth.userId);
    const detail = await api(`/v1/spaces/${encodeURIComponent(sharedId)}`);
    const oldKey = await spaceKeyFrom(detail, device);
    if (!oldKey) throw new Error("This browser can't read the space yet.");
    const state = await loadState();
    const local = state.spaces.find((s) => s.shared?.id === sharedId);
    const content = local
      ? shareableSpace(local)
      : await decryptSpace(oldKey, detail, { spaceId: sharedId, keyVersion: detail.keyVersion });
    const keyVersion = detail.keyVersion + 1;
    const spaceKey = await generateSpaceKey();
    const sealed = await encryptSpace(spaceKey, content, { spaceId: sharedId, keyVersion });
    const wraps = await wrapFor(spaceKey, sharedId, keyVersion, detail.deviceKeys ?? []);
    const { version } = await api(`/v1/spaces/${encodeURIComponent(sharedId)}`, {
      method: "PUT",
      body: { baseVersion: detail.version, keyVersion, ...sealed, wraps },
    });
    keyCache.set(`${sharedId}:${keyVersion}`, spaceKey);
    const meta = await readMeta();
    meta[sharedId] = { version, keyVersion, base: content };
    await writeMeta(meta);
  });
}

export async function stopSharing(sharedId) {
  await api(`/v1/spaces/${encodeURIComponent(sharedId)}`, { method: "DELETE" });
  await forget(sharedId, { keepCopy: true });
}

export async function leaveSpace(sharedId, memberId) {
  await api(`/v1/spaces/${encodeURIComponent(sharedId)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
  await forget(sharedId, { keepCopy: false });
}

async function forget(sharedId, { keepCopy }) {
  await navigator.locks.request("shelf-sync", async () => {
    await update(
      (d) => {
        const i = d.spaces.findIndex((s) => s.shared?.id === sharedId);
        if (i === -1) return;
        if (keepCopy || d.spaces.length === 1) {
          delete d.spaces[i].shared;
        } else {
          const [gone] = d.spaces.splice(i, 1);
          if (d.activeSpaceId === gone.id) d.activeSpaceId = d.spaces[Math.max(0, i - 1)].id;
        }
      },
      { sync: true },
    );
    const meta = await readMeta();
    delete meta[sharedId];
    await writeMeta(meta);
  });
}

export function sharedInfo(state) {
  const space = activeSpace(state);
  return space?.shared ?? null;
}
