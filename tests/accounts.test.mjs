// Plan caps, view-only shared spaces, the shared-space merge and the
// end-to-end encryption round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FREE_LIMITS,
  addCollection,
  addImportedSpace,
  addSpace,
  canAdd,
  createDefaultState,
  planBreach,
  planUsage,
  renameCollection,
  setCollapsed,
  sharedViolation,
  validateState,
} from "../lib/store.js";
import { mergeSpace, sanitizeShared, shareableSpace } from "../lib/merge.js";
import {
  decryptSpace,
  encryptSpace,
  generateDeviceKey,
  generateSpaceKey,
  unwrapSpaceKey,
  wrapSpaceKey,
} from "../lib/crypto.js";

const clone = structuredClone;

test("free plan: 3 spaces and 20 shelves; over-cap data is kept but can't grow", () => {
  const s = createDefaultState();
  addSpace(s, "Two");
  addSpace(s, "Three");
  assert.equal(canAdd(s, "free", "spaces"), false);
  // Open-source build: 3 spaces on every plan; over-cap data can still shrink.
  assert.equal(canAdd(s, "pro", "spaces"), false);
  assert.throws(() => addSpace(clone(s), "Four"), (e) => e.name === "PlanLimitError");
  const more = clone(s);
  more.spaces.push({ id: "x4", name: "Four", collections: [] });
  assert.equal(planBreach(s, more, "free"), "spaces");
  assert.equal(planBreach(s, more, "pro"), "spaces");
  const fewer = clone(more);
  fewer.spaces.pop();
  assert.equal(planBreach(more, fewer, "free"), null);

  for (let i = 0; i < FREE_LIMITS.collections; i++) addCollection(s, s.activeSpaceId, `Shelf ${i}`);
  const extra = clone(s);
  addCollection(extra, extra.activeSpaceId, "One too many");
  assert.equal(planBreach(s, extra, "free"), "collections");
});

test("spaces shared with you don't count toward the free plan", () => {
  const s = createDefaultState();
  s.spaces.push({ id: "x1", name: "Team", shared: { id: "s1", role: "edit" }, collections: [] });
  s.spaces.push({ id: "x2", name: "Mine shared", shared: { id: "s2", role: "owner" }, collections: [] });
  assert.equal(validateState(s).ok, true);
  assert.deepEqual(planUsage(s), { spaces: 2, collections: 0 });
  const before = clone(s);
  for (let i = 0; i < 25; i++) addCollection(s, "x1", `Team shelf ${i}`);
  assert.equal(planBreach(before, s, "free"), null);
});

test("shared markers are validated and stripped from imported copies", () => {
  const s = createDefaultState();
  s.spaces[0].shared = { id: "s1", role: "admin" };
  assert.equal(validateState(s).ok, false);
  s.spaces[0].shared = { id: "s1", role: "view", extra: 1 };
  assert.equal(validateState(s).ok, false);
  const d = createDefaultState();
  addImportedSpace(d, { id: "z", name: "Copy", shared: { id: "s1", role: "view" }, collections: [] });
  assert.equal(d.spaces[1].shared, undefined);
});

test("view-only spaces can be folded but not edited, and shared spaces can't be dropped", () => {
  const s = createDefaultState();
  s.spaces.push({ id: "v", name: "Theirs", shared: { id: "s1", role: "view" }, collections: [] });
  const col = addCollection(s, "v", "Links");
  const folded = clone(s);
  setCollapsed(folded, col, true);
  assert.equal(sharedViolation(s, folded), null);
  const renamed = clone(s);
  renameCollection(renamed, col, "Mine now");
  assert.equal(sharedViolation(s, renamed), "This space is view-only");
  const dropped = clone(s);
  dropped.spaces.pop();
  assert.match(sharedViolation(s, dropped), /leave/);
  const forged = clone(s);
  forged.spaces[0].shared = { id: "s9", role: "owner" };
  assert.match(sharedViolation(s, forged), /Share/);
});

// ---------------------------------------------------------------- merge

function space(collections) {
  return { name: "Team", collections };
}
const col = (id, links, extra = {}) => ({ id, name: id, collapsed: false, links, ...extra });
const link = (id, title = id) => ({ id, title, url: `https://${id}.example/`, savedAt: 1 });
const ids = (s) => s.collections.map((c) => [c.id, c.links.map((l) => l.id)]);

test("merge keeps both sides' additions and deletions", () => {
  const base = space([col("a", [link("1"), link("2")]), col("b", [])]);
  const local = space([col("a", [link("1"), link("2"), link("3")]), col("b", [])]); // added 3
  const remote = space([col("a", [link("2")]), col("b", [link("4")]), col("c", [])]); // removed 1, added 4 and c
  assert.deepEqual(ids(mergeSpace(base, local, remote)), [
    ["a", ["2", "3"]],
    ["b", ["4"]],
    ["c", []],
  ]);
});

test("merge takes each changed field from the side that changed it", () => {
  const base = space([col("a", [link("1", "Old")], { color: "red" })]);
  const local = space([col("a", [link("1", "New title")], { color: "red" })]);
  const remote = space([col("a", [link("1", "Old")], { color: "blue" })]);
  remote.name = "Renamed";
  const merged = mergeSpace(base, local, remote);
  assert.equal(merged.name, "Renamed");
  assert.equal(merged.collections[0].color, "blue");
  assert.equal(merged.collections[0].links[0].title, "New title");
});

