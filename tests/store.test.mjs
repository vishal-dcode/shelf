import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  addCollection,
  addImportedSpace,
  addLinks,
  addSpace,
  createDefaultState,
  deleteCollection,
  deleteSpace,
  ensureUnsorted,
  findCollection,
  isSavableUrl,
  addNote,
  isNote,
  moveCollection,
  moveCollectionToSpace,
  moveSpace,
  moveLink,
  normalizeUrlInput,
  removeLink,
  renameLink,
  updateLink,
  renameCollection,
  setCollectionColor,
  setCollectionLayout,
  setSpaceIcon,
  SPACE_ICONS,
  clearCollectionLayouts,
  setStarred,
  updateNote,
  starredCollections,
  validateState,
} from "../lib/store.js";

function fixture() {
  const s = createDefaultState();
  const a = addCollection(s, s.activeSpaceId, "Reading");
  const b = addCollection(s, s.activeSpaceId, "Job hunt");
  addLinks(s, a, [
    { title: "One", url: "https://one.example/" },
    { title: "Two", url: "https://two.example/" },
    { title: "Three", url: "https://three.example/" },
  ]);
  return { s, a, b };
}

const titles = (s, id) => findCollection(s, id).collection.links.map((l) => l.title);

test("only http, https and file URLs are savable", () => {
  assert.ok(isSavableUrl("https://example.com/a?b=1"));
  assert.ok(isSavableUrl("http://localhost:3000/"));
  assert.ok(isSavableUrl("file:///D:/notes.html"));
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "chrome://settings",
    "vivaldi://extensions",
    "chrome-extension://abc/page.html",
    "not a url",
    "",
    null,
    `https://x.example/${"a".repeat(LIMITS.url)}`,
  ]) {
    assert.equal(isSavableUrl(bad), false, String(bad).slice(0, 40));
  }
});

test("file URLs must point at this computer, not a network share", () => {
  assert.ok(isSavableUrl("file:///home/me/notes.html"));
  for (const remote of ["file://server/share/doc.pdf", "file://127.0.0.1/c$/x", "file://attacker.example/x"]) {
    assert.equal(isSavableUrl(remote), false, remote);
  }
});

test("a stored link from an older version stays readable even if it can no longer be opened", () => {
  const { s, a } = fixture();
  findCollection(s, a).collection.links.push({ id: "old-share", title: "Share", url: "file://server/share/doc.pdf", savedAt: 1 });
  assert.ok(validateState(s).ok);
  assert.equal(isSavableUrl("file://server/share/doc.pdf"), false);
});

test("default state is valid", () => {
  assert.deepEqual(validateState(createDefaultState()), { ok: true });
});

test("addLinks skips unsavable URLs and duplicates, and cleans titles", () => {
  const { s, a } = fixture();
  const added = addLinks(s, a, [
    { title: "  Spaced\n  out  ", url: "https://new.example/" },
    { title: "Dup", url: "https://one.example/" },
    { title: "Evil", url: "javascript:alert(1)" },
    { title: "", url: "https://untitled.example/" },
  ]);
  assert.equal(added, 2);
  assert.deepEqual(titles(s, a), ["One", "Two", "Three", "Spaced out", "https://untitled.example/"]);
  assert.ok(validateState(s).ok);
});

test("addLinks inserts at an index", () => {
  const { s, a } = fixture();
  addLinks(s, a, [{ title: "First", url: "https://first.example/" }], 0);
  assert.deepEqual(titles(s, a), ["First", "One", "Two", "Three"]);
});

test("moveLink reorders within a collection in both directions", () => {
  const { s, a } = fixture();
  const [one, , three] = findCollection(s, a).collection.links;
  moveLink(s, one.id, a, 3); // drop after "Three"
  assert.deepEqual(titles(s, a), ["Two", "Three", "One"]);
  moveLink(s, three.id, a, 0);
  assert.deepEqual(titles(s, a), ["Three", "Two", "One"]);
});

