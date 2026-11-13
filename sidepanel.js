// Shelf side panel: open tabs at the top, the active space's collections below.
// All user data reaches the DOM through textContent / attributes, never HTML.

import {
  STATE_KEY,
  activeSpace,
  addCollection,
  addLinks,
  addSpace,
  countLinks,
  deleteCollection,
  deleteSpace,
  findCollection,
  isNote,
  isSavableUrl,
  isShelfTab,
  loadState,
  moveLink,
  removeLink,
  renameCollection,
  renameSpace,
  setActiveSpace,
  setCollapsed,
  update,
  updateNote,
} from "./lib/store.js";
import {
  DRAG_MIME,
  ask,
  askNote,
  createAnnouncer,
  createMutator,
  dropIndex,
  favicon,
  h,
  icon,
  onOverlaySettled,
  overlayOpen,
  plural,
  readPref,
  setThemePref,
  themePref,
  toggleMenu,
  uriFromDrop,
  watchTheme,
  writePref,
} from "./lib/ui.js";
import { exportBackup, exportSpace, importFiles } from "./lib/backup.js";
import { arrive, createListMotion, lift, pop } from "./lib/motion.js";

const OPEN_ALL_CONFIRM_AT = 15;

const $ = (id) => document.getElementById(id);
const els = {
  main: $("main"),
  openTabs: $("open-tabs"),
  collections: $("collections"),
  spaceSelect: $("space-select"),
  spaceMenuBtn: $("space-menu-btn"),
  settingsBtn: $("settings-btn"),
  search: $("search"),
  error: $("error"),
  errorText: $("error-text"),
  announce: $("announce"),
  importFile: $("import-file"),
};

let state = null;
let tabs = [];
let query = "";
let openTabsCollapsed = readPref("shelf:openTabsCollapsed") === "1";
let dragPayload = null; // what is being dragged inside the panel
let renderPending = false;
let focusKey = null; // element to focus after the next render

// --------------------------------------------------------------- utilities

const announce = createAnnouncer(els.announce);
// Animates what changed between redraws of the shelves (lib/motion.js).
const listMotion = createListMotion({ countSelector: ".toggle .meta" });


function showError(message) {
  els.errorText.textContent = message;
  els.error.hidden = false;
}

const mutate = createMutator(update, {
  setState: (next) => (state = next),
  announce,
  showError,
  hideError: () => (els.error.hidden = true),
  setFocus: (key) => (focusKey = key),
  scheduleRender,
});


// ------------------------------------------------------------------ render

// Re-renders are deferred while a menu, dialog or drag is active so the
// element the user is interacting with doesn't disappear under them.
function scheduleRender() {
  renderPending = true;
  if (overlayOpen() || dragPayload) return;
  queueMicrotask(() => renderPending && render());
}

function render() {
  if (!state) return;
  renderPending = false;
  const active = document.activeElement;
  const restoreKey = focusKey ?? (active instanceof HTMLElement ? active.dataset.key : undefined);
  focusKey = null;

  renderSpaces();
  renderOpenTabs();
  renderCollections();
  if (listMotion.after(els.collections, { scene: state.activeSpaceId, filter: query })) arrive([els.collections]);
  els.main.removeAttribute("aria-busy");

  if (restoreKey) {
    const target = document.querySelector(`[data-key="${CSS.escape(restoreKey)}"]`);
    if (target && target !== document.activeElement) target.focus({ preventScroll: false });
  }
}

function renderSpaces() {
  const space = activeSpace(state);
  els.spaceSelect.replaceChildren(
    ...state.spaces.map((s) => h("option", { value: s.id, selected: s.id === space.id }, s.name)),
  );
}

function renderOpenTabs() {
  const savable = tabs.filter((t) => isSavableUrl(t.url));
  const head = h(
    "div",
    { class: "block-head" },
    h(
      "h2",
      { id: "open-tabs-heading", class: "heading-wrap" },
      h(
        "button",
        {
          type: "button",
          class: "toggle",
          "aria-expanded": String(!openTabsCollapsed),
          "aria-controls": "open-tabs-list",
          dataset: { key: "open-tabs-toggle" },
          onClick: () => {
            openTabsCollapsed = !openTabsCollapsed;
            writePref("shelf:openTabsCollapsed", openTabsCollapsed ? "1" : "0");
            render();
          },
        },
        icon("chevron", "chev"),
        h("span", { class: "block-title" }, "Open tabs"),
        h("span", { class: "meta" }, String(tabs.length)),
      ),
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost",
        disabled: savable.length === 0 ? true : null,
        title: savable.length === 0 ? "No web pages open in this window" : null,
        dataset: { key: "save-all" },
        onClick: saveAllTabs,
      },
      "Save all",
    ),
  );

  const list = h("ul", { id: "open-tabs-list", class: "rows", hidden: openTabsCollapsed });
  for (const tab of tabs) list.append(renderTabRow(tab));
  els.openTabs.replaceChildren(head, list);
}

