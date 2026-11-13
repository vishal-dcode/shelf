// Background service worker: the toolbar button opens the dashboard (some
// browsers, like Vivaldi, keep their own new-tab page), right-clicking it
// offers the side panel, and it owns the "Save page / link" menus. When
// someone is signed in it also keeps their spaces in sync across browsers
// (lib/personal-sync.js) and shared spaces in step (lib/sync.js).

import {
  STATE_KEY,
  activeSpace,
  addLinks,
  ensureUnsorted,
  isSavableUrl,
  loadState,
  PlanLimitError,
  ReadOnlyError,
  update,
} from "./lib/store.js";
import { syncNow } from "./lib/sync.js";
import { isOwnProfileWrite, isOwnWrite } from "./lib/personal-sync.js";
import { PROFILE_KEY } from "./lib/profile.js";
import { readAccount, refreshAccount } from "./lib/account.js";

const MENUS = [
  { id: "save-page", title: "Save page to Shelf", contexts: ["page"] },
  { id: "save-link", title: "Save link to Shelf", contexts: ["link"] },
];

const OPEN_PANEL = "open-side-panel";

// Chrome builds declare a side panel; the Firefox build declares a sidebar
// instead (scripts/build.mjs), so exactly one of these exists.
const sidePanel = chrome.sidePanel;
const sidebar = globalThis.browser?.sidebarAction;

const SYNC_ALARM = "shelf-sync";

function init() {
  sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  rebuildMenus();
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  syncSoon(0);
}

// ------------------------------------------------------------------- sync

let syncTimer = 0;
let lastRound = 0;
function syncSoon(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    lastRound = Date.now();
    syncNow().catch((err) => console.error("Shelf: sync failed", err));
  }, delay);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  const account = await readAccount();
  if (!account.signedIn) return;
  // Plan and invitations every half hour, so an upgrade or a cancellation
  // shows up even if the dashboard stays closed.
  if (Date.now() - account.checkedAt > 30 * 60 * 1000) await refreshAccount().catch(() => {});
  syncSoon(0);
});

// A page asks for a sync right away (after sign-in, accepting an invitation),
// or, with `poll`, every few seconds while it is on screen so changes made in
// another browser show up quickly. Polls from several open pages share one
// round at most every 10 seconds.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "shelf:sync") return;
  if (message.poll && Date.now() - lastRound < 10_000) return;
  syncSoon(0);
});

// Toolbar click: switch to the dashboard tab in this window, or open one.
chrome.action.onClicked.addListener(async (tab) => {
  const url = chrome.runtime.getURL("newtab.html");
  const [existing] = await chrome.tabs.query({ url, windowId: tab.windowId });
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url, windowId: tab.windowId, active: true });
});
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (PROFILE_KEY in changes && !isOwnProfileWrite(changes[PROFILE_KEY].newValue)) syncSoon(2000);
  if (!(STATE_KEY in changes)) return;
  rebuildMenus();
  // Edits go up a couple of seconds later, in one batch. Changes that sync
  // itself just wrote don't start another round.
  const next = changes[STATE_KEY].newValue;
  if (!next?.spaces) return;
  const sharedEdit = next.spaces.some((s) => s.shared && s.shared.role !== "view");
  if (sharedEdit || !isOwnWrite(next)) syncSoon(2000);
});

// Menu rebuilds are chained so a burst of storage changes can't interleave
// removeAll() and create() calls and produce duplicate-id errors.
let menuQueue = Promise.resolve();
function rebuildMenus() {
  menuQueue = menuQueue.then(buildMenus).catch((err) => console.error("Shelf: menu rebuild failed", err));
  return menuQueue;
}

// On Windows a single "&" in a menu title is read as a keyboard accelerator.
const menuTitle = (name) => name.replace(/&/g, "&&");

// The menus only depend on space and collection names, so a save that just
// adds a tab (the common case) leaves them alone.
let menuSignature = null;

// View-only spaces shared with you can't take new tabs.
const writableSpaces = (state) => state.spaces.filter((s) => s.shared?.role !== "view");