test("moveLink moves across collections and drops duplicates", () => {
  const { s, a, b } = fixture();
  const [one, two] = findCollection(s, a).collection.links;
  moveLink(s, one.id, b, Infinity);
  assert.deepEqual(titles(s, a), ["Two", "Three"]);
  assert.deepEqual(titles(s, b), ["One"]);

  addLinks(s, b, [{ title: "Two again", url: two.url }]);
  moveLink(s, two.id, b, 0);
  assert.deepEqual(titles(s, a), ["Three"]);
  assert.deepEqual(titles(s, b), ["One", "Two again"]);
});

test("removeLink and deleteCollection", () => {
  const { s, a, b } = fixture();
  const [one] = findCollection(s, a).collection.links;
  removeLink(s, one.id);
  assert.deepEqual(titles(s, a), ["Two", "Three"]);
  assert.equal(deleteCollection(s, a), 2);
  assert.equal(findCollection(s, a), null);
  assert.ok(findCollection(s, b));
});

test("names are required and trimmed", () => {
  const { s, a } = fixture();
  assert.throws(() => renameCollection(s, a, "   "), /empty/);
  renameCollection(s, a, "  Later   reading ");
  assert.equal(findCollection(s, a).collection.name, "Later reading");
});

test("spaces: add switches to it, last space can't be deleted", () => {
  const s = createDefaultState();
  const first = s.activeSpaceId;
  const second = addSpace(s, "Work");
  assert.equal(s.activeSpaceId, second);
  deleteSpace(s, second);
  assert.equal(s.activeSpaceId, first);
  assert.throws(() => deleteSpace(s, first), /at least one/);
});

test("ensureUnsorted creates the collection once", () => {
  const s = createDefaultState();
  const id1 = ensureUnsorted(s, s.activeSpaceId);
  const id2 = ensureUnsorted(s, s.activeSpaceId);
  assert.equal(id1, id2);
  assert.equal(s.spaces[0].collections.length, 1);
});

test("validateState rejects tampered imports", () => {
  const { s, a } = fixture();
  const evil = structuredClone(s);
  findCollection(evil, a).collection.links[0].url = "javascript:alert(document.cookie)";
  assert.equal(validateState(evil).ok, false);

  const dupIds = structuredClone(s);
  const links = findCollection(dupIds, a).collection.links;
  links[1].id = links[0].id;
  assert.equal(validateState(dupIds).ok, false);

  const badActive = { ...structuredClone(s), activeSpaceId: "nope" };
  assert.equal(validateState(badActive).ok, false);

  assert.equal(validateState({ version: 2, spaces: [] }).ok, false);
  assert.equal(validateState(null).ok, false);
  assert.equal(validateState("[]").ok, false);
});

test("normalizeUrlInput accepts web addresses and rejects other schemes", () => {
  assert.equal(normalizeUrlInput("https://example.com/a"), "https://example.com/a");
  assert.equal(normalizeUrlInput("  example.com/page "), "https://example.com/page");
  assert.equal(normalizeUrlInput("localhost:3000"), "https://localhost:3000/");
  assert.equal(normalizeUrlInput("file:///D:/notes.html"), "file:///D:/notes.html");
  for (const bad of ["", "   ", "hello", "javascript:alert(1)", "mailto:a@b.co", "chrome://settings", "data:text/html,x"]) {
    assert.equal(normalizeUrlInput(bad), null, bad);
  }
});

test("starring collections and listing starred ones across spaces", () => {
  const { s, a, b } = fixture();
  const work = addSpace(s, "Work");
  const c = addCollection(s, work, "Docs");
  setStarred(s, a, true);
  setStarred(s, c, true);
  assert.deepEqual(starredCollections(s).map((x) => x.collection.name), ["Reading", "Docs"]);
  setStarred(s, a, false);
  assert.deepEqual(starredCollections(s).map((x) => x.collection.id), [c]);
  assert.equal(findCollection(s, b).collection.starred, false);
  assert.ok(validateState(s).ok);
});