function renderTabRow(tab) {
  const canSave = isSavableUrl(tab.url);
  const title = tab.title || tab.url || "Untitled";
  const row = h(
    "li",
    {
      class: `row${tab.active ? " is-active" : ""}`,
      draggable: canSave ? "true" : null,
      dataset: { tabId: String(tab.id) },
    },
    h(
      "button",
      {
        type: "button",
        class: "row-main",
        title: tab.url,
        dataset: { key: `tab:${tab.id}` },
        onClick: () => switchToTab(tab),
      },
      canSave ? favicon(tab.url) : h("span", { class: "favicon" }),
      h("span", { class: "row-title" }, title),
      h("span", { class: "sr-only" }, tab.active ? "(current tab)" : ""),
    ),
    canSave
      ? h(
          "div",
          { class: "row-actions" },
          h(
            "button",
            {
              type: "button",
              class: "icon-btn",
              "aria-label": `Save ${title} to a shelf`,
              "aria-haspopup": "menu",
              "aria-expanded": "false",
              dataset: { key: `tab-save:${tab.id}` },
              onClick: (event) =>
                toggleMenu(
                  event.currentTarget,
                  () =>
                    collectionTargets((id) =>
                      saveTabs([tab], id).then((added) => {
                        if (added) pop(document.querySelector(`[data-key="tab-save:${tab.id}"] .icon`));
                      }),
                    ),
                  { label: "Save to" },
                ),
            },
            icon("save"),
          ),
        )
      : h("span", { class: "meta row-note" }, "Can't save"),
  );
  if (canSave) {
    row.addEventListener("dragstart", (event) => {
      dragPayload = { kind: "tab", tab };
      event.dataTransfer.setData(DRAG_MIME, "tab");
      event.dataTransfer.setData("text/uri-list", tab.url);
      event.dataTransfer.effectAllowed = "copyMove";
      row.classList.add("is-dragging");
      lift(row);
    });
    row.addEventListener("dragend", endDrag);
  }
  return row;
}

// Menu items listing the active space's shelves, plus "New shelf".
function collectionTargets(onPick, { excludeId } = {}) {
  const space = activeSpace(state);
  const items = space.collections
    .filter((c) => c.id !== excludeId)
    .map((c) => ({ label: c.name, onSelect: () => onPick(c.id) }));
  if (items.length) items.push("separator");
  items.push({
    label: "New shelf",
    onSelect: async () => {
      const answer = await ask({ title: "New shelf", label: "Name", confirmLabel: "Create shelf" });
      if (!answer) return;
      const id = await mutate((d) => addCollection(d, d.activeSpaceId, answer.value, 0));
      if (id) onPick(id);
    },
  });
  return items;
}

function renderCollections() {
  const space = activeSpace(state);
  const needle = query.toLowerCase();
  const matches = (link) =>
    !needle || [link.title, link.url, link.body].some((text) => typeof text === "string" && text.toLowerCase().includes(needle));

  const total = countLinks(space);
  const head = h(
    "div",
    { class: "block-head" },
    h("h2", { id: "collections-heading", class: "block-title" }, space.name),
    h(
      "span",
      { class: "meta" },
      `${plural(space.collections.length, "shelf", "shelves")}, ${plural(total, "tab")}`,
    ),
  );

  const children = [head];

  if (space.collections.length === 0) {
    children.push(
      h(
        "div",
        { class: "empty-state" },
        h("p", {}, `No shelves in ${space.name} yet. Create one, then drag tabs into it.`),
        h(
          "button",
          { type: "button", class: "btn btn-primary", dataset: { key: "new-collection" }, onClick: createCollection },
          icon("plus"),
          "New shelf",
        ),
      ),
    );
    els.collections.replaceChildren(...children);
    return;
  }

  let shown = 0;
  for (const collection of space.collections) {
    const links = collection.links.filter(matches);
    if (needle && links.length === 0) continue;
    shown++;
    children.push(renderCollection(collection, links));
  }

  if (needle && shown === 0) {
    children.push(
      h(
        "div",
        { class: "empty-state" },
        h("p", {}, `No saved tabs in ${space.name} match “${query}”.`),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-secondary",
            onClick: () => {
              els.search.value = "";
              query = "";
              render();
              els.search.focus();
            },
          },
          "Clear search",
        ),
      ),
    );
  } else if (!needle) {
    children.push(
      h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost new-collection",
          dataset: { key: "new-collection" },
          onClick: createCollection,
        },
        icon("plus"),
        "New shelf",
      ),
    );
  }

  els.collections.replaceChildren(...children);
}

