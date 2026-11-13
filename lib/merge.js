// Three-way merge of one shared space: what we last synced (`base`), what this
// browser has now (`local`) and what the server has now (`remote`).
// Pure functions, unit-tested in tests/merge.test.mjs.
//
// Rules, per shelf and per saved tab (matched by id):
// - A field keeps the side that changed it; if both changed it, this browser
//   wins (it is the one pushing next).
// - Added on either side: kept. Deleted on either side: deleted, even if the
//   other side edited it meanwhile.
// - A tab that moved keeps the move from the side that made it.
// - Order follows the side that reordered; items new to that order are
//   placed where the other side had them.

import { COLLECTION_COLORS, COLLECTION_LAYOUTS, LIMITS, SPACE_ICONS, isSavableUrl } from "./store.js";

const SPACE_FIELDS = ["name", "icon"];
// `collapsed` is left out: folding a shelf is a personal view setting that
// stays in each browser and is never shared.
const COLLECTION_FIELDS = ["name", "starred", "color", "layout"];
const LINK_FIELDS = ["kind", "title", "url", "body", "savedAt"];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function pick(b, l, r) {
  return same(l, b) ? r : l;
}

function mergeFields(fields, b, l, r) {
  const out = {};
  for (const f of fields) {
    const v = b && l && r ? pick(b[f], l[f], r[f]) : (l ?? r)[f];
    if (v !== undefined) out[f] = v;
  }
  return out;
}

// Which ids survive: present on both sides, or new on one side.
function survivors(baseIds, localIds, remoteIds) {
  const keep = new Set();
  for (const id of localIds) if (remoteIds.has(id) || !baseIds.has(id)) keep.add(id);
  for (const id of remoteIds) if (!baseIds.has(id)) keep.add(id);
  return keep;
}

function order(keep, baseOrder, localOrder, remoteOrder) {
  const inBase = new Set(baseOrder);
  const inLocal = new Set(localOrder);
  const localCommon = localOrder.filter((id) => inBase.has(id));
  const baseCommon = baseOrder.filter((id) => inLocal.has(id));
  const localMoved = !same(localCommon, baseCommon);
  const [lead, other] = localMoved ? [localOrder, remoteOrder] : [remoteOrder, localOrder];
  const result = lead.filter((id) => keep.has(id));
  const placed = new Set(result);
  for (const id of keep) {
    if (placed.has(id)) continue;
    const source = other.includes(id) ? other : lead;
    const i = source.indexOf(id);
    // Put it after the nearest earlier neighbour that is already placed.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = result.indexOf(source[j]);
      if (k !== -1) {
        at = k + 1;
        break;
      }
    }
    result.splice(at, 0, id);
    placed.add(id);
  }
  return result;
}

function index(space) {
  const cols = new Map();
  const links = new Map(); // id -> { link, parent }
  const linkOrder = new Map(); // collection id -> [link ids]
  for (const c of space?.collections ?? []) {
    cols.set(c.id, c);
    linkOrder.set(c.id, c.links.map((l) => l.id));
    for (const l of c.links) links.set(l.id, { link: l, parent: c.id });
  }
  return { cols, links, linkOrder, colOrder: [...cols.keys()] };
}

// Returns the merged space (without the local `id` / `shared` wrapper, which
// the caller keeps).
export function mergeSpace(base, local, remote) {
  if (!base) return structuredClone(remote ?? local);
  const B = index(base);
  const L = index(local);
  const R = index(remote);

  const keepCols = survivors(new Set(B.cols.keys()), new Set(L.cols.keys()), new Set(R.cols.keys()));
  const colOrder = order(keepCols, B.colOrder, L.colOrder, R.colOrder);

  const keepLinks = survivors(new Set(B.links.keys()), new Set(L.links.keys()), new Set(R.links.keys()));
  const parentOf = new Map();
  for (const id of keepLinks) {
    const b = B.links.get(id)?.parent;
    const l = L.links.get(id)?.parent;
    const r = R.links.get(id)?.parent;
    let parent = b !== undefined && l !== undefined && r !== undefined ? pick(b, l, r) : (l ?? r);
    if (!keepCols.has(parent)) parent = [l, r].find((p) => p !== undefined && keepCols.has(p));
    if (parent !== undefined) parentOf.set(id, parent);
  }

  const collections = colOrder.map((cid) => {
    const fields = mergeFields(COLLECTION_FIELDS, B.cols.get(cid), L.cols.get(cid), R.cols.get(cid));
    const mine = new Set([...parentOf].filter(([, p]) => p === cid).map(([id]) => id));
    const ids = order(mine, B.linkOrder.get(cid) ?? [], L.linkOrder.get(cid) ?? [], R.linkOrder.get(cid) ?? []);
    const links = ids.map((id) => {
      const merged = mergeFields(LINK_FIELDS, B.links.get(id)?.link, L.links.get(id)?.link, R.links.get(id)?.link);
      return { id, ...merged };
    });
    return { id: cid, ...fields, collapsed: L.cols.get(cid)?.collapsed ?? false, links };
  });

  return { ...mergeFields(SPACE_FIELDS, base, local, remote), collections };
}