function addTargets(menuId, parentId, space, contexts) {
  for (const collection of space.collections) {
    chrome.contextMenus.create({ id: `${menuId}:col:${collection.id}`, parentId, title: menuTitle(collection.name), contexts });
  }
  if (space.collections.some((c) => c.name === "Unsorted")) return;
  if (space.collections.length > 0) {
    chrome.contextMenus.create({ id: `${menuId}:sep:${space.id}`, parentId, type: "separator", contexts });
  }
  chrome.contextMenus.create({ id: `${menuId}:unsorted:${space.id}`, parentId, title: "Unsorted", contexts });
}

// One space: Save page to Shelf → shelves. Several: Save page to Shelf →
// space → shelves, with the open space first, so any space can be picked
// (hovering moves between them; there's nothing to go "back" from).
async function buildMenus() {
  const state = await loadState();
  const active = activeSpace(state);
  const spaces = writableSpaces(state).sort((a, b) => (b.id === active.id) - (a.id === active.id));
  const signature = JSON.stringify([active.id, spaces.map((s) => [s.id, s.name, s.collections.map((c) => [c.id, c.name])])]);
  if (signature === menuSignature) return;
  menuSignature = signature;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: OPEN_PANEL, title: "Open side panel", contexts: ["action"] });
  for (const menu of MENUS) {
    chrome.contextMenus.create({ id: menu.id, title: menu.title, contexts: menu.contexts });
    if (spaces.length <= 1) {
      if (spaces[0]) addTargets(menu.id, menu.id, spaces[0], menu.contexts);
      continue;
    }
    for (const space of spaces) {
      const parentId = `${menu.id}:space:${space.id}`;
      const title = space.id === active.id ? `${menuTitle(space.name)} (open)` : menuTitle(space.name);
      chrome.contextMenus.create({ id: parentId, parentId: menu.id, title, contexts: menu.contexts });
      addTargets(menu.id, parentId, space, menu.contexts);
    }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === OPEN_PANEL) {
    // Must be called straight from the click (a user gesture), before any await.
    const opening = sidePanel ? sidePanel.open({ windowId: tab.windowId }) : sidebar?.open();
    opening?.catch((err) => console.error("Shelf: side panel failed", err));
    return;
  }
  // Ids are "<menu>:unsorted:<space id>" or "<menu>:col:<collection id>".
  // Stored ids may contain ":", so only the prefixes are split.
  const menuId = String(info.menuItemId);
  const kind = menuId.slice(0, menuId.indexOf(":"));
  const rest = menuId.slice(kind.length + 1);
  const unsortedSpace = rest.startsWith("unsorted:") ? rest.slice(9) : null;
  const target = rest.startsWith("col:") ? rest.slice(4) : null;
  if (!kind || (!unsortedSpace && !target)) return;

  const isPage = kind === "save-page";
  const url = isPage ? tab?.url ?? info.pageUrl : info.linkUrl;
  const title = isPage ? tab?.title : info.selectionText?.trim() || info.linkUrl;
  // A link comes from the page's own markup, so only web addresses are taken:
  // a page shouldn't be able to plant file: links in your shelf.
  if (!isSavableUrl(url) || (!isPage && new URL(url).protocol === "file:")) {
    flash(tab?.id, "!", "Shelf can only save web pages and local files");
    return;
  }
  try {
    await update((d) => {
      const space = unsortedSpace && d.spaces.find((s) => s.id === unsortedSpace);
      if (unsortedSpace && !space) throw new Error("space gone");
      const collectionId = space ? ensureUnsorted(d, space.id) : target;
      return addLinks(d, collectionId, [{ title, url }]);
    });
    flash(tab?.id, "✓", "Saved to Shelf");
  } catch (err) {
    console.error("Shelf: save failed", err);
    const message = err instanceof PlanLimitError || err instanceof ReadOnlyError ? err.message : "Shelf couldn't save this. Open Shelf and try again.";
    flash(tab?.id, "!", message);
  }
});

// Short badge on the toolbar button so a right-click save has visible feedback.
function flash(tabId, text, title) {
  if (tabId === undefined) return;
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setTitle({ tabId, title });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    chrome.action.setTitle({ tabId, title: "Open Shelf" }).catch(() => {});
  }, 2000);
}