function renderCollection(collection, links) {
  const searching = query.length > 0;
  const expanded = searching || !collection.collapsed;
  const listId = `col-list-${collection.id}`;

  const section = h(
    "section",
    { class: "collection", "aria-label": collection.name, dataset: { collectionId: collection.id } },
    h(
      "div",
      { class: "collection-head" },
      h(
        "h3",
        { class: "heading-wrap" },
        h(
          "button",
          {
            type: "button",
            class: "toggle",
            "aria-expanded": String(expanded),
            "aria-controls": listId,
            disabled: searching ? true : null,
            dataset: { key: `col-toggle:${collection.id}` },
            onClick: () => mutate((d) => setCollapsed(d, collection.id, !collection.collapsed)),
          },
          icon("chevron", "chev"),
          h("span", { class: "toggle-label collection-name" }, collection.name),
          h("span", { class: "meta" }, String(collection.links.length)),
        ),
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": `Open all tabs in ${collection.name}`,
          title: "Open all",
          disabled: collection.links.length === 0 ? true : null,
          dataset: { key: `col-open:${collection.id}` },
          onClick: () => openAll(collection),
        },
        icon("openAll"),
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": `Options for ${collection.name}`,
          "aria-haspopup": "menu",
          "aria-expanded": "false",
          dataset: { key: `col-menu:${collection.id}` },
          onClick: (event) =>
            toggleMenu(event.currentTarget, () => [
              { label: "Rename", onSelect: () => renameCollectionFlow(collection) },
              { label: "Delete shelf", danger: true, onSelect: () => deleteCollectionFlow(collection) },
            ]),
        },
        icon("more"),
      ),
    ),
  );

  const list = h("ul", { id: listId, class: "rows", hidden: !expanded });
  for (const link of links) list.append(renderLinkRow(link, collection));
  section.append(list);
  if (expanded && collection.links.length === 0) {
    section.append(h("p", { class: "empty-collection" }, "Drag a tab here, or use its save button."));
  }

  attachDropTarget(section, list, collection.id);
  return section;
}

function renderLinkRow(link, collection) {
  const row = h(
    "li",
    { class: "row", draggable: query ? null : "true", dataset: { linkId: link.id } },
    h(
      "button",
      {
        type: "button",
        class: "row-main",
        title: isNote(link) ? link.body.slice(0, 300) || "Empty note" : link.url,
        "aria-label": isNote(link) ? `Note: ${link.title}. Open to edit` : null,
        dataset: { key: `link:${link.id}` },
        onClick: () => (isNote(link) ? editNoteFlow(link) : openLink(link.url)),
      },
      isNote(link) ? icon("note", "favicon note-icon") : favicon(link.url),
      h("span", { class: "row-title" }, link.title),
    ),
    h(
      "div",
      { class: "row-actions" },
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": `Move ${link.title} to another shelf`,
          "aria-haspopup": "menu",
          "aria-expanded": "false",
          dataset: { key: `link-move:${link.id}` },
          onClick: (event) =>
            toggleMenu(
              event.currentTarget,
              () =>
                collectionTargets(
                  (targetId) =>
                    mutate((d) => moveLink(d, link.id, targetId, Infinity), {
                      success: () => `Moved to ${findCollection(state, targetId)?.collection.name ?? "collection"}`,
                      focus: `col-toggle:${targetId}`,
                    }),
                  { excludeId: collection.id },
                ),
              { label: "Move to" },
            ),
        },
        icon("move"),
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": `Remove ${link.title}`,
          dataset: { key: `link-remove:${link.id}` },
          onClick: () => removeLinkFlow(link, collection),
        },
        icon("close"),
      ),
    ),
  );
  row.addEventListener("dragstart", (event) => {
    dragPayload = { kind: "link", linkId: link.id };
    event.dataTransfer.setData(DRAG_MIME, "link");
    if (link.url) event.dataTransfer.setData("text/uri-list", link.url);
    else event.dataTransfer.setData("text/plain", link.title);
    event.dataTransfer.effectAllowed = "move";
    row.classList.add("is-dragging");
    lift(row);
  });
  row.addEventListener("dragend", endDrag);
  return row;
}