// Content decrypted from the server was written by another person's
// browser, so it is untrusted input. Keep only what a valid Shelf space may
// hold: known fields, sane lengths, web/local-file addresses that pass
// isSavableUrl (no UNC shares, no javascript:), and ids that don't clash with
// ids elsewhere in this browser (`taken`). Anything else is dropped, so one
// bad item can never make the whole space unreadable.
export function sanitizeShared(raw, taken = new Set(), fallbackName = "Shared space") {
  const seen = new Set();
  const okId = (id) => typeof id === "string" && id.length > 0 && id.length <= LIMITS.id && !taken.has(id) && !seen.has(id) && seen.add(id);
  const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const name = text(raw?.name, LIMITS.name).trim() || fallbackName;
  const out = { name, collections: [] };
  if (SPACE_ICONS.includes(raw?.icon) && raw.icon !== "space") out.icon = raw.icon;
  for (const c of Array.isArray(raw?.collections) ? raw.collections.slice(0, LIMITS.collectionsPerSpace) : []) {
    if (!c || !okId(c.id)) continue;
    const col = { id: c.id, name: text(c.name, LIMITS.name).trim() || "Untitled", collapsed: false, starred: c.starred === true, links: [] };
    if (COLLECTION_COLORS.includes(c.color)) col.color = c.color;
    if (COLLECTION_LAYOUTS.includes(c.layout)) col.layout = c.layout;
    for (const l of Array.isArray(c.links) ? c.links.slice(0, LIMITS.linksPerCollection) : []) {
      if (!l || !okId(l.id)) continue;
      const savedAt = Number.isFinite(l.savedAt) ? l.savedAt : 0;
      if (l.kind === "note") {
        col.links.push({ id: l.id, kind: "note", title: text(l.title, LIMITS.title), body: text(l.body, LIMITS.note), savedAt });
      } else if (isSavableUrl(l.url)) {
        col.links.push({ id: l.id, title: text(l.title, LIMITS.title), url: l.url, savedAt });
      }
    }
    out.collections.push(col);
  }
  return out;
}

// The part of a local space that is encrypted and shared: content only, no
// local ids or sharing metadata.
export function shareableSpace(space) {
  const { name, icon, collections } = space;
  const out = { name, collections: collections.map((c) => ({ ...structuredClone(c), collapsed: false })) };
  if (icon !== undefined) out.icon = icon;
  return out;
}

// ------------------------------------------------------------ personal sync
// The same rules, one level up: a list of your own spaces (each with its id),
// as this browser last synced it (`base`), as it is here, and as the server
// has it. Without a base (this browser's first sync for the account) nothing
// is deleted: both sides' spaces, shelves and tabs are kept.

const EMPTY = { collections: [] };

export function mergeSpaces(base, local, remote) {
  const B = new Map((base ?? []).map((s) => [s.id, s]));
  const L = new Map(local.map((s) => [s.id, s]));
  const R = new Map(remote.map((s) => [s.id, s]));
  const keep = base
    ? survivors(new Set(B.keys()), new Set(L.keys()), new Set(R.keys()))
    : new Set([...R.keys(), ...L.keys()]);
  const ids = order(keep, [...B.keys()], [...L.keys()], [...R.keys()]);
  const merged = ids.map((id) => {
    const l = L.get(id);
    const r = R.get(id);
    if (!l || !r) return structuredClone(l ?? r);
    return { id, ...mergeSpace(B.get(id) ?? EMPTY, l, r) };
  });
  return dedupe(merged);
}

// A tab or shelf moved to different spaces on two browsers at once would
// otherwise appear twice; the first one wins.
function dedupe(spaces) {
  const seen = new Set();
  const fresh = (id) => !seen.has(id) && seen.add(id);
  return spaces
    .filter((s) => fresh(s.id))
    .map((s) => ({
      ...s,
      collections: s.collections
        .filter((c) => fresh(c.id))
        .map((c) => ({ ...c, links: c.links.filter((l) => fresh(l.id)) })),
    }));
}

// Synced data comes from the server, so it is checked like shared content.
// `taken` holds ids already used by shared spaces in this browser.
export function sanitizePersonal(raw, taken = new Set()) {
  const out = [];
  const used = new Set(taken);
  for (const s of Array.isArray(raw?.spaces) ? raw.spaces.slice(0, LIMITS.spaces) : []) {
    if (!s || typeof s.id !== "string" || !s.id || s.id.length > LIMITS.id || used.has(s.id)) continue;
    used.add(s.id);
    const space = { id: s.id, ...sanitizeShared(s, used, "Space") };
    for (const c of space.collections) {
      used.add(c.id);
      for (const l of c.links) used.add(l.id);
    }
    out.push(space);
  }
  return out;
}
