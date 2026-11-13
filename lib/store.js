// Shelf data layer. Shared by the background worker and the side panel.
//
// Shape (stored under STATE_KEY in chrome.storage.local):
//   { version, activeSpaceId, spaces: [{ id, name, icon?, collections: [
//       { id, name, collapsed, starred?, links: [ Tab | Note ] } ] }] }
//   Tab:  { id, title, url, savedAt }
//   Note: { id, kind: "note", title, body, savedAt }   (no url)
//   space.shared (optional): { id, role: "owner" | "edit" | "view" } marks a
//   space that is mirrored, end-to-end encrypted, to the Shelf server
//   (lib/sync.js). Everything else about it is an ordinary local space.
// `starred` and notes were added after v1 shipped, so both are optional and
// older data stays valid without a version bump.
//
// Mutators take a draft (already cloned by `update`) and change it in place.
// They never touch chrome.* so they can be unit-tested in Node.

import { CONFIG } from "./config.js";
import { readAuth } from "./auth.js";

export const STATE_KEY = "shelf:state";
// Written by lib/account.js after the server confirms the plan. Read inside
// every update so the caps hold for every page and the right-click menu.
export const PLAN_KEY = "shelf:plan";
export const VERSION = 1;

export const LIMITS = {
  name: 80,
  title: 300,
  url: 2048,
  note: 10000,
  id: 64,
  spaces: 100,
  collectionsPerSpace: 500,
  linksPerCollection: 5000,
};

// The free plan's caps. Spaces someone else shared with you don't count, and
// neither do their shelves. Pro has no caps beyond LIMITS.
export const FREE_LIMITS = { spaces: 3, collections: 20 };

export class PlanLimitError extends Error {
  constructor(kind) {
    super(
      kind === "spaces"
        ? `This open-source build holds ${FREE_LIMITS.spaces} spaces. Get Shelf from the Chrome Web Store or Firefox Add-ons for unlimited spaces`
        : !CONFIG.plansEnabled
        ? kind === "spaces"
          ? `Without an account Shelf holds ${FREE_LIMITS.spaces} spaces. Sign in from the account menu for unlimited spaces`
          : `Without an account Shelf holds ${FREE_LIMITS.collections} shelves. Sign in from the account menu for unlimited shelves`
        : kind === "spaces"
          ? `The free plan holds ${FREE_LIMITS.spaces} spaces. Upgrade to Shelf Pro from the account menu for more`
          : `The free plan holds ${FREE_LIMITS.collections} shelves. Upgrade to Shelf Pro from the account menu for more`,
    );
    this.name = "PlanLimitError";
    this.kind = kind;
  }
}

export class ReadOnlyError extends Error {
  constructor(message = "This space is view-only") {
    super(message);
    this.name = "ReadOnlyError";
  }
}

const SHARE_ROLES = ["owner", "edit", "view"];

// Spaces and shelves that count toward the free plan: yours, shared or not.
export function planUsage(state) {
  const own = state.spaces.filter((s) => !s.shared || s.shared.role === "owner");
  return {
    spaces: own.length,
    collections: own.reduce((n, s) => n + s.collections.length, 0),
  };
}

// Over-cap data is kept; it just can't grow. Returns "spaces", "collections"
// or null.
export function planBreach(before, after, plan) {
  const a = planUsage(before);
  const b = planUsage(after);
  // The open-source build holds 3 spaces on every plan.
  if (b.spaces > a.spaces && b.spaces > FREE_LIMITS.spaces) return "spaces";
  if (plan === "pro") return null;
  if (b.collections > a.collections && b.collections > FREE_LIMITS.collections) return "collections";
  return null;
}

export function canAdd(state, plan, kind) {
  if (kind === "spaces") return planUsage(state).spaces < FREE_LIMITS.spaces;
  if (plan === "pro") return true;
  return planUsage(state)[kind] < FREE_LIMITS[kind];
}