// ------------------------------------------------------------- drag & drop

function clearDropMarks() {
  document.querySelectorAll(".drop-before").forEach((el) => el.classList.remove("drop-before"));
  document.querySelectorAll(".drop-end").forEach((el) => el.classList.remove("drop-end"));
  document.querySelectorAll(".is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
}

function endDrag() {
  dragPayload = null;
  clearDropMarks();
  document.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
  if (renderPending) render();
}

// Index in the collection's full link list where a drop lands.
function dropIndexIn(list, x, y) {
  if (query || list.hidden) return { index: Infinity, before: null };
  return dropIndex([...list.querySelectorAll(":scope > li[data-link-id]")], x, y, "list");
}

function acceptsDrag(event) {
  const types = event.dataTransfer?.types ?? [];
  return dragPayload !== null || types.includes("text/uri-list");
}

function attachDropTarget(section, list, collectionId) {
  section.addEventListener("dragover", (event) => {
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dragPayload?.kind === "link" ? "move" : "copy";
    clearDropMarks();
    section.classList.add("is-drop-target");
    const { before } = dropIndexIn(list, event.clientX, event.clientY);
    if (before) before.classList.add("drop-before");
    else if (!list.hidden && list.children.length) list.classList.add("drop-end");
  });
  section.addEventListener("dragleave", (event) => {
    if (!section.contains(event.relatedTarget)) clearDropMarks();
  });
  section.addEventListener("drop", async (event) => {
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    const { index } = dropIndexIn(list, event.clientX, event.clientY);
    const payload = dragPayload;
    endDrag();
    if (payload?.kind === "tab") {
      await saveTabs([payload.tab], collectionId, index);
    } else if (payload?.kind === "link") {
      listMotion.expectSettle(`link:${payload.linkId}`);
      await mutate((d) => moveLink(d, payload.linkId, collectionId, index), { success: "Moved" });
    } else {
      // A link dragged in from a web page.
      const url = uriFromDrop(event.dataTransfer);
      if (!isSavableUrl(url)) {
        showError("Shelf can only save web pages and local files.");
        return;
      }
      await saveItems([{ title: url, url }], collectionId, index);
    }
  });
}

// ----------------------------------------------------------------- actions

function collectionName(id) {
  return findCollection(state, id)?.collection.name ?? "collection";
}

async function saveItems(items, collectionId, index) {
  const added = await mutate((d) => addLinks(d, collectionId, items, index), {
    success: (n) =>
      n === 0 ? `Already in ${collectionName(collectionId)}` : `Saved ${plural(n, "tab")} to ${collectionName(collectionId)}`,
  });
  return added;
}

function saveTabs(tabList, collectionId, index) {
  return saveItems(
    tabList.map((t) => ({ title: t.title, url: t.url })),
    collectionId,
    index,
  );
}

async function saveAllTabs() {
  const savable = tabs.filter((t) => isSavableUrl(t.url));
  if (savable.length === 0) return;
  const stamp = new Date().toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const answer = await ask({
    title: `Save ${plural(savable.length, "tab")}`,
    body: "They go into a new shelf at the top of this space.",
    label: "Shelf name",
    value: `Session ${stamp}`,
    checkbox: "Close these tabs after saving",
    confirmLabel: "Save tabs",
  });
  if (!answer) return;
  // The dialog may have been open a while: re-read the tabs so what gets
  // saved is what's on screen now, and only tabs that were saved get closed.
  const current = (await Promise.all(savable.map((t) => chrome.tabs.get(t.id).catch(() => null)))).filter(
    (t) => t && isSavableUrl(t.url),
  );
  if (current.length === 0) return;
  const id = await mutate(
    (d) => {
      const collectionId = addCollection(d, d.activeSpaceId, answer.value, 0);
      addLinks(d, collectionId, current);
      return collectionId;
    },
    { success: `Saved ${plural(current.length, "tab")} to ${answer.value}`, focus: (cid) => `col-toggle:${cid}` },
  );
  if (id) pop(document.querySelector('[data-key="save-all"]'), 1.06);
  if (!id || !answer.checked) return;
  // Closing every tab would close the window (and this panel), so keep one.
  const ids = current.map((t) => t.id);
  const open = await chrome.tabs.query({ currentWindow: true });
  if (ids.length === open.length) await chrome.tabs.create({ active: true });
  await chrome.tabs.remove(ids).catch((err) => console.error("Shelf: closing tabs failed", err));
}

async function createCollection() {
  const answer = await ask({ title: "New shelf", label: "Name", confirmLabel: "Create shelf" });
  if (!answer) return;
  await mutate((d) => addCollection(d, d.activeSpaceId, answer.value), {
    success: `Created ${answer.value}`,
    focus: (id) => `col-toggle:${id}`,
  });
}

async function renameCollectionFlow(collection) {
  const answer = await ask({
    title: "Rename shelf",
    label: "Name",
    value: collection.name,
    confirmLabel: "Rename",
  });
  if (!answer) return;
  await mutate((d) => renameCollection(d, collection.id, answer.value), { success: `Renamed to ${answer.value}` });
}

async function deleteCollectionFlow(collection) {
  const n = collection.links.length;
  const answer = await ask({
    title: `Delete ${collection.name}?`,
    body: n ? `This removes ${plural(n, "saved tab")}. Export a backup first to keep a copy.` : "It's empty.",
    confirmLabel: "Delete shelf",
    danger: true,
  });
  if (!answer) return;
  await mutate((d) => deleteCollection(d, collection.id), {
    success: `Deleted ${collection.name}`,
    focus: "new-collection",
  });
}

async function removeLinkFlow(link, collection) {
  // Focus the next row's title (or the collection header) once this one is gone.
  const index = collection.links.findIndex((l) => l.id === link.id);
  const neighbour = collection.links[index + 1] ?? collection.links[index - 1];
  await mutate((d) => removeLink(d, link.id), {
    success: `Removed ${link.title}`,
    focus: neighbour ? `link:${neighbour.id}` : `col-toggle:${collection.id}`,
  });
}

function openLink(url) {
  if (!isSavableUrl(url)) return;
  chrome.tabs.create({ url, active: true });
}

async function editNoteFlow(link) {
  const note = await askNote({ heading: "Edit note", title: link.title, body: link.body, confirmLabel: "Save note" });
  if (!note) return;
  await mutate((d) => updateNote(d, link.id, note), { success: `Saved note ${note.title}` });
}

// Focuses an open dashboard tab, or opens one.
async function openDashboard() {
  const url = chrome.runtime.getURL("newtab.html");
  const [existing] = await chrome.tabs.query({ url, currentWindow: true });
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url, active: true });
}

