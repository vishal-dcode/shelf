// Export / import of a Shelf backup, shared by the side panel and the dashboard.

import { addImportedSpace, countLinks, getSpace, replaceState, update, validateState } from "./store.js";
import { ask, h, plural } from "./ui.js";

const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

const SPACE_FORMAT = "shelf-space";

function download(data, name) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  h("a", { href: url, download: `${name}-${date}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportBackup(state) {
  download(state, "shelf-backup");
}

// One space on its own. Importing it adds the space instead of replacing everything.
export function exportSpace(state, spaceId) {
  const space = getSpace(state, spaceId);
  const slug = space.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "space";
  download({ format: SPACE_FORMAT, version: state.version, space }, `shelf-space-${slug}`);
}

// One shelf on its own, wrapped as a space so the normal "add a space" import
// can bring it back without touching anything else.
export function exportShelf(state, collectionId) {
  for (const space of state.spaces) {
    const collection = space.collections.find((c) => c.id === collectionId);
    if (!collection) continue;
    const slug = collection.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shelf";
    const wrapped = { id: crypto.randomUUID(), name: collection.name, collections: [collection] };
    if (space.icon) wrapped.icon = space.icon;
    download({ format: SPACE_FORMAT, version: state.version, space: wrapped }, `shelf-${slug}`);
    return;
  }
}

async function fail(reason) {
  await ask({ title: "Couldn't import", body: reason, confirmLabel: "Close", cancel: false });
  return null;
}

// Returns { state, message } after a successful import, or null if a file was
// rejected or the user cancelled. Throws if browser storage refuses the write.
export async function importFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return null;
  if (files.length > 1) return fail("Choose one Shelf backup or space file.");
  const [file] = files;
  if (file.size > IMPORT_MAX_BYTES) return fail(`${file.name} is larger than 10 MB, so it isn't a Shelf backup.`);
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return fail(`${file.name} isn't valid JSON. Choose a Shelf backup file.`);
  }
  if (data?.format === SPACE_FORMAT) return importSpace(data);
  return importShelf(data);
}

async function importShelf(data) {
  const check = validateState(data);
  if (!check.ok) return fail(`That isn't a Shelf backup this version can read (${check.error}).`);
  const links = data.spaces.reduce((n, s) => n + countLinks(s), 0);
  const answer = await ask({
    title: "Replace everything with this backup?",
    body: `The backup has ${plural(data.spaces.length, "space")} and ${plural(links, "saved item")}. What's in Shelf now is replaced.`,
    confirmLabel: "Replace with backup",
    danger: true,
  });
  if (!answer) return null;
  await replaceState(data);
  return { state: data, message: "Backup imported" };
}

async function importSpace(data) {
  const space = data.space;
  const check = validateState({ version: data.version, activeSpaceId: space?.id, spaces: [space] });
  if (!check.ok) return fail(`That isn't a Shelf space file this version can read (${check.error}).`);
  const answer = await ask({
    title: `Add the space ${space.name}?`,
    body: `It has ${plural(space.collections.length, "shelf", "shelves")} and ${plural(countLinks(space), "saved item")}. It's added as a new space, and nothing already in Shelf changes.`,
    confirmLabel: "Add space",
  });
  if (!answer) return null;
  const { state } = await update((d) => addImportedSpace(d, space));
  return { state, message: `Added ${space.name}` };
}