test("collections saved before starring existed are still valid", () => {
  const { s, a } = fixture();
  delete findCollection(s, a).collection.starred;
  assert.ok(validateState(s).ok);
  findCollection(s, a).collection.starred = "yes";
  assert.equal(validateState(s).ok, false);
});

test("moveSpace reorders the sidebar", () => {
  const d = createDefaultState();
  const a = d.spaces[0].id;
  const b = addSpace(d, "B");
  const c = addSpace(d, "C");
  const ids = () => d.spaces.map((s) => s.id);
  moveSpace(d, c, 0);
  assert.deepEqual(ids(), [c, a, b]);
  moveSpace(d, c, 3);
  assert.deepEqual(ids(), [a, b, c]);
  moveSpace(d, a, 2);
  assert.deepEqual(ids(), [b, a, c]);
  assert.throws(() => moveSpace(d, "nope", 0));
});

test("moveCollectionToSpace puts it at the top of the target space", () => {
  const { s, a, b } = fixture();
  const home = s.activeSpaceId;
  const work = addSpace(s, "Work");
  addCollection(s, work, "Existing");
  moveCollectionToSpace(s, a, work);
  assert.deepEqual(s.spaces.find((x) => x.id === work).collections.map((c) => c.name), ["Reading", "Existing"]);
  assert.deepEqual(s.spaces.find((x) => x.id === home).collections.map((c) => c.id), [b]);
  assert.equal(findCollection(s, a).collection.links.length, 3);
});

test("notes: add, edit, validate, and move without being mistaken for duplicates", () => {
  const { s, a, b } = fixture();
  const n1 = addNote(s, a, { title: "  Packing list ", body: "Passport\r\nCharger\n\n" }, 0);
  const n2 = addNote(s, b, { title: "Questions", body: "" });
  const note = findCollection(s, a).collection.links[0];
  assert.ok(isNote(note));
  assert.equal(note.title, "Packing list");
  assert.equal(note.body, "Passport\nCharger");
  assert.equal(note.url, undefined);
  assert.ok(validateState(s).ok);

  updateNote(s, n1, { title: "Packing", body: "Passport" });
  assert.equal(findCollection(s, a).collection.links[0].body, "Passport");
  assert.throws(() => updateNote(s, n1, { title: "  ", body: "x" }), /empty/);

  moveLink(s, n1, b, Infinity); // b already holds a note (also url-less)
  assert.deepEqual(findCollection(s, b).collection.links.map((l) => l.id), [n2, n1]);

  const tampered = structuredClone(s);
  findCollection(tampered, b).collection.links[0].url = "javascript:alert(1)";
  assert.equal(validateState(tampered).ok, false);
  const fakeKind = structuredClone(s);
  findCollection(fakeKind, a).collection.links[0].kind = "script";
  assert.equal(validateState(fakeKind).ok, false);
});
test("moveCollection reorders within a space in both directions", () => {
  const s = createDefaultState();
  const ids = ["A", "B", "C", "D"].map((n) => addCollection(s, s.activeSpaceId, n));
  const names = () => s.spaces[0].collections.map((c) => c.name);
  moveCollection(s, ids[0], 3); // drop A before D
  assert.deepEqual(names(), ["B", "C", "A", "D"]);
  moveCollection(s, ids[3], 0); // D to the front
  assert.deepEqual(names(), ["D", "B", "C", "A"]);
  moveCollection(s, ids[1], Infinity); // B to the end
  assert.deepEqual(names(), ["D", "C", "A", "B"]);
});

test("collection colours: set, clear, reject unknown, validate", () => {
  const { s, a } = fixture();
  setCollectionColor(s, a, "orange");
  assert.equal(findCollection(s, a).collection.color, "orange");
  assert.ok(validateState(s).ok);
  setCollectionColor(s, a, "default");
  assert.equal("color" in findCollection(s, a).collection, false);
  assert.throws(() => setCollectionColor(s, a, "url(javascript:x)"), /Unknown/);
  findCollection(s, a).collection.color = "hotpink";
  assert.equal(validateState(s).ok, false);
});