async function openAll(collection) {
  const links = collection.links.filter((l) => isSavableUrl(l.url));
  if (links.length >= OPEN_ALL_CONFIRM_AT) {
    const answer = await ask({
      title: `Open ${links.length} tabs?`,
      body: `Every tab in ${collection.name} opens in this window.`,
      confirmLabel: `Open ${links.length} tabs`,
    });
    if (!answer) return;
  }
  for (const [i, link] of links.entries()) {
    await chrome.tabs.create({ url: link.url, active: i === 0 });
  }
}

async function switchToTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// ------------------------------------------------------------------ spaces

function spaceMenuItems() {
  const space = activeSpace(state);
  const last = state.spaces.length <= 1;
  return [
    { label: "New space", onSelect: newSpaceFlow },
    { label: `Rename ${space.name}`, onSelect: () => renameSpaceFlow(space) },
    "separator",
    {
      label: `Delete ${space.name}`,
      danger: true,
      disabled: last,
      disabledReason: last ? "Keep at least one space" : null,
      onSelect: () => deleteSpaceFlow(space),
    },
  ];
}

async function newSpaceFlow() {
  const answer = await ask({ title: "New space", label: "Name", confirmLabel: "Create space" });
  if (!answer) return;
  await mutate((d) => addSpace(d, answer.value), { success: `Switched to ${answer.value}` });
}

async function renameSpaceFlow(space) {
  const answer = await ask({ title: "Rename space", label: "Name", value: space.name, confirmLabel: "Rename" });
  if (!answer) return;
  await mutate((d) => renameSpace(d, space.id, answer.value), { success: `Renamed to ${answer.value}` });
}

async function deleteSpaceFlow(space) {
  const tabsCount = countLinks(space);
  const answer = await ask({
    title: `Delete ${space.name}?`,
    body: `This removes ${plural(space.collections.length, "shelf", "shelves")} and ${plural(tabsCount, "saved tab")}.`,
    confirmLabel: "Delete space",
    danger: true,
  });
  if (!answer) return;
  await mutate((d) => deleteSpace(d, space.id), { success: `Deleted ${space.name}`, focus: "space-menu" });
}