// What a view-only space looks like for comparison: folding a shelf open or
// shut is a personal view setting, so it stays allowed.
function viewShape(space) {
  return JSON.stringify({ ...space, collections: space.collections.map((c) => ({ ...c, collapsed: false })) });
}

// Ordinary edits may not change a view-only space, or drop any shared space
// (that goes through Leave / Stop sharing, which run as sync updates).
export function sharedViolation(before, after) {
  for (const space of before.spaces) {
    if (!space.shared) continue;
    const next = after.spaces.find((s) => s.id === space.id);
    if (!next || next.shared?.id !== space.shared.id || next.shared.role !== space.shared.role) {
      return "Stop sharing or leave this space first";
    }
    if (space.shared.role === "view" && viewShape(space) !== viewShape(next)) return "This space is view-only";
  }
  for (const space of after.spaces) {
    if (space.shared && !before.spaces.some((s) => s.id === space.id && s.shared)) return "Use Share to share a space";
  }
  return null;
}

// Only ordinary web pages and local files are saved or reopened.
// This keeps `javascript:`, `data:` and browser-internal URLs out of storage.
const SAVABLE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

function parseUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > LIMITS.url) return null;
  try {
    const parsed = new URL(url);
    return SAVABLE_PROTOCOLS.has(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

// What may be saved or opened. A file: URL must be a file on this computer:
// file://server/share/... would have the OS reach out to a network share.
// Shelf's own tabs: its pages by their extension address, plus new tabs,
// which Shelf replaces but browsers report as their own new-tab address.
const NEW_TAB_URLS = new Set(["chrome://newtab/", "chrome://new-tab-page/", "edge://newtab/", "about:newtab", "about:home"]);
export function isShelfTab(tab, ownOrigin) {
  const url = tab.url || tab.pendingUrl || "";
  return url.startsWith(ownOrigin) || NEW_TAB_URLS.has(url);
}

export function isSavableUrl(url) {
  const parsed = parseUrl(url);
  return parsed !== null && (parsed.protocol !== "file:" || parsed.host === "");
}

// What may already be in storage. Looser than isSavableUrl so a link saved by
// an older version never makes the whole state unreadable; it just can't open.
function isStoredUrl(url) {
  return parseUrl(url) !== null;
}

// Turns what someone typed into a savable URL, or null. Bare domains like
// "example.com/page" get https:// added.
export function normalizeUrlInput(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (isSavableUrl(raw)) return new URL(raw).href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:/]+:\d/.test(raw)) return null; // other scheme
  const guess = `https://${raw}`;
  try {
    const url = new URL(guess);
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return isSavableUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

export function uid() {
  return crypto.randomUUID();
}

export function cleanText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function createDefaultState() {
  const spaceId = uid();
  return {
    version: VERSION,
    activeSpaceId: spaceId,
    spaces: [{ id: spaceId, name: "Personal", collections: [] }],
  };
}

// ---------------------------------------------------------------------------
// Validation. Used on load, after every update, and on import.

// Icons a space can wear. The drawings live in lib/ui.js; only the names are
// stored, so an imported file can never carry markup.
export const SPACE_ICONS = [
  "space", "home", "briefcase", "book", "code", "heart", "globe", "music",
  "camera", "cart", "game", "plane", "school", "bolt", "flask", "palette",
];

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= LIMITS.id;
const isName = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= LIMITS.name;

export function validateState(raw) {
  const fail = (error) => ({ ok: false, error });
  if (!raw || typeof raw !== "object") return fail("not an object");
  if (raw.version !== VERSION) return fail("unknown version");
  if (!Array.isArray(raw.spaces) || raw.spaces.length < 1 || raw.spaces.length > LIMITS.spaces) {
    return fail("spaces must be a list of 1 to 100");
  }
  const seen = new Set();
  const claim = (id) => {
    if (!isId(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  };
  for (const space of raw.spaces) {
    if (!space || !claim(space.id) || !isName(space.name)) return fail("bad space");
    if (space.icon !== undefined && !SPACE_ICONS.includes(space.icon)) return fail("bad space icon");
    if (
      space.shared !== undefined &&
      !(space.shared && isId(space.shared.id) && SHARE_ROLES.includes(space.shared.role) && Object.keys(space.shared).length === 2)
    ) {
      return fail("bad shared space");
    }
    if (!Array.isArray(space.collections) || space.collections.length > LIMITS.collectionsPerSpace) {
      return fail(`bad collections in space "${space.name}"`);
    }
    for (const col of space.collections) {
      if (
        !col ||
        !claim(col.id) ||
        !isName(col.name) ||
        typeof col.collapsed !== "boolean" ||
        (col.starred !== undefined && typeof col.starred !== "boolean") ||
        (col.color !== undefined && !COLLECTION_COLORS.includes(col.color)) ||
        (col.layout !== undefined && !COLLECTION_LAYOUTS.includes(col.layout))
      ) {
        return fail("bad collection");
      }
      if (!Array.isArray(col.links) || col.links.length > LIMITS.linksPerCollection) {
        return fail(`bad links in collection "${col.name}"`);
      }
      for (const link of col.links) {
        const common =
          link && claim(link.id) && typeof link.title === "string" && link.title.length <= LIMITS.title && Number.isFinite(link.savedAt);
        const valid =
          link?.kind === "note"
            ? common && link.url === undefined && typeof link.body === "string" && link.body.length <= LIMITS.note
            : common && link.kind === undefined && isStoredUrl(link.url);
        if (!valid) return fail("bad saved tab");
      }
    }
  }
  if (!raw.spaces.some((s) => s.id === raw.activeSpaceId)) return fail("active space missing");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Lookups

export function getSpace(state, spaceId) {
  return state.spaces.find((s) => s.id === spaceId) ?? null;
}

export function activeSpace(state) {
  return getSpace(state, state.activeSpaceId) ?? state.spaces[0];
}

export function findCollection(state, collectionId) {
  for (const space of state.spaces) {
    const collection = space.collections.find((c) => c.id === collectionId);
    if (collection) return { space, collection };
  }
  return null;
}

export function findLink(state, linkId) {
  for (const space of state.spaces) {
    for (const collection of space.collections) {
      const index = collection.links.findIndex((l) => l.id === linkId);
      if (index !== -1) return { space, collection, link: collection.links[index], index };
    }
  }
  return null;
}

export function countLinks(space) {
  return space.collections.reduce((n, c) => n + c.links.length, 0);
}

// ---------------------------------------------------------------------------
// Mutators (operate on a draft)

function requireName(name) {
  const clean = cleanText(name, LIMITS.name);
  if (!clean) throw new Error("Name can't be empty");
  return clean;
}

function clampIndex(index, length) {
  if (!Number.isInteger(index) || index < 0 || index > length) return length;
  return index;
}

export function addSpace(d, name) {
  if (planUsage(d).spaces >= FREE_LIMITS.spaces) throw new PlanLimitError("spaces");
  const id = uid();
  d.spaces.push({ id, name: requireName(name), collections: [] });
  d.activeSpaceId = id;
  return id;
}

// Adds a space from a single-space export. Every id is regenerated so it can
// never collide with what's already here, and a clashing name gets " (2)".
export function addImportedSpace(d, space) {
  if (planUsage(d).spaces >= FREE_LIMITS.spaces) throw new PlanLimitError("spaces");
  const names = new Set(d.spaces.map((s) => s.name));
  let name = space.name;
  for (let n = 2; names.has(name); n++) name = `${space.name.slice(0, LIMITS.name - 5)} (${n})`;
  const copy = structuredClone(space);
  delete copy.shared; // an imported copy is a plain local space
  copy.id = uid();
  copy.name = name;
  for (const col of copy.collections) {
    col.id = uid();
    for (const link of col.links) link.id = uid();
  }
  d.spaces.push(copy);
  d.activeSpaceId = copy.id;
  return copy.id;
}

export function renameSpace(d, spaceId, name) {
  const space = getSpace(d, spaceId);
  if (!space) throw new Error("Space not found");
  space.name = requireName(name);
}

export function setSpaceIcon(d, spaceId, icon) {
  const space = getSpace(d, spaceId);
  if (!space) throw new Error("Space not found");
  if (icon == null || icon === "space") delete space.icon;
  else if (SPACE_ICONS.includes(icon)) space.icon = icon;
  else throw new Error("Unknown icon");
}

export function deleteSpace(d, spaceId) {
  if (d.spaces.length <= 1) throw new Error("Keep at least one space");
  const index = d.spaces.findIndex((s) => s.id === spaceId);
  if (index === -1) throw new Error("Space not found");
  d.spaces.splice(index, 1);
  if (d.activeSpaceId === spaceId) d.activeSpaceId = d.spaces[Math.max(0, index - 1)].id;
}

// Reorders the sidebar: the space lands at `toIndex` in the current order.
export function moveSpace(d, spaceId, toIndex) {
  const from = d.spaces.findIndex((s) => s.id === spaceId);
  if (from === -1) throw new Error("Space not found");
  let index = clampIndex(toIndex, d.spaces.length);
  const [space] = d.spaces.splice(from, 1);
  if (from < index) index -= 1;
  d.spaces.splice(index, 0, space);
}

export function setActiveSpace(d, spaceId) {
  if (!getSpace(d, spaceId)) throw new Error("Space not found");
  d.activeSpaceId = spaceId;
}

export function addCollection(d, spaceId, name, index) {
  const space = getSpace(d, spaceId);
  if (!space) throw new Error("Space not found");
  if (space.collections.length >= LIMITS.collectionsPerSpace) throw new Error("Collection limit reached");
  const id = uid();
  const collection = { id, name: requireName(name), collapsed: false, starred: false, links: [] };
  space.collections.splice(clampIndex(index, space.collections.length), 0, collection);
  return id;
}

export function renameCollection(d, collectionId, name) {
  const found = findCollection(d, collectionId);
  if (!found) throw new Error("Collection not found");
  found.collection.name = requireName(name);
}

export function deleteCollection(d, collectionId) {
  const found = findCollection(d, collectionId);
  if (!found) throw new Error("Collection not found");
  found.space.collections = found.space.collections.filter((c) => c.id !== collectionId);
  return found.collection.links.length;
}

export function setCollapsed(d, collectionId, collapsed) {
  const found = findCollection(d, collectionId);
  if (!found) throw new Error("Collection not found");
  found.collection.collapsed = Boolean(collapsed);
}

// Background tints a collection can have (missing = default, no tint).
export const COLLECTION_COLORS = ["grey", "red", "orange", "yellow", "green", "teal", "blue", "purple"];

export function setCollectionColor(d, collectionId, color) {
  const found = findCollection(d, collectionId);
  if (!found) throw new Error("Collection not found");
  if (color == null || color === "default") delete found.collection.color;
  else if (COLLECTION_COLORS.includes(color)) found.collection.color = color;
  else throw new Error("Unknown colour");
}

// How a collection lays out its own cards (missing = follow the board).
export const COLLECTION_LAYOUTS = ["list", "two", "three", "free"];

export function setCollectionLayout(d, collectionId, layout) {
  const found = findCollection(d, collectionId);
  if (!found) throw new Error("Collection not found");
  if (layout == null || layout === "default") delete found.collection.layout;
  else if (COLLECTION_LAYOUTS.includes(layout)) found.collection.layout = layout;
  else throw new Error("Unknown layout");
}

// Puts every collection back on the board's layout. Returns how many changed.
export function clearCollectionLayouts(d) {
  let changed = 0;
  for (const space of d.spaces) {
    for (const col of space.collections) {
      if ("layout" in col) {
        delete col.layout;
        changed++;
      }
    }
  }
  return changed;
}

// Moves a collection within its own space. `toIndex` is the position in the
// list as it looks *before* the move (same convention as moveLink).
export function moveCollection(d, collectionId, toIndex) {
  const found = findCollection(d, collectionId);
  if (!found) throw new Error("Collection not found");
  const list = found.space.collections;
  const from = list.findIndex((c) => c.id === collectionId);
  let index = clampIndex(toIndex, list.length);
  list.splice(from, 1);
  if (from < index) index -= 1;
  list.splice(index, 0, found.collection);
}

export function setStarred(d, collectionId, starred) {
  const found = findCollection(d, collectionId);
  if (!found) throw new Error("Collection not found");
  found.collection.starred = Boolean(starred);
}

// Moves a collection to the top of another space.
export function moveCollectionToSpace(d, collectionId, spaceId) {
  const found = findCollection(d, collectionId);
  const target = getSpace(d, spaceId);
  if (!found || !target) throw new Error("Collection or space not found");
  if (found.space.id === spaceId) return;
  if (target.collections.length >= LIMITS.collectionsPerSpace) throw new Error("Collection limit reached");
  found.space.collections = found.space.collections.filter((c) => c.id !== collectionId);
  target.collections.unshift(found.collection);
}

// Every starred collection across all spaces, in space order.
export function starredCollections(state) {
  return state.spaces.flatMap((space) =>
    space.collections.filter((c) => c.starred).map((collection) => ({ space, collection })),
  );
}

// Adds pages to a collection. Skips unsavable URLs and URLs already in that
// collection. Returns how many were added.
export function addLinks(d, collectionId, items, index) {
  const found = findCollection(d, collectionId);
  if (!found) throw new Error("Collection not found");
  const { collection } = found;
  const existing = new Set(collection.links.map((l) => l.url));
  const now = Date.now();
  const fresh = [];
  for (const item of items) {
    const url = item?.url;
    if (!isSavableUrl(url) || existing.has(url)) continue;
    existing.add(url);
    fresh.push({ id: uid(), title: cleanText(item.title, LIMITS.title) || url, url, savedAt: now });
  }
  const room = LIMITS.linksPerCollection - collection.links.length;
  if (fresh.length > room) throw new Error("This collection is full");
  collection.links.splice(clampIndex(index, collection.links.length), 0, ...fresh);
  return fresh.length;
}

export function isNote(link) {
  return link?.kind === "note";
}

// Notes keep line breaks; only trailing space and length are trimmed.
function cleanBody(body) {
  return String(body ?? "").replace(/\r\n?/g, "\n").trimEnd().slice(0, LIMITS.note);
}

// Adds a note card. Returns its id.
export function addNote(d, collectionId, { title, body }, index) {
  const found = findCollection(d, collectionId);
  if (!found) throw new Error("Collection not found");
  const { collection } = found;
  if (collection.links.length >= LIMITS.linksPerCollection) throw new Error("This collection is full");
  const id = uid();
  const note = { id, kind: "note", title: requireTitle(title), body: cleanBody(body), savedAt: Date.now() };
  collection.links.splice(clampIndex(index, collection.links.length), 0, note);
  return id;
}

// Renames a saved tab or note (its address and text are unchanged).
export function renameLink(d, linkId, title) {
  const found = findLink(d, linkId);
  if (!found) throw new Error("Saved tab not found");
  found.link.title = requireTitle(title);
}

// Edits a saved tab: title and address. `url` must already be normalised.
export function updateLink(d, linkId, { title, url }) {
  const found = findLink(d, linkId);
  if (!found || isNote(found.link)) throw new Error("Saved tab not found");
  if (!isSavableUrl(url)) throw new Error("Not a web address");
  found.link.title = requireTitle(title);
  found.link.url = url;
}

export function updateNote(d, linkId, { title, body }) {
  const found = findLink(d, linkId);
  if (!found || !isNote(found.link)) throw new Error("Note not found");
  found.link.title = requireTitle(title);
  found.link.body = cleanBody(body);
}

function requireTitle(title) {
  const clean = cleanText(title, LIMITS.title);
  if (!clean) throw new Error("Title can't be empty");
  return clean;
}

export function removeLink(d, linkId) {
  const found = findLink(d, linkId);
  if (!found) throw new Error("Saved tab not found");
  found.collection.links.splice(found.index, 1);
  return found.link;
}

// Moves a saved tab to `toIndex` in the target collection. `toIndex` is the
// position in the target list as it looks *before* the move.
export function moveLink(d, linkId, toCollectionId, toIndex) {
  const from = findLink(d, linkId);
  const to = findCollection(d, toCollectionId);
  if (!from || !to) throw new Error("Saved tab or collection not found");
  const same = from.collection.id === toCollectionId;
  if (!same && from.link.url && to.collection.links.some((l) => l.url === from.link.url)) {
    // Already saved there; moving just removes the duplicate source.
    from.collection.links.splice(from.index, 1);
    return;
  }
  if (!same && to.collection.links.length >= LIMITS.linksPerCollection) {
    throw new Error("This collection is full");
  }
  let index = clampIndex(toIndex, to.collection.links.length);
  from.collection.links.splice(from.index, 1);
  if (same && from.index < index) index -= 1;
  to.collection.links.splice(index, 0, from.link);
}

// Returns the id of the space's "Unsorted" collection, creating it if needed.
export function ensureUnsorted(d, spaceId) {
  const space = getSpace(d, spaceId);
  if (!space) throw new Error("Space not found");
  const existing = space.collections.find((c) => c.name === "Unsorted");
  return existing ? existing.id : addCollection(d, spaceId, "Unsorted");
}

// ---------------------------------------------------------------------------
// Storage I/O (extension contexts only)

export async function loadState() {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  if (stored === undefined) return createDefaultState();
  if (validateState(stored).ok) return stored;
  // Never silently overwrite data we can't read: park it under a backup key,
  // once. Every page load reads the state, so check for an identical copy.
  const all = await chrome.storage.local.get(null);
  const copy = JSON.stringify(stored);
  const parked = Object.keys(all).some((key) => key.startsWith(`${STATE_KEY}:unreadable-`) && JSON.stringify(all[key]) === copy);
  if (!parked) await chrome.storage.local.set({ [`${STATE_KEY}:unreadable-${Date.now()}`]: stored });
  return createDefaultState();
}

// The plan this browser last confirmed with the server. Anything missing,
// malformed or past its expiry counts as free.
export async function loadPlan() {
  // Launch period: no plans. Signed in means no caps; signed out keeps the
  // free caps (FREE_LIMITS) as the reason to make an account.
  if (!CONFIG.plansEnabled) return (await readAuth()) ? "pro" : "free";
  const stored = (await chrome.storage.local.get(PLAN_KEY))[PLAN_KEY];
  if (!stored || stored.plan !== "pro" || !Number.isFinite(stored.until) || stored.until < Date.now()) return "free";
  return "pro";
}

// Read-modify-write under a lock shared by every extension context, so the
// side panel and the context menu can't overwrite each other's changes.
// Every ordinary edit is checked against the plan caps and shared-space
// roles here, once, whichever page or menu made it. `sync: true` is for
// lib/sync.js applying the server's copy of shared spaces.
export function update(mutator, { sync = false } = {}) {
  return navigator.locks.request("shelf-state", async () => {
    const before = await loadState();
    const draft = structuredClone(before);
    const result = mutator(draft);
    const check = validateState(draft);
    if (!check.ok) throw new Error(`Refusing to save invalid data: ${check.error}`);
    if (!sync) {
      const shared = sharedViolation(before, draft);
      if (shared) throw new ReadOnlyError(shared);
      const breach = planBreach(before, draft, await loadPlan());
      if (breach) throw new PlanLimitError(breach);
    }
    await chrome.storage.local.set({ [STATE_KEY]: draft });
    return { state: draft, result };
  });
}

export async function replaceState(next) {
  const check = validateState(next);
  if (!check.ok) throw new Error(check.error);
  return navigator.locks.request("shelf-state", () => chrome.storage.local.set({ [STATE_KEY]: next }));
}