test("collection layouts: set, clear, reject unknown, validate", () => {
  const { s, a } = fixture();
  setCollectionLayout(s, a, "two");
  assert.equal(findCollection(s, a).collection.layout, "two");
  assert.ok(validateState(s).ok);
  setCollectionLayout(s, a, "default");
  assert.equal("layout" in findCollection(s, a).collection, false);
  assert.throws(() => setCollectionLayout(s, a, "grid"), /Unknown/);
  setCollectionLayout(s, a, "list");
  assert.equal(clearCollectionLayouts(s), 1);
  assert.equal("layout" in findCollection(s, a).collection, false);
  assert.equal(clearCollectionLayouts(s), 0);
  findCollection(s, a).collection.layout = "seven";
  assert.equal(validateState(s).ok, false);
});

test("renameLink renames tabs and notes, keeps the address", () => {
  const { s, a } = fixture();
  const [one] = findCollection(s, a).collection.links;
  renameLink(s, one.id, "  The first  ");
  assert.equal(findCollection(s, a).collection.links[0].title, "The first");
  assert.equal(findCollection(s, a).collection.links[0].url, "https://one.example/");
  assert.throws(() => renameLink(s, one.id, " "), /empty/);
});

test("updateLink edits title and address, rejects empty titles and non-web addresses", () => {
  const { s, a } = fixture();
  const [one] = findCollection(s, a).collection.links;
  updateLink(s, one.id, { title: " New ", url: "https://new.example/x" });
  const saved = findCollection(s, a).collection.links[0];
  assert.equal(saved.title, "New");
  assert.equal(saved.url, "https://new.example/x");
  assert.throws(() => updateLink(s, one.id, { title: " ", url: "https://a.example/" }), /empty/);
  assert.throws(() => updateLink(s, one.id, { title: "x", url: "javascript:alert(1)" }), /web address/);
  assert.equal(validateState(s).ok, true);
});

test("addImportedSpace adds a copy with fresh ids and a unique name", () => {
  const { s } = fixture();
  const original = structuredClone(s.spaces[0]);
  const id = addImportedSpace(s, original);
  const added = s.spaces.find((sp) => sp.id === id);
  assert.equal(s.spaces.length, 2);
  assert.equal(s.activeSpaceId, id);
  assert.equal(added.name, `${original.name} (2)`);
  assert.notEqual(added.collections[0].id, original.collections[0].id);
  assert.notEqual(added.collections[0].links[0].id, original.collections[0].links[0].id);
  assert.deepEqual(added.collections[0].links.map((l) => l.url), original.collections[0].links.map((l) => l.url));
  assert.ok(validateState(s).ok);
});

test("space icons: set, clear, reject unknown, validate", () => {
  const s = createDefaultState();
  const id = s.activeSpaceId;
  setSpaceIcon(s, id, "briefcase");
  assert.equal(s.spaces[0].icon, "briefcase");
  assert.ok(validateState(s).ok);
  setSpaceIcon(s, id, "space");
  assert.equal("icon" in s.spaces[0], false);
  assert.throws(() => setSpaceIcon(s, id, "<svg onload=alert(1)>"), /Unknown icon/);
  s.spaces[0].icon = "<script>";
  assert.equal(validateState(s).ok, false);
  assert.ok(SPACE_ICONS.includes("space"));
});

test("open-source build: never more than 3 spaces, on any plan", async () => {
  const S = await import("../lib/store.js");
  const d = S.createDefaultState();
  while (d.spaces.length < 3) S.addSpace(d, `Space ${d.spaces.length + 1}`);
  assert.throws(() => S.addSpace(d, "Fourth"), (e) => e.name === "PlanLimitError");
  assert.equal(S.canAdd(d, "pro", "spaces"), false);
  const more = structuredClone(d);
  more.spaces.push({ id: "x4", name: "Fourth", collections: [] });
  assert.equal(S.planBreach(d, more, "pro"), "spaces");
});