// ---------------------------------------------------------------- settings

function settingsItems() {
  const pref = themePref();
  const theme = (value, label) => ({
    label,
    checked: pref === value,
    onSelect: () => {
      setThemePref(value);
      announce(`${label} theme`);
    },
  });
  return [
    theme("system", "Match system"),
    theme("light", "Light"),
    theme("dark", "Dark"),
    "separator",
    { label: "Export all spaces", onSelect: exportAll },
    { label: `Export ${activeSpace(state).name}`, onSelect: exportCurrentSpace },
    { label: "Import", onSelect: () => els.importFile.click() },
  ];
}

function exportAll() {
  exportBackup(state);
  announce("All spaces exported");
}

function exportCurrentSpace() {
  const space = activeSpace(state);
  exportSpace(state, space.id);
  announce(`${space.name} exported`);
}

async function importAll(files) {
  try {
    const imported = await importFiles(files);
    if (!imported) return;
    state = imported.state;
    announce(imported.message);
    scheduleRender();
  } catch (err) {
    console.error("Shelf: import failed", err);
    showError("Couldn't import. Browser storage refused it. Try again.");
  }
}

// -------------------------------------------------------------------- wire

async function refreshTabs() {
  try {
    const own = chrome.runtime.getURL("");
    tabs = (await chrome.tabs.query({ currentWindow: true })).filter((t) => !isShelfTab(t, own));
  } catch (err) {
    console.error("Shelf: reading tabs failed", err);
    tabs = [];
  }
  scheduleRender();
}

let tabsTimer = 0;
function refreshTabsSoon() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(refreshTabs, 150);
}

function wire() {
  els.spaceMenuBtn.append(icon("more"));
  const dashboardBtn = $("dashboard-btn");
  dashboardBtn.append(icon("openAll"));
  dashboardBtn.addEventListener("click", () =>
    openDashboard().catch((err) => {
      console.error("Shelf: opening dashboard failed", err);
      showError("Couldn't open the dashboard. Try again.");
    }),
  );
  els.settingsBtn.append(icon("settings"));

  els.spaceSelect.addEventListener("change", () => {
    const id = els.spaceSelect.value;
    mutate((d) => setActiveSpace(d, id), { success: () => `Switched to ${activeSpace(state).name}` });
  });
  els.spaceMenuBtn.addEventListener("click", () => toggleMenu(els.spaceMenuBtn, spaceMenuItems));
  els.settingsBtn.addEventListener("click", () => toggleMenu(els.settingsBtn, settingsItems));

  let searchTimer = 0;
  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = els.search.value.trim();
      render();
    }, 120);
  });

  $("error-dismiss").addEventListener("click", () => {
    els.error.hidden = true;
    els.search.focus();
  });

  els.importFile.addEventListener("change", () => {
    const files = [...(els.importFile.files ?? [])];
    els.importFile.value = "";
    if (files.length) importAll(files);
  });

  watchTheme();
  onOverlaySettled(() => renderPending && render());

  // Skip the redraw when the change is our own save echoing back.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !(STATE_KEY in changes)) return;
    const next = await loadState();
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    scheduleRender();
  });

  // Ignore tab updates that don't change what the panel shows (loading
  // progress, audio state and so on).
  chrome.tabs.onUpdated.addListener((_tabId, change) => {
    if ("title" in change || "url" in change || "favIconUrl" in change || change.status === "complete") refreshTabsSoon();
  });
  for (const event of [
    chrome.tabs.onCreated,
    chrome.tabs.onRemoved,
    chrome.tabs.onActivated,
    chrome.tabs.onMoved,
    chrome.tabs.onAttached,
    chrome.tabs.onDetached,
  ]) {
    event.addListener(refreshTabsSoon);
  }
}

async function start() {
  try {
    wire();
    [state] = await Promise.all([loadState(), refreshTabs()]);
    render();
  } catch (err) {
    console.error("Shelf: failed to load", err);
    els.main.removeAttribute("aria-busy");
    showError("Couldn't read your saved tabs from browser storage. Reload the panel to try again.");
  }
}

// While Shelf is on screen, ask the background worker to sync every 15
// seconds (and when the page comes back into view), so edits made in another
// browser show up here quickly. It does nothing when signed out.
function pollSync() {
  if (document.visibilityState === "visible") chrome.runtime.sendMessage({ type: "shelf:sync", poll: true }).catch(() => {});
}
setInterval(pollSync, 15_000);
document.addEventListener("visibilitychange", pollSync);

start();