test("merge follows a move and a reorder", () => {
  const base = space([col("a", [link("1"), link("2"), link("3")]), col("b", [])]);
  const local = space([col("a", [link("3"), link("1"), link("2")]), col("b", [])]); // reordered
  const remote = space([col("a", [link("1"), link("3")]), col("b", [link("2")])]); // moved 2 to b
  assert.deepEqual(ids(mergeSpace(base, local, remote)), [
    ["a", ["3", "1"]],
    ["b", ["2"]],
  ]);
});

test("merge drops tabs whose shelf was deleted elsewhere, and keeps folding local", () => {
  const base = space([col("a", [link("1")]), col("b", [])]);
  const local = space([col("a", [link("1")], { collapsed: true }), col("b", [link("9")])]);
  const remote = space([col("a", [link("1")])]);
  const merged = mergeSpace(base, local, remote);
  assert.deepEqual(ids(merged), [["a", ["1"]]]);
  assert.equal(merged.collections[0].collapsed, true);
  assert.equal(shareableSpace({ ...local, id: "x", shared: { id: "s", role: "edit" } }).collections[0].collapsed, false);
});

test("merge result is valid Shelf data", () => {
  const base = space([col("a", [link("1")])]);
  const merged = mergeSpace(base, space([col("a", [link("1"), link("2")])]), space([col("z", [])]));
  const state = { version: 1, activeSpaceId: "s", spaces: [{ id: "s", ...merged }] };
  assert.equal(validateState(state).ok, true);
});

test("content from other members is cleaned before it touches local data", () => {
  const hostile = {
    name: "x".repeat(500),
    icon: "<img>",
    extra: "dropped",
    collections: [
      {
        id: "c1",
        name: "Links",
        color: "url(evil)",
        collapsed: true,
        links: [
          { id: "ok", title: "Fine", url: "https://fine.example/", savedAt: 1 },
          { id: "js", title: "XSS", url: "javascript:alert(1)", savedAt: 1 },
          { id: "unc", title: "Share", url: "file://attacker/share", savedAt: 1 },
          { id: "ok", title: "Duplicate id", url: "https://dup.example/", savedAt: 1 },
          { id: "mine", title: "Clashes with my own data", url: "https://a.example/", savedAt: 1 },
          { id: "n1", kind: "note", title: "Note", body: "b".repeat(20000), url: "https://x.example/" },
        ],
      },
      { id: "mine", name: "Clashing shelf", links: [] },
      "not an object",
    ],
  };
  const clean = sanitizeShared(hostile, new Set(["mine"]));
  assert.equal(clean.name.length, 80);
  assert.equal(clean.icon, undefined);
  assert.equal(clean.extra, undefined);
  assert.deepEqual(ids(clean), [["c1", ["ok", "n1"]]]);
  assert.equal(clean.collections[0].color, undefined);
  assert.equal(clean.collections[0].links[1].body.length, 10000);
  assert.equal(clean.collections[0].links[1].url, undefined);
  const state = { version: 1, activeSpaceId: "s", spaces: [{ id: "s", ...clean }] };
  assert.equal(validateState(state).ok, true);
  assert.deepEqual(sanitizeShared(null), { name: "Shared space", collections: [] });
});

// --------------------------------------------------------------- crypto

test("a space key wrapped for one device opens only there, only for that space", async () => {
  const alice = await generateDeviceKey();
  const bob = await generateDeviceKey();
  const spaceKey = await generateSpaceKey();
  const ctx = { spaceId: "s1", keyVersion: 1, keyId: alice.keyId };
  const wrapped = await wrapSpaceKey(spaceKey, alice.publicJwk, ctx);
  assert.ok(!wrapped.includes("Personal"));
  const opened = await unwrapSpaceKey(wrapped, alice.privateKey, ctx);
  await assert.rejects(unwrapSpaceKey(wrapped, bob.privateKey, ctx));
  await assert.rejects(unwrapSpaceKey(wrapped, alice.privateKey, { ...ctx, spaceId: "s2" }));
  await assert.rejects(unwrapSpaceKey(wrapped, alice.privateKey, { ...ctx, keyVersion: 2 }));

  const content = space([col("a", [link("secret", "Bank statement")])]);
  const sealed = await encryptSpace(spaceKey, content, { spaceId: "s1", keyVersion: 1 });
  assert.ok(!sealed.ciphertext.includes("Bank"));
  assert.deepEqual(await decryptSpace(opened, sealed, { spaceId: "s1", keyVersion: 1 }), content);
  await assert.rejects(decryptSpace(opened, sealed, { spaceId: "other", keyVersion: 1 }));
  const tampered = { ...sealed, ciphertext: sealed.ciphertext.slice(0, -2) + (sealed.ciphertext.endsWith("A") ? "BB" : "AA") };
  await assert.rejects(decryptSpace(opened, tampered, { spaceId: "s1", keyVersion: 1 }));
});

test("device private keys can't be exported", async () => {
  const device = await generateDeviceKey();
  assert.equal(device.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("jwk", device.privateKey));
});
