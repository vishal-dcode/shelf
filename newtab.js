// Shelf dashboard (new-tab page): spaces sidebar, saved collections, open tabs.
// All user data reaches the DOM through textContent / attributes, never HTML.

import {
  COLLECTION_COLORS,
  COLLECTION_LAYOUTS,
  STATE_KEY,
  activeSpace,
  addCollection,
  addLinks,
  addNote,
  addSpace,
  canAdd,
  countLinks,
  FREE_LIMITS,
  planUsage,
  deleteCollection,
  deleteSpace,
  findCollection,
  isNote,
  isSavableUrl,
  isShelfTab,
  loadState,
  moveCollection,
  moveCollectionToSpace,
  moveSpace,
  getSpace,
  moveLink,
  normalizeUrlInput,
  removeLink,
  renameCollection,
  updateLink,
  renameSpace,
  setActiveSpace,
  setCollapsed,
  setCollectionColor,
  setCollectionLayout,
  clearCollectionLayouts,
  setSpaceIcon,
  SPACE_ICONS,
  setStarred,
  starredCollections,
  update,
  updateNote,
  validateState,
} from "./lib/store.js";
import {
  DRAG_MIME,
  ask,
  askNote,
  closeMenu,
  createAnnouncer,
  createMutator,
  dropIndex,
  favicon,
  h,
  icon,
  isDarkTheme,
  onOverlaySettled,
  openMenu,
  overlayOpen,
  plural,
  readPref,
  setThemePref,
  toggleMenu,
  uriFromDrop,
  watchTheme,
  writePref,
} from "./lib/ui.js";
import { exportBackup, exportShelf, exportSpace, importFiles } from "./lib/backup.js";
import { formatShortcut, loadShortcuts, matches, spaceNumber } from "./lib/shortcuts.js";
import { CONFIG } from "./lib/config.js";
import { openSettings } from "./lib/settings.js";
import {
  arrive,
  captureCurrent,
  captureRects,
  createListMotion,
  foldSidebar,
  glideRects,
  lift,
  pop,
  settle,
  slideCurrent,
  slideTabsPanel,
} from "./lib/motion.js";
import { EMPTY_PROFILE, PROFILE_KEY, readProfile, sanitizeProfile } from "./lib/profile.js";
import { avatar } from "./lib/profile-ui.js";
import {
  ACCOUNT_KEY,
  accountsConfigured,
  billingPortalUrl,
  deleteAccountData,
  readAccount,
  refreshAccount,
  signIn,
  signOut,
  subscriptionText,
} from "./lib/account.js";
import { AUTH_KEY } from "./lib/auth.js";
import { openInvites, openShare, openUpgrade, openWebsite } from "./lib/share-ui.js";

const OPEN_ALL_CONFIRM_AT = 15;

const $ = (id) => document.getElementById(id);
const els = {
  app: $("app"),
  sidebar: $("sidebar"),
  search: $("search"),
  searchKbd: $("search-kbd"),
  navViews: $("nav-views"),
  navSpaces: $("nav-spaces"),
  createSpace: $("create-space"),
  sidebarClose: $("sidebar-close"),
  tabsClose: $("tabs-close"),
  accountBtn: $("account-btn"),
  main: $("main"),
  boardHead: $("board-head"),
  boardBody: $("board-body"),
  tabsPanel: $("tabs-panel"),
  tabsBody: $("tabs-body"),
  tabsCount: $("tabs-count"),
  error: $("error"),
  errorText: $("error-text"),
  announce: $("announce"),
  importFile: $("import-file"),
};

let state = null;
let windows = []; // [{ id, tabs: [...] }], current window first
let currentWindowId = null;
let query = "";
let view = readPref("shelf:view") === "starred" ? "starred" : "space";
// Below 1100px the open-tabs column overlays the page, so it starts closed there.
const overlayTabsQuery = window.matchMedia("(max-width: 1100px)");
let tabsPanelOpen = !overlayTabsQuery.matches && readPref("shelf:tabsPanel") !== "closed";
let sidebarOpen = readPref("shelf:sidebar") !== "closed";
// Wide windows collapse the sidebar to an icon rail; on a phone-width layout
// (where it stacks above the board) it hides instead.
const stackedQuery = window.matchMedia("(max-width: 720px)");
let lastColumnCount = 0;
let shortcuts = loadShortcuts();
let account = { signedIn: false, plan: "free", invites: [] };
let profile = { ...EMPTY_PROFILE };

// Board layouts: list and grid show one collection per row (tabs as rows or
// cards); "two"/"three" cap the stacked columns; "free" fits as many as it can.
const LAYOUTS = [
  ["list", "List"],
  ["grid", "Grid"],
  ["two", "2 columns"],
  ["three", "3 columns"],
  ["free", "Free"],
];
let layout = LAYOUTS.some(([value]) => value === readPref("shelf:layout")) ? readPref("shelf:layout") : "free";

// A collection's own card layout; without one it follows the board.
const CARD_LAYOUT_LABELS = { list: "List", two: "2 columns", three: "3 columns", free: "Free" };
// The board-wide choice (Tabs button) wins over the board layout's natural one.
let boardCardsPref = COLLECTION_LAYOUTS.includes(readPref("shelf:cards")) ? readPref("shelf:cards") : null;
const boardCards = () => boardCardsPref ?? (layout === "list" ? "list" : "free");
const cardLayout = (collection) => collection.layout ?? boardCards();

const COLOR_LABELS = {
  grey: "Grey",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
};
let dragPayload = null;
let renderPending = false;
let focusKey = null;

const announce = createAnnouncer(els.announce);
// Animates what changed between board redraws (lib/motion.js).
const boardMotion = createListMotion({ countSelector: ".col-count" });

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
  onPlanLimit: (err) => showUpgrade(err.kind),
});

function collectionName(id) {
  return findCollection(state, id)?.collection.name ?? "collection";
}

// ------------------------------------------------------------------ render

// Two independent parts: the board (sidebar + collections, driven by saved
// data) and the open-tabs column (driven by browser tab events). Tab events
// fire often, so they only redraw their own column.
const ALL = { board: true, tabs: true };
const TABS_ONLY = { board: false, tabs: true };
const pendingParts = { board: false, tabs: false };

// Deferred while a menu, dialog or drag is active so the element the user is
// interacting with doesn't disappear under them.
function scheduleRender(parts = ALL) {
  pendingParts.board ||= parts.board;
  pendingParts.tabs ||= parts.tabs;
  renderPending = true;
  if (overlayOpen() || dragPayload) return;
  queueMicrotask(flushRender);
}

function flushRender() {
  if (!renderPending) return;
  render({ ...pendingParts });
}

function render(parts = ALL) {
  if (!state) return;
  renderPending = false;
  pendingParts.board = false;
  pendingParts.tabs = false;
  const active = document.activeElement;
  const restoreKey = focusKey ?? (active instanceof HTMLElement ? active.dataset.key : undefined);
  focusKey = null;

  if (parts.board) {
    boardMotion.before(els.boardBody);
    const current = captureCurrent(els.sidebar);
    const spaceRects = captureRects(els.navSpaces, '[data-key^="space:"]');
    renderSidebar();
    glideRects(els.navSpaces, '[data-key^="space:"]', spaceRects);
    if (settleSpace) {
      settle(els.navSpaces.querySelector(`[data-key="space:${CSS.escape(settleSpace)}"]`)?.closest("li"));
      settleSpace = null;
    }
    slideCurrent(els.sidebar, current);
    renderBoard();
    // The scene ignores the search text: typing never plays the switch.
    const scene = view === "starred" ? "starred" : `space:${state.activeSpaceId}`;
    if (boardMotion.after(els.boardBody, { scene, filter: query })) arrive([els.boardHead, els.boardBody]);
  }
  if (parts.tabs) renderTabs();
  els.main.removeAttribute("aria-busy");

  if (restoreKey) {
    const target = document.querySelector(`[data-key="${CSS.escape(restoreKey)}"]`);
    if (target && target !== document.activeElement) target.focus();
  }
}

// ----------------------------------------------------------------- sidebar

function navItem({ key, iconName, label, count, current, onClick, extra, shortcut }) {
  return h(
    "li",
    { class: "nav-row" },
    h(
      "button",
      {
        type: "button",
        class: "nav-item",
        "aria-current": current ? "page" : null,
        "aria-keyshortcuts": shortcut ?? null,
        title: shortcut ? `${label} (${shortcut})` : label,
        dataset: { key },
        onClick,
      },
      icon(iconName),
      h("span", { class: "nav-label" }, label),
      count === undefined ? null : h("span", { class: "meta nav-count" }, String(count)),
    ),
    extra ?? null,
  );
}

function renderSidebar() {
  const rail = !sidebarOpen && !stackedQuery.matches;
  const wasRail = els.sidebar.classList.contains("is-collapsed") || els.sidebar.classList.contains("is-folding");
  els.sidebar.hidden = !sidebarOpen && stackedQuery.matches;
  els.sidebar.classList.toggle("is-collapsed", rail);
  els.app.classList.toggle("sidebar-collapsed", rail);
  foldSidebar(els.app, els.sidebar, wasRail, rail);
  els.app.classList.toggle("sidebar-hidden", els.sidebar.hidden);
  const railLabel = sidebarOpen ? "Collapse sidebar" : "Expand sidebar";
  els.sidebarClose.setAttribute("aria-label", railLabel);
  els.sidebarClose.setAttribute("aria-expanded", String(sidebarOpen));
  els.sidebarClose.setAttribute("aria-keyshortcuts", formatShortcut(shortcuts.sidebar));
  els.sidebarClose.title = `${railLabel} (${formatShortcut(shortcuts.sidebar)})`;
  els.tabsClose.setAttribute("aria-keyshortcuts", formatShortcut(shortcuts.tabs));
  els.tabsClose.title = `Hide open tabs (${formatShortcut(shortcuts.tabs)})`;
  els.search.setAttribute("aria-keyshortcuts", formatShortcut(shortcuts.search));
  els.searchKbd.textContent = formatShortcut(shortcuts.search);
  if (els.sidebar.hidden) return;
  const space = activeSpace(state);
  const searching = query.length > 0;

  els.navViews.replaceChildren(
    navItem({
      key: "view-starred",
      iconName: "star",
      label: "Starred",
      count: starredCollections(state).length,
      current: !searching && view === "starred",
      onClick: () => showView("starred"),
    }),
  );

  els.navSpaces.replaceChildren(
    ...state.spaces.map((s, index) => {
      const row = navItem({
        key: `space:${s.id}`,
        shortcut: index < 9 ? formatShortcut(shortcuts.spaces, index + 1) : null,
        iconName: s.icon ?? "space",
        label: s.name,
        count: countLinks(s),
        current: !searching && view === "space" && s.id === space.id,
        onClick: () => openSpace(s.id),
        extra: h(
          "button",
          {
            type: "button",
            class: "icon-btn nav-more",
            "aria-label": `Options for ${s.name}`,
            "aria-haspopup": "menu",
            "aria-expanded": "false",
            dataset: { key: `space-menu:${s.id}` },
            onClick: (event) => toggleMenu(event.currentTarget, () => spaceMenuItems(s)),
          },
          icon("more"),
        ),
      });
      attachSpaceDrop(row, s);
      if (!searching && state.spaces.length > 1) attachSpaceDrag(row, s);
      return row;
    }),
  );
}

// ----------------------------------------------------------------- account

// The theme is one switch. Until it is first used the page follows the
// system setting (theme-init.js), so the switch shows what is on screen.
function toggleDarkMode() {
  const dark = !isDarkTheme();
  setThemePref(dark ? "dark" : "light");
  announce(dark ? "Dark mode on" : "Dark mode off");
  return dark;
}

function showSettings(page) {
  closeMenu();
  openSettings({
    page: typeof page === "string" ? page : undefined,
    announce,
    onShortcutsChange: (next) => {
      shortcuts = next;
      renderSidebar();
    },
    onProfileChange: (next) => {
      profile = next;
      renderAccountButton();
    },
    onClose: flushRender,
    data: {
      signedIn: account.signedIn,
      email: account.email,
      plan: account.plan,
      planText: subscriptionText(account) ? `Pro ${subscriptionText(account)}.` : null,
      onExport: exportAll,
      onImport: () => els.importFile.click(),
      onSignIn: () => doSignIn().catch(() => {}),
      onUpgrade: () => showUpgrade(null),
      onManageSubscription: () => doManageSubscription(),
      onDeleteAccountData: doDeleteAccountData,
    },
  });
}

function usageText() {
  const used = planUsage(state);
  return `${used.spaces}/${FREE_LIMITS.spaces} spaces · ${used.collections}/${FREE_LIMITS.collections} shelves`;
}

function renderAccountButton() {
  const name = profile.name || (account.signedIn ? (account.email ?? "Signed in") : "Shelf");
  const sub = !CONFIG.plansEnabled
    ? (account.signedIn ? (profile.name ? (account.email ?? "Signed in") : "Signed in") : "Open-source build")
    : account.plan === "pro" ? "Pro plan" : account.signedIn ? "Free plan" : "Free plan · Sign in";
  els.accountBtn.replaceChildren(
    ...[
      avatar(profile, "", account.email),
      h("span", { class: "account-meta" }, h("strong", {}, name), h("small", {}, sub)),
      account.invites.length ? h("span", { class: "account-dot", title: "Invitations waiting" }) : null,
      icon("selector", "account-chev"),
    ].filter(Boolean),
  );
  els.accountBtn.title = account.invites.length ? `Account: ${plural(account.invites.length, "invitation")} waiting` : "Account";
}

async function reloadAccount() {
  [account, profile] = await Promise.all([readAccount(), readProfile()]);
  renderAccountButton();
}

async function doSignIn() {
  closeMenu();
  if (!accountsConfigured()) {
    showError("Accounts aren't set up in this build of Shelf yet.");
    return account;
  }
  try {
    account = await signIn();
    renderAccountButton();
    announce(`Signed in as ${account.email ?? "you"}`);
  } catch (err) {
    // Closing the sign-in window is not an error worth showing.
    if (!/cancel|closed|did not approve|user denied/i.test(String(err?.message))) showError(err.message || "Couldn't sign in. Try again.");
    throw err;
  }
  return account;
}

async function doRefreshPlan() {
  account = await refreshAccount({ fresh: true });
  renderAccountButton();
  scheduleRender();
  if (CONFIG.plansEnabled) announce(account.plan === "pro" ? "Shelf Pro is on" : "You're on the free plan");
  return account;
}

async function doSignOut() {
  const answer = await ask({
    title: "Sign out of Shelf?",
    body: "Your own spaces stay in this browser and stop syncing. Spaces other people shared with you are removed from it until you sign in again.",
    confirmLabel: "Sign out",
  });
  if (!answer) return;
  await signOut();
  await reloadAccount();
  state = await loadState();
  render();
  announce("Signed out");
}

async function doDeleteAccountData() {
  const answer = await ask({
    title: "Delete your account data?",
    body: "This permanently deletes what Shelf's server holds about you: the synced copy of your spaces, your plan record, your browsers' encryption keys, your memberships, and every space you share (for everyone in it). This browser keeps its own copy of your spaces. Sign out of Shelf in your other browsers first, or they'll sync their copy back. It can't be undone. To delete the sign-in account too, do it on Shelf's account page afterwards.",
    confirmLabel: "Delete account data",
    danger: true,
  });
  if (!answer) return;
  try {
    await deleteAccountData();
    await reloadAccount();
    state = await loadState();
    render();
    announce("Account data deleted. You're signed out.");
  } catch (err) {
    showError(err.message || "Couldn't delete your account data. Try again.");
  }
}

function showUpgrade(kind) {
  closeMenu();
  openUpgrade({
    kind,
    account,
    onSignIn: doSignIn,
    onRefresh: doRefreshPlan,
    onClose: flushRender,
  });
}

// Before asking for a name: is there room on this plan? Shelves in a space
// someone shared with you don't count.
function roomFor(kind, spaceId = state.activeSpaceId) {
  const space = state.spaces.find((s) => s.id === spaceId);
  if (kind === "collections" && space?.shared && space.shared.role !== "owner") return true;
  if (canAdd(state, account.plan, kind)) return true;
  showUpgrade(kind);
  return false;
}

function showInvites() {
  closeMenu();
  openInvites({ invites: account.invites, announce, onChanged: () => refreshAccount().then(reloadAccount), onClose: flushRender });
}

function showShare(space) {
  closeMenu();
  if (!account.signedIn) return showUpgrade("share");
  openShare({ space, account, announce, onUpgrade: showUpgrade, onClose: flushRender });
}

// Opens Paddle's customer portal (cancel, change card or UPI mandate,
// invoices). A Pro plan given by hand has no subscription to manage.
async function doManageSubscription() {
  try {
    const url = await billingPortalUrl();
    chrome.tabs.create({ url });
  } catch (err) {
    showError(err.code === "no_subscription" ? "This Pro plan wasn't bought through Paddle, so there's no subscription to manage." : err.message || "Couldn't open billing. Try again.");
  }
}

function accountMenuItems() {
  const items = [
    {
      node: h(
        "div",
        { class: "account-card" },
        avatar(profile, "avatar-lg", account.email),
        h(
          "span",
          { class: "account-meta" },
          profile.name ? h("strong", {}, profile.name) : null,
          h(profile.name ? "small" : "strong", {}, account.signedIn ? (account.email ?? "Signed in") : "Not signed in"),
          CONFIG.plansEnabled
            ? h(
                "small",
                {},
                account.plan === "pro"
                  ? [h("span", { class: "plan-badge" }, "Pro"), subscriptionText(account) ? ` ${subscriptionText(account)}` : null].filter(Boolean)
                  : `Free · ${usageText()}`,
              )
            : account.signedIn
              ? null
              : h("small", {}, usageText()),
        ),
      ),
    },
    "separator",
    { label: "Edit profile", iconName: "user", onSelect: () => showSettings("profile") },
  ];
  if (account.signedIn) {
    items.push({
      label: account.invites.length ? `Invitations (${account.invites.length})` : "Invitations",
      iconName: "mail",
      onSelect: showInvites,
    });
    if (CONFIG.plansEnabled) {
      items.push(
        account.plan === "pro"
          ? { label: "Manage subscription", iconName: "card", onSelect: () => doManageSubscription() }
          : { label: "Upgrade to Pro", iconName: "sparkle", onSelect: () => showUpgrade(null) },
      );
      items.push({ label: "Refresh plan", iconName: "refresh", onSelect: () => doRefreshPlan().catch((err) => showError(err.message)) });
    }
  } else {
    items.push(
      accountsConfigured()
        ? { label: "Sign in", iconName: "login", onSelect: () => doSignIn().catch(() => {}) }
        : { label: "Sign in", iconName: "login", disabled: true, disabledReason: "Accounts aren't set up in this build yet" },
      ...(CONFIG.plansEnabled ? [{ label: "Upgrade to Pro", iconName: "sparkle", onSelect: () => showUpgrade(null) }] : []),
    );
  }
  items.push(
    {
      label: "Settings",
      iconName: "settings",
      shortcut: formatShortcut(shortcuts.settings),
      keyshortcuts: formatShortcut(shortcuts.settings),
      onSelect: showSettings,
    },
    { label: "Dark mode", iconName: "moon", toggle: isDarkTheme(), onSelect: toggleDarkMode },
    { label: "Help", iconName: "help", onSelect: () => openWebsite("/guide.html") },
  );
  if (account.signedIn) {
    items.push(
      "separator",
      { label: "Sign out", iconName: "logout", onSelect: doSignOut },
    );
  }
  else items.push({ node: h("p", { class: "account-note" }, CONFIG.plansEnabled ? "Shelf works without an account. Sign in to sync your spaces across browsers, upgrade or share spaces." : "Shelf works without an account. Sign in to sync your spaces across browsers or share spaces.") });
  return items;
}

function showView(next) {
  view = next;
  writePref("shelf:view", next);
  clearSearch({ silent: true });
  render();
  els.main.focus({ preventScroll: true });
}

async function openSpace(spaceId) {
  view = "space";
  writePref("shelf:view", "space");
  clearSearch({ silent: true });
  if (state.activeSpaceId !== spaceId) {
    await mutate((d) => setActiveSpace(d, spaceId), { success: () => `Opened ${activeSpace(state).name}` });
  } else {
    render();
  }
  els.main.focus({ preventScroll: true });
}

function spaceMenuItems(space) {
  const last = state.spaces.length <= 1;
  const shared = space.shared;
  const viewOnly = shared?.role === "view";
  return [
    {
      label: shared ? "Sharing…" : "Share…",
      onSelect: () => showShare(space),
    },
    "separator",
    { label: "Rename", disabled: viewOnly, disabledReason: viewOnly ? "View only" : null, onSelect: () => renameSpaceFlow(space) },
    // Keyboard alternative to dragging spaces in the sidebar.
    ...(last
      ? []
      : [
          {
            label: "Move up",
            disabled: state.spaces[0].id === space.id,
            disabledReason: "Already first",
            onSelect: () => reorderSpace(space.id, state.spaces.findIndex((s) => s.id === space.id) - 1),
          },
          {
            label: "Move down",
            disabled: state.spaces.at(-1).id === space.id,
            disabledReason: "Already last",
            onSelect: () => reorderSpace(space.id, state.spaces.findIndex((s) => s.id === space.id) + 2),
          },
        ]),
    { label: "Icon", disabled: viewOnly, disabledReason: viewOnly ? "View only" : null, onSelect: () => openSpaceIconMenu(space) },
    {
      label: "Export",
      onSelect: () => {
        exportSpace(state, space.id);
        announce(`${space.name} exported`);
      },
    },
    {
      label: "Delete space",
      danger: true,
      disabled: last || Boolean(shared),
      disabledReason: last ? "Keep at least one space" : shared ? "Stop sharing or leave it first" : null,
      onSelect: () => deleteSpaceFlow(space),
    },
  ];
}

const ICON_LABELS = {
  space: "Default", home: "Home", briefcase: "Work", book: "Reading", code: "Code", heart: "Favourites", globe: "Web",
  music: "Music", camera: "Photos", cart: "Shopping", game: "Games", plane: "Travel", school: "Study", bolt: "Quick",
  flask: "Research", palette: "Design",
};

// Second menu on the space's own ⋯ button: a grid of icons to choose from.
function openSpaceIconMenu(space) {
  const anchor = document.querySelector(`[data-key="space-menu:${CSS.escape(space.id)}"]`);
  if (!anchor) return;
  const current = space.icon ?? "space";
  const grid = h(
    "div",
    { class: "icon-grid", role: "group", "aria-label": `Icon for ${space.name}` },
    SPACE_ICONS.map((name) =>
      h(
        "button",
        {
          type: "button",
          class: "icon-choice",
          role: "menuitemradio",
          "aria-checked": String(name === current),
          "aria-label": ICON_LABELS[name],
          title: ICON_LABELS[name],
          tabindex: "-1",
          dataset: { menuNav: "" },
          onClick: () => {
            closeMenu({ restoreFocus: true });
            mutate((d) => setSpaceIcon(d, space.id, name), {
              success: `${space.name}: ${ICON_LABELS[name].toLowerCase()} icon`,
              focus: `space-menu:${space.id}`,
            });
          },
        },
        icon(name),
      ),
    ),
  );
  openMenu(anchor, [{ heading: "Icon" }, { node: grid }], { label: `Icon for ${space.name}` });
}

async function createSpaceFlow() {
  if (!roomFor("spaces")) return;
  const answer = await ask({ title: "Create space", label: "Space name", confirmLabel: "Create space", anchor: els.createSpace });
  if (!answer) return;
  view = "space";
  writePref("shelf:view", "space");
  await mutate((d) => addSpace(d, answer.value), {
    success: `Created ${answer.value}`,
    focus: (id) => `space:${id}`,
  });
}

async function renameSpaceFlow(space) {
  const answer = await ask({ title: "Rename space", label: "Space name", value: space.name, confirmLabel: "Rename" });
  if (!answer) return;
  await mutate((d) => renameSpace(d, space.id, answer.value), { success: `Renamed to ${answer.value}` });
}

async function deleteSpaceFlow(space) {
  const tabsCount = countLinks(space);
  const answer = await ask({
    title: `Delete ${space.name}?`,
    body: `This removes ${plural(space.collections.length, "collection")} and ${plural(tabsCount, "saved tab")}. Export a backup first to keep a copy.`,
    confirmLabel: "Delete space",
    danger: true,
  });
  if (!answer) return;
  await mutate((d) => deleteSpace(d, space.id), { success: `Deleted ${space.name}`, focus: "create-space" });
}

// ------------------------------------------------------------------- board

function boardActions() {
  return h(
    "div",
    { class: "board-actions" },
    h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-pill",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-label": `Layout: shelves ${LAYOUTS.find(([v]) => v === layout)[1]}, tabs ${CARD_LAYOUT_LABELS[boardCards()]}`,
        dataset: { key: "layout" },
        onClick: (event) =>
          toggleMenu(
            event.currentTarget,
            () => [
              { heading: "Shelves" },
              ...LAYOUTS.map(([value, label]) => ({
                label,
                ariaLabel: `Shelves: ${label}`,
                checked: layout === value,
                onSelect: () => setLayout(value),
              })),
              "separator",
              { heading: "Tabs in every shelf" },
              ...COLLECTION_LAYOUTS.map((value) => ({
                label: CARD_LAYOUT_LABELS[value],
                ariaLabel: `Tabs: ${CARD_LAYOUT_LABELS[value]}`,
                checked: boardCards() === value,
                onSelect: () => setAllCardLayouts(value),
              })),
            ],
            { label: "Layout" },
          ),
      },
      icon("layout"),
      "Layout",
      icon("chevronDown"),
    ),
    view === "space" && !query && activeSpace(state).shared?.role !== "view"
      ? h(
          "button",
          {
            type: "button",
            class: "btn btn-primary btn-pill",
            dataset: { key: "new-collection" },
            onClick: (event) => createCollectionFlow(event.currentTarget),
          },
          icon("plus"),
          "New shelf",
        )
      : null,
    // The hide button lives in the panel itself; this one only brings it back.
    tabsPanelOpen
      ? null
      : h(
          "button",
          {
            type: "button",
            class: "icon-btn tabs-toggle",
            "aria-label": "Show open tabs",
            "aria-expanded": "false",
            "aria-controls": "tabs-panel",
            title: `Show open tabs (${formatShortcut(shortcuts.tabs)})`,
            "aria-keyshortcuts": formatShortcut(shortcuts.tabs),
            dataset: { key: "tabs-toggle" },
            onClick: toggleTabsPanel,
          },
          icon("panel"),
        ),
  );
}

function sharePill(space) {
  if (!space?.shared) return null;
  const view = space.shared.role === "view";
  return h(
    "button",
    {
      type: "button",
      class: "share-pill",
      title: view ? "Shared with you, view only" : "Shared space",
      onClick: () => showShare(space),
    },
    icon(view ? "eye" : "users"),
    view ? "View only" : "Shared",
  );
}

function boardTitle(title, meta, pill = null) {
  els.boardHead.replaceChildren(
    h(
      "div",
      { class: "board-title-wrap" },
      sidebarOpen || !stackedQuery.matches
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "icon-btn sidebar-toggle",
              "aria-label": "Show sidebar",
              "aria-expanded": "false",
              "aria-controls": "sidebar",
              title: "Show sidebar",
              dataset: { key: "sidebar-toggle" },
              onClick: toggleSidebar,
            },
            icon("panelLeft"),
          ),
      h("h1", { class: "board-title" }, title),
      pill,
      h("span", { class: "meta" }, meta),
    ),
    boardActions(),
  );
}

// Masonry: each collection goes into whichever column is currently
// shortest, so a tall collection never leaves a hole beside it. Heights are
// estimated from card counts (no layout reads), which keeps it cheap.
const COLLECTION_MIN_WIDTH = 352; // 22rem
const COLUMN_GAP = 16;
const CARD_MIN_WIDTH = 176; // 11rem
const CARD_GAP = 6;

function columnCount() {
  const width = els.boardBody.clientWidth || 800;
  const fit = Math.max(1, Math.floor((width + COLUMN_GAP) / (COLLECTION_MIN_WIDTH + COLUMN_GAP)));
  if (layout === "list" || layout === "grid") return 1;
  if (layout === "two") return Math.min(2, fit);
  if (layout === "three") return Math.min(3, fit);
  return fit;
}

function collectionsLayout(entries) {
  const cols = columnCount();
  lastColumnCount = cols;
  const width = els.boardBody.clientWidth || 800;
  const colWidth = (width - COLUMN_GAP * (cols - 1)) / cols;
  const fitPerRow = Math.max(1, Math.floor((colWidth + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
  const perRowFor = { list: 1, two: Math.min(2, fitPerRow), three: Math.min(3, fitPerRow), free: fitPerRow };
  const columns = Array.from({ length: cols }, () => ({ height: 0, el: h("div", { class: "masonry-col" }) }));

  // Columns are chosen from each collection's *open* height, whether or not
  // it's folded. Folding then only shortens that one collection; nothing
  // jumps to another column.
  for (const { collection, links, spaceName } of entries) {
    const cards = cardLayout(collection);
    const rows = Math.ceil(links.length / perRowFor[cards]);
    const rowHeight = cards === "list" ? 38 : 52;
    const estimate = 48 + (spaceName ? 18 : 0) + (links.length ? rows * rowHeight + 8 : 64);
    const target = columns.reduce((min, c) => (c.height < min.height ? c : min), columns[0]);
    target.el.append(renderCollection(collection, { links, spaceName }));
    target.height += estimate + 16;
  }
  return h("div", { class: `collections layout-${layout}` }, columns.map((c) => c.el));
}

function setLayout(value) {
  layout = value;
  writePref("shelf:layout", value);
  // List and Grid define how tabs look, so they replace a Tabs choice.
  if (value === "list" || value === "grid") {
    boardCardsPref = null;
    writePref("shelf:cards", "");
  }
  focusKey = "layout";
  render({ board: true, tabs: false });
  announce(`${LAYOUTS.find(([v]) => v === value)[1]} layout`);
}

async function setAllCardLayouts(value) {
  boardCardsPref = value;
  writePref("shelf:cards", value);
  focusKey = "layout";
  const label = CARD_LAYOUT_LABELS[value];
  const overridden = state.spaces.some((s) => s.collections.some((c) => "layout" in c));
  if (overridden) {
    await mutate((d) => clearCollectionLayouts(d), { success: `Tabs in every shelf: ${label.toLowerCase()}`, focus: "layout" });
  } else {
    render({ board: true, tabs: false });
    announce(`Tabs in every shelf: ${label.toLowerCase()}`);
  }
}

function renderBoard() {
  if (query) return renderSearch();
  if (view === "starred") return renderStarred();
  return renderSpace();
}

function renderSpace() {
  const space = activeSpace(state);
  boardTitle(space.name, `${plural(space.collections.length, "shelf", "shelves")}, ${plural(countLinks(space), "tab")}`, sharePill(space));

  if (space.collections.length === 0) {
    els.boardBody.replaceChildren(
      h(
        "div",
        { class: "empty-state board-empty" },
        h("p", {}, `No shelves in ${space.name} yet. Create one, then drag tabs into it from the right.`),
        h(
          "button",
          { type: "button", class: "btn btn-primary btn-pill", onClick: (event) => createCollectionFlow(event.currentTarget) },
          icon("plus"),
          "New shelf",
        ),
      ),
    );
    return;
  }
  els.boardBody.replaceChildren(collectionsLayout(space.collections.map((c) => ({ collection: c, links: c.links }))));
}

function renderStarred() {
  const starred = starredCollections(state);
  boardTitle("Starred", plural(starred.length, "shelf", "shelves"));
  if (starred.length === 0) {
    els.boardBody.replaceChildren(
      h(
        "div",
        { class: "empty-state board-empty" },
        h("p", {}, "No starred shelves yet. Use the star on any shelf to keep it here."),
      ),
    );
    return;
  }
  els.boardBody.replaceChildren(
    collectionsLayout(starred.map(({ space, collection }) => ({ collection, links: collection.links, spaceName: space.name }))),
  );
}

function renderSearch() {
  const needle = query.toLowerCase();
  const matches = (link) =>
    [link.title, link.url, link.body].some((text) => typeof text === "string" && text.toLowerCase().includes(needle));
  const results = [];
  for (const space of state.spaces) {
    for (const collection of space.collections) {
      const links = collection.links.filter(matches);
      const nameHit = collection.name.toLowerCase().includes(needle);
      if (links.length || nameHit) results.push({ space, collection, links: links.length ? links : collection.links });
    }
  }
  const tabsFound = results.reduce((n, r) => n + r.links.length, 0);
  boardTitle("Search results", `${plural(tabsFound, "tab")} in ${plural(results.length, "shelf", "shelves")}`);

  if (results.length === 0) {
    els.boardBody.replaceChildren(
      h(
        "div",
        { class: "empty-state board-empty" },
        h("p", {}, `Nothing saved matches “${query}”.`),
        h(
          "button",
          { type: "button", class: "btn btn-secondary", onClick: () => clearSearch({ focus: true }) },
          "Clear search",
        ),
      ),
    );
    return;
  }
  els.boardBody.replaceChildren(
    collectionsLayout(results.map(({ space, collection, links }) => ({ collection, links, spaceName: space.name }))),
  );
}

// `links` may be a filtered subset (search). `spaceName` shows where it lives.
function renderCollection(collection, { links, spaceName }) {
  const searching = query.length > 0;
  const expanded = searching || !collection.collapsed;
  const headingId = `col-h-${collection.id}`;
  const listId = `col-list-${collection.id}`;
  const n = collection.links.length;

  const canReorder = view === "space" && !searching;
  const head = h(
    "div",
    { class: "col-head", draggable: canReorder ? "true" : null, title: canReorder ? "Drag to reorder" : null },
      h(
        "h2",
        { class: "heading-wrap", id: headingId },
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
          h("span", { class: "toggle-label col-name" }, collection.name),
        ),
      ),
      h("span", { class: "col-count" }, String(n), h("span", { class: "sr-only" }, n === 1 ? " tab" : " tabs")),
      h(
        "div",
        { class: "col-actions" },
        h(
          "button",
          {
            type: "button",
            class: "icon-btn",
            "aria-label": `Add to ${collection.name}`,
            "aria-haspopup": "menu",
            "aria-expanded": "false",
            title: "Add tab or note",
            dataset: { key: `col-add:${collection.id}` },
            onClick: (event) =>
              toggleMenu(
                event.currentTarget,
                () => [
                  { label: "Add tab by address", onSelect: () => addTabFlow(collection) },
                  { label: "Add note", onSelect: () => addNoteFlow(collection) },
                ],
                { label: `Add to ${collection.name}` },
              ),
          },
          icon("plus"),
        ),
        h(
          "button",
          {
            type: "button",
            class: "icon-btn",
            "aria-label": `Open all tabs in ${collection.name}`,
            title: "Open all",
            disabled: collection.links.some((l) => isSavableUrl(l.url)) ? null : true,
            dataset: { key: `col-open:${collection.id}` },
            onClick: () => openAll(collection),
          },
          icon("openAll"),
        ),
        h(
          "button",
          {
            type: "button",
            class: "icon-btn col-star",
            "aria-label": `Star ${collection.name}`,
            "aria-pressed": String(Boolean(collection.starred)),
            title: collection.starred ? "Unstar" : "Star",
            dataset: { key: `col-star:${collection.id}` },
            onClick: () =>
              mutate((d) => setStarred(d, collection.id, !collection.starred), {
                success: collection.starred ? `Unstarred ${collection.name}` : `Starred ${collection.name}`,
              }),
          },
          icon("star"),
        ),
        h(
          "button",
          {
            type: "button",
            class: "icon-btn col-more",
            "aria-label": `Options for ${collection.name}`,
            "aria-haspopup": "menu",
            "aria-expanded": "false",
            dataset: { key: `col-menu:${collection.id}` },
            onClick: (event) => toggleMenu(event.currentTarget, () => collectionMenuItems(collection)),
          },
          icon("more"),
        ),
      ),
  );

  const section = h(
    "section",
    {
      class: `collection${collection.color ? ` tint-${collection.color}` : ""}`,
      "aria-labelledby": headingId,
      dataset: { collectionId: collection.id },
    },
    head,
    spaceName ? h("p", { class: "meta col-meta" }, `In ${spaceName}`) : null,
  );

  if (canReorder) {
    head.addEventListener("dragstart", (event) => {
      dragPayload = { kind: "collection", collectionId: collection.id };
      event.dataTransfer.setData(DRAG_MIME, "collection");
      event.dataTransfer.setData("text/plain", collection.name);
      event.dataTransfer.effectAllowed = "move";
      section.classList.add("is-dragging");
    });
    head.addEventListener("dragend", endDrag);
  }

  const list = h("ul", { id: listId, class: `cards cards-${cardLayout(collection)}`, hidden: !expanded });
  for (const link of links) list.append(renderCard(link, collection));
  section.append(list);
  if (expanded && n === 0) {
    section.append(h("p", { class: "cards-empty" }, "Drag tabs here from the right, or add one with +."));
  }
  attachDropTarget(section, list, collection.id);
  return section;
}

function cardMain(link) {
  if (isNote(link)) {
    return h(
      "button",
      {
        type: "button",
        class: "card-link card-note",
        title: link.body ? link.body.slice(0, 300) : "Empty note",
        "aria-label": `Note: ${link.title}. Open to edit`,
        dataset: { key: `link:${link.id}` },
        onClick: () => editNoteFlow(link),
      },
      icon("note", "favicon note-icon"),
      h("span", { class: "card-title" }, link.title),
    );
  }
  return h(
    "a",
    {
      class: "card-link",
      href: isSavableUrl(link.url) ? link.url : null,
      title: link.url,
      dataset: { key: `link:${link.id}` },
      onClick: (event) => {
        event.preventDefault();
        openUrl(link.url, { background: event.ctrlKey || event.metaKey || event.shiftKey });
      },
      onAuxclick: (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        openUrl(link.url, { background: true });
      },
    },
    favicon(link.url),
    h("span", { class: "card-title" }, link.title),
  );
}

function renderCard(link, collection) {
  const card = h(
    "li",
    { class: "card", draggable: query ? null : "true", dataset: { linkId: link.id } },
    cardMain(link),
    h(
      "div",
      { class: "card-actions" },
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": `Options for ${link.title}`,
          "aria-haspopup": "menu",
          "aria-expanded": "false",
          title: "Rename or copy link",
          dataset: { key: `link-menu:${link.id}` },
          onClick: (event) =>
            toggleMenu(event.currentTarget, () => cardMenuItems(link), { label: link.title }),
        },
        icon("more"),
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
  card.addEventListener("dragstart", (event) => {
    dragPayload = { kind: "link", linkId: link.id };
    event.dataTransfer.setData(DRAG_MIME, "link");
    if (link.url) event.dataTransfer.setData("text/uri-list", link.url);
    else event.dataTransfer.setData("text/plain", link.title);
    event.dataTransfer.effectAllowed = "move";
    card.classList.add("is-dragging");
    lift(card);
  });
  card.addEventListener("dragend", endDrag);
  return card;
}

function collectionMenuItems(collection) {
  const here = findCollection(state, collection.id)?.space;
  const others = state.spaces.filter((s) => s.id !== here?.id);
  return [
    { label: "Rename", onSelect: () => renameCollectionFlow(collection) },
    { label: "Colour", onSelect: () => openColourMenu(collection) },
    { label: "Layout", onSelect: () => openCardLayoutMenu(collection) },
    ...(others.length ? [{ label: "Move to", more: true, onSelect: () => openMoveMenu(collection) }] : []),
    {
      label: "Export",
      onSelect: () => {
        exportShelf(state, collection.id);
        announce(`${collection.name} exported`);
      },
    },
    "separator",
    { label: "Delete shelf", danger: true, onSelect: () => deleteCollectionFlow(collection) },
  ];
}

// Second layer of "Move to…": the other spaces, on the same ⋯ button.
function openMoveMenu(collection) {
  const anchor = document.querySelector(`[data-key="col-menu:${CSS.escape(collection.id)}"]`);
  if (!anchor) return;
  const here = findCollection(state, collection.id)?.space;
  openMenu(
    anchor,
    [
      { heading: "Move to space" },
      ...state.spaces
        .filter((s) => s.id !== here?.id)
        .map((s) => ({
          label: s.name,
          iconName: s.icon ?? "space",
          onSelect: () =>
            mutate((d) => moveCollectionToSpace(d, collection.id, s.id), {
              success: `Moved ${collection.name} to ${s.name}`,
              focus: `space:${s.id}`,
            }),
        })),
    ],
    { label: `Move ${collection.name} to` },
  );
}

// Second menu, anchored to the same ⋯ button, so the colour list stays short.
function openColourMenu(collection) {
  const anchor = document.querySelector(`[data-key="col-menu:${CSS.escape(collection.id)}"]`);
  if (!anchor) return;
  const current = collection.color ?? "default";
  const pick = (value, label) =>
    mutate((d) => setCollectionColor(d, collection.id, value), {
      success: `${collection.name}: ${label.toLowerCase()} background`,
      focus: `col-menu:${collection.id}`,
    });
  openMenu(
    anchor,
    [
      { label: "Default", swatch: "default", checked: current === "default", onSelect: () => pick("default", "Default") },
      ...COLLECTION_COLORS.map((value) => ({
        label: COLOR_LABELS[value],
        swatch: value,
        checked: current === value,
        onSelect: () => pick(value, COLOR_LABELS[value]),
      })),
    ],
    { label: `Colour for ${collection.name}` },
  );
}

function openCardLayoutMenu(collection) {
  const anchor = document.querySelector(`[data-key="col-menu:${CSS.escape(collection.id)}"]`);
  if (!anchor) return;
  const current = collection.layout ?? "default";
  const pick = (value, label) =>
    mutate((d) => setCollectionLayout(d, collection.id, value), {
      success: `${collection.name}: ${label.toLowerCase()} layout`,
      focus: `col-menu:${collection.id}`,
    });
  openMenu(
    anchor,
    [
      { label: "Same as board", checked: current === "default", onSelect: () => pick("default", "Same as board") },
      "separator",
      ...COLLECTION_LAYOUTS.map((value) => ({
        label: CARD_LAYOUT_LABELS[value],
        checked: current === value,
        onSelect: () => pick(value, CARD_LAYOUT_LABELS[value]),
      })),
    ],
    { label: `Layout for ${collection.name}` },
  );
}

function cardMenuItems(link) {
  return [
    { label: "Edit", onSelect: () => editLinkFlow(link) },
    ...(link.url
      ? [
          {
            label: "Copy link",
            onSelect: () =>
              navigator.clipboard
                .writeText(link.url)
                .then(() => announce("Link copied"))
                .catch(() => showError("Couldn't copy the link. Your browser blocked clipboard access.")),
          },
        ]
      : []),
  ];
}

// Notes open the note editor; tabs edit their title and address together.
async function editLinkFlow(link) {
  if (isNote(link)) return editNoteFlow(link);
  const answer = await ask({
    title: "Edit tab",
    label: "Title",
    value: link.title,
    maxLength: 300,
    emptyMessage: "Enter a title.",
    second: {
      label: "Address",
      value: link.url,
      placeholder: "example.com/page",
      normalize: normalizeUrlInput,
      invalidMessage: "Enter a web address, like example.com/page.",
    },
    confirmLabel: "Save",
  });
  if (!answer) return;
  await mutate((d) => updateLink(d, link.id, { title: answer.value, url: answer.secondValue }), {
    success: `Saved ${answer.value}`,
    focus: `link:${link.id}`,
  });
}

// ------------------------------------------------------------- open tabs

function renderTabs() {
  els.app.classList.toggle("tabs-hidden", !tabsPanelOpen);
  els.tabsPanel.hidden = !tabsPanelOpen;
  const total = windows.reduce((n, w) => n + w.tabs.length, 0);
  els.tabsCount.textContent = plural(total, "tab");

  if (windows.length === 0) {
    els.tabsBody.replaceChildren(h("p", { class: "empty-state" }, "No open windows found."));
    return;
  }
  els.tabsBody.replaceChildren(
    ...windows.map((win, i) => {
      const savable = win.tabs.filter((t) => isSavableUrl(t.url));
      const label = win.id === currentWindowId ? "This window" : `Window ${i + 1}`;
      const headingId = `win-h-${win.id}`;
      return h(
        "section",
        { class: "win", "aria-labelledby": headingId },
        h(
          "div",
          { class: "win-head" },
          h("h3", { class: "win-title overline", id: headingId }, label),
          h(
            "span",
            { class: "win-actions" },
            h(
              "button",
              {
                type: "button",
                class: "icon-btn win-save-icon",
                disabled: savable.length === 0 ? true : null,
                "aria-label": `Save ${label.toLowerCase()} as a shelf`,
                title: savable.length === 0 ? "No web pages open in this window" : "Save these tabs as a shelf",
                dataset: { key: `win-save:${win.id}` },
                onClick: () => saveWindowFlow(win, label),
              },
              icon("save"),
            ),
          ),
        ),
        h("ul", { class: "rows" }, win.tabs.map(renderTabRow)),
      );
    }),
  );
}

function renderTabRow(tab) {
  const canSave = isSavableUrl(tab.url);
  const title = tab.title || tab.url || "Untitled";
  const row = h(
    "li",
    { class: `row${tab.active ? " is-active" : ""}`, draggable: canSave ? "true" : null },
    h(
      "button",
      {
        type: "button",
        class: "row-main",
        title: canSave ? `${title}\n${tab.url}` : `${title}\n${tab.url}\nBrowser pages can't be saved`,
        dataset: { key: `tab:${tab.id}` },
        onClick: () => focusTab(tab),
      },
      canSave ? favicon(tab.url) : h("span", { class: "favicon" }),
      h("span", { class: `row-title${canSave ? "" : " is-muted"}` }, title),
    ),
    h(
      "div",
      { class: "row-actions" },
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": `Close ${title}`,
          dataset: { key: `tab-close:${tab.id}` },
          onClick: () => chrome.tabs.remove(tab.id).catch((err) => console.error("Shelf: close failed", err)),
        },
        icon("close"),
      ),
    ),
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

function toggleTabsPanel() {
  const opening = !tabsPanelOpen;
  slideTabsPanel(els.app, els.tabsPanel, opening, () => {
    tabsPanelOpen = opening;
    // Only remember the choice for the full-width layout; the overlay is transient.
    if (!overlayTabsQuery.matches) writePref("shelf:tabsPanel", tabsPanelOpen ? "open" : "closed");
    focusKey = tabsPanelOpen ? "tabs-close" : "tabs-toggle";
    render();
  });
}

// Opens the sidebar first if it is hidden (narrow layout) or a rail.
function focusSearch() {
  if (!sidebarOpen) toggleSidebar();
  els.search.focus();
  els.search.select();
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  writePref("shelf:sidebar", sidebarOpen ? "open" : "closed");
  focusKey = sidebarOpen || !stackedQuery.matches ? "sidebar-close" : "sidebar-toggle";
  render();
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function saveWindowFlow(win, label) {
  const savable = win.tabs.filter((t) => isSavableUrl(t.url));
  if (savable.length === 0) return;
  if (view !== "space") {
    view = "space";
    writePref("shelf:view", "space");
  }
  const space = activeSpace(state);
  const stamp = new Date().toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const answer = await ask({
    title: `Save ${plural(savable.length, "tab")} from ${label.toLowerCase()}`,
    body: `They go into a new shelf at the top of ${space.name}.`,
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
  if (id) pop(document.querySelector(`[data-key="win-save:${CSS.escape(String(win.id))}"] .icon`));
  if (!id || !answer.checked) return;
  // Never close this dashboard's own tab, and keep the window alive.
  const self = await chrome.tabs.getCurrent().catch(() => null);
  const ids = current.map((t) => t.id).filter((tid) => tid !== self?.id);
  const open = await chrome.tabs.query({ windowId: win.id });
  if (ids.length === open.length) await chrome.tabs.create({ windowId: win.id, active: false });
  await chrome.tabs.remove(ids).catch((err) => console.error("Shelf: closing tabs failed", err));
}

// ------------------------------------------------------------- drag & drop

function clearDropMarks() {
  for (const name of ["drop-before", "is-drop-target", "drop-col-before", "drop-col-after", "drop-space-before", "drop-space-after"]) {
    document.querySelectorAll(`.${name}`).forEach((el) => el.classList.remove(name));
  }
}

// Collection dropped on a collection: lands before it (upper half) or after it.
function collectionDropSide(section, y) {
  const r = section.getBoundingClientRect();
  return y < r.top + r.height / 2 ? "before" : "after";
}

async function dropCollection(movingId, targetId, side) {
  const space = findCollection(state, targetId)?.space;
  const target = space?.collections.findIndex((c) => c.id === targetId) ?? -1;
  if (target === -1 || movingId === targetId) return;
  boardMotion.expectSettle(`shelf:${movingId}`);
  await mutate((d) => moveCollection(d, movingId, side === "before" ? target : target + 1), {
    success: `Moved ${collectionName(movingId)}`,
    focus: `col-toggle:${movingId}`,
  });
}

// The space just dropped in the sidebar; it settles on the next redraw.
let settleSpace = null;

async function reorderSpace(spaceId, toIndex) {
  settleSpace = spaceId;
  await mutate((d) => moveSpace(d, spaceId, toIndex), {
    success: `Moved ${getSpace(state, spaceId)?.name ?? "space"}`,
    focus: `space:${spaceId}`,
  });
}

// Spaces reorder by dragging them up and down the sidebar. A bar shows
// where it lands: above the row under the pointer (upper half) or below.
function spaceDropSide(row, y) {
  const r = row.getBoundingClientRect();
  return y < r.top + r.height / 2 ? "before" : "after";
}

function attachSpaceDrag(row, space) {
  const button = row.querySelector(".nav-item");
  button.draggable = true;
  button.addEventListener("dragstart", (event) => {
    dragPayload = { kind: "space", spaceId: space.id };
    event.dataTransfer.setData(DRAG_MIME, "space");
    event.dataTransfer.setData("text/plain", space.name);
    event.dataTransfer.effectAllowed = "move";
    row.classList.add("is-dragging");
    lift(row);
  });
  button.addEventListener("dragend", endDrag);
  row.addEventListener("dragover", (event) => {
    if (dragPayload?.kind !== "space") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropMarks();
    if (dragPayload.spaceId !== space.id) row.classList.add(`drop-space-${spaceDropSide(row, event.clientY)}`);
  });
  row.addEventListener("dragleave", (event) => {
    if (!row.contains(event.relatedTarget)) row.classList.remove("drop-space-before", "drop-space-after");
  });
  row.addEventListener("drop", async (event) => {
    if (dragPayload?.kind !== "space") return;
    event.preventDefault();
    const moving = dragPayload.spaceId;
    const side = spaceDropSide(row, event.clientY);
    endDrag();
    if (moving === space.id) return;
    const target = state.spaces.findIndex((s) => s.id === space.id);
    await reorderSpace(moving, side === "before" ? target : target + 1);
  });
}

// Spaces in the sidebar accept a dragged collection (moves it to that space).
function attachSpaceDrop(row, space) {
  const button = row.querySelector(".nav-item");
  const accepts = () => dragPayload?.kind === "collection" && findCollection(state, dragPayload.collectionId)?.space.id !== space.id;
  button.addEventListener("dragover", (event) => {
    if (!accepts()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropMarks();
    button.classList.add("is-drop-target");
  });
  button.addEventListener("dragleave", () => button.classList.remove("is-drop-target"));
  button.addEventListener("drop", async (event) => {
    if (!accepts()) return;
    event.preventDefault();
    const id = dragPayload.collectionId;
    endDrag();
    await mutate((d) => moveCollectionToSpace(d, id, space.id), {
      success: `Moved ${collectionName(id)} to ${space.name}`,
      focus: `space:${space.id}`,
    });
  });
}

function endDrag() {
  dragPayload = null;
  clearDropMarks();
  document.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
  flushRender();
}

function cardDropIndex(list, x, y) {
  if (query || list.hidden) return { index: Infinity, before: null };
  return dropIndex([...list.querySelectorAll(":scope > li[data-link-id]")], x, y, list.classList.contains("cards-list") ? "list" : "grid");
}

function acceptsDrag(event) {
  return dragPayload !== null || (event.dataTransfer?.types ?? []).includes("text/uri-list");
}

function attachDropTarget(section, list, collectionId) {
  section.addEventListener("dragover", (event) => {
    if (!acceptsDrag(event)) return;
    if (dragPayload?.kind === "collection") {
      if (dragPayload.collectionId === collectionId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearDropMarks();
      section.classList.add(`drop-col-${collectionDropSide(section, event.clientY)}`);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = dragPayload?.kind === "link" ? "move" : "copy";
    clearDropMarks();
    section.classList.add("is-drop-target");
    cardDropIndex(list, event.clientX, event.clientY).before?.classList.add("drop-before");
  });
  section.addEventListener("dragleave", (event) => {
    if (!section.contains(event.relatedTarget)) clearDropMarks();
  });
  section.addEventListener("drop", async (event) => {
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    const { index } = cardDropIndex(list, event.clientX, event.clientY);
    const payload = dragPayload;
    const side = collectionDropSide(section, event.clientY);
    endDrag();
    if (payload?.kind === "collection") {
      await dropCollection(payload.collectionId, collectionId, side);
    } else if (payload?.kind === "tab") {
      await saveItems([{ title: payload.tab.title, url: payload.tab.url }], collectionId, index);
    } else if (payload?.kind === "link") {
      boardMotion.expectSettle(`link:${payload.linkId}`);
      await mutate((d) => moveLink(d, payload.linkId, collectionId, index), {
        success: `Moved to ${collectionName(collectionId)}`,
      });
    } else {
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

async function saveItems(items, collectionId, index) {
  return mutate((d) => addLinks(d, collectionId, items, index), {
    success: (n) =>
      n === 0 ? `Already in ${collectionName(collectionId)}` : `Saved ${plural(n, "tab")} to ${collectionName(collectionId)}`,
  });
}

async function createCollectionFlow(anchor) {
  if (!roomFor("collections")) return;
  const answer = await ask({ title: "New shelf", label: "Shelf name", confirmLabel: "Create shelf", anchor });
  if (!answer) return;
  await mutate((d) => addCollection(d, d.activeSpaceId, answer.value, 0), {
    success: `Created ${answer.value}`,
    focus: (id) => `col-toggle:${id}`,
  });
}

async function addTabFlow(collection) {
  const answer = await ask({
    title: `Add a tab to ${collection.name}`,
    label: "Page address",
    placeholder: "example.com/page",
    inputMode: "url",
    maxLength: 2048,
    confirmLabel: "Add tab",
    emptyMessage: "Enter a web address.",
    validate: (text) => (normalizeUrlInput(text) ? null : "Enter a web address, like example.com/page."),
  });
  if (!answer) return;
  const url = normalizeUrlInput(answer.value);
  // Use the page's title if it happens to be open, otherwise its address.
  const openTab = windows.flatMap((w) => w.tabs).find((t) => t.url === url);
  const title = openTab?.title || new URL(url).hostname.replace(/^www\./, "") + new URL(url).pathname.replace(/\/$/, "");
  await saveItems([{ title, url }], collection.id);
}

async function addNoteFlow(collection) {
  const note = await askNote({ heading: `Add a note to ${collection.name}`, confirmLabel: "Add note" });
  if (!note) return;
  await mutate((d) => addNote(d, collection.id, note), {
    success: `Added note ${note.title}`,
    focus: (id) => `link:${id}`,
  });
}

async function editNoteFlow(link) {
  const note = await askNote({ heading: "Edit note", title: link.title, body: link.body, confirmLabel: "Save note" });
  if (!note) return;
  await mutate((d) => updateNote(d, link.id, note), { success: `Saved note ${note.title}` });
}

async function renameCollectionFlow(collection) {
  const answer = await ask({
    title: "Rename shelf",
    label: "Shelf name",
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
    focus: view === "space" ? "new-collection" : "view-starred",
  });
}

async function removeLinkFlow(link, collection) {
  const index = collection.links.findIndex((l) => l.id === link.id);
  const neighbour = collection.links[index + 1] ?? collection.links[index - 1];
  await mutate((d) => removeLink(d, link.id), {
    success: `Removed ${link.title}`,
    focus: neighbour ? `link:${neighbour.id}` : `col-toggle:${collection.id}`,
  });
}

function openUrl(url, { background = false } = {}) {
  if (!isSavableUrl(url)) return;
  chrome.tabs.create({ url, active: !background });
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

function exportAll() {
  exportBackup(state);
  announce("All spaces exported");
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

// ------------------------------------------------------------------ search

function clearSearch({ silent = false, focus = false } = {}) {
  els.search.value = "";
  query = "";
  if (!silent) render();
  if (focus) els.search.focus();
}

// -------------------------------------------------------------------- wire

async function refreshTabs() {
  try {
    const [all, current] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
      chrome.windows.getCurrent(),
    ]);
    currentWindowId = current?.id ?? null;
    // Shelf's own pages (this dashboard, the side panel) aren't listed:
    // they can't be saved.
    const own = chrome.runtime.getURL("");
    windows = all
      .map((w) => ({ id: w.id, tabs: (w.tabs ?? []).filter((t) => !isShelfTab(t, own)) }))
      .filter((w) => w.tabs.length > 0 || w.id === currentWindowId)
      .sort((a, b) => (a.id === currentWindowId ? -1 : b.id === currentWindowId ? 1 : a.id - b.id));
  } catch (err) {
    console.error("Shelf: reading tabs failed", err);
    windows = [];
  }
  scheduleRender(TABS_ONLY);
}

// Only tab changes that alter what the column shows are worth a refresh;
// loading progress, audio and other updates are ignored.
function onTabUpdated(_tabId, change) {
  if ("title" in change || "url" in change || "favIconUrl" in change || change.status === "complete") refreshTabsSoon();
}

let tabsTimer = 0;
function refreshTabsSoon() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(refreshTabs, 150);
}

function wire() {
  $("search-icon").append(icon("search"));
  for (const [button, name, label, action] of [
    [els.sidebarClose, "panelLeft", "Collapse sidebar", toggleSidebar],
    [els.tabsClose, "panel", "Hide open tabs", toggleTabsPanel],
  ]) {
    button.append(icon(name));
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", action);
  }
  renderAccountButton();
  els.createSpace.title = "Create space";
  // In the rail the search box is just an icon: using it opens the sidebar.
  els.search.addEventListener("focus", () => {
    if (sidebarOpen || stackedQuery.matches) return;
    toggleSidebar();
    els.search.focus();
  });
  stackedQuery.addEventListener("change", () => render());
  els.accountBtn.addEventListener("click", () =>
    toggleMenu(els.accountBtn, accountMenuItems, { label: "Account", align: "start" }),
  );
  els.createSpace.append(icon("plus"), h("span", { class: "nav-label" }, "Create space"));
  els.createSpace.addEventListener("click", createSpaceFlow);

  let searchTimer = 0;
  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = els.search.value.trim();
      render();
    }, 120);
  });
  els.search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.search.value) {
      event.preventDefault();
      clearSearch();
    }
  });

  // Escape closes the open-tabs overlay on narrow windows.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tabsPanelOpen && overlayTabsQuery.matches && !overlayOpen()) {
      toggleTabsPanel();
    }
  });
  overlayTabsQuery.addEventListener("change", () => {
    tabsPanelOpen = !overlayTabsQuery.matches && readPref("shelf:tabsPanel") !== "closed";
    render();
  });

  // Customisable shortcuts (Settings). All use a modifier, so they also work
  // while a text field has focus. Ignored while a menu or dialog is open.
  document.addEventListener("keydown", (event) => {
    if (event.repeat || overlayOpen() || !state) return;
    const n = spaceNumber(shortcuts.spaces, event);
    let run = null;
    if (n) {
      const space = state.spaces[n - 1];
      if (space) run = () => openSpace(space.id);
    } else if (matches(shortcuts.settings, event)) run = showSettings;
    else if (matches(shortcuts.search, event)) run = focusSearch;
    else if (matches(shortcuts.sidebar, event)) run = toggleSidebar;
    else if (matches(shortcuts.tabs, event)) run = toggleTabsPanel;
    if (!run) return;
    event.preventDefault();
    run();
  });

  // "/" jumps to search from anywhere outside a text field.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || overlayOpen()) return;
    event.preventDefault();
    focusSearch();
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
  onOverlaySettled(flushRender);

  // Another Shelf page (or the right-click menu) saved. The new value comes
  // with the event; skip the redraw when it's our own save echoing back.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (ACCOUNT_KEY in changes || AUTH_KEY in changes)) reloadAccount();
    if (area === "local" && PROFILE_KEY in changes) {
      profile = sanitizeProfile(changes[PROFILE_KEY].newValue);
      renderAccountButton();
    }
  });
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !(STATE_KEY in changes)) return;
    const next = changes[STATE_KEY].newValue;
    const fresh = validateState(next).ok ? next : await loadState();
    if (JSON.stringify(fresh) === JSON.stringify(state)) return;
    state = fresh;
    scheduleRender({ board: true, tabs: false });
  });

  // Re-stack collections only when the number of columns actually changes.
  // The redraw changes the board's size, so it runs on the next frame, not
  // inside the observer callback (that triggers "ResizeObserver loop" errors).
  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (state && columnCount() !== lastColumnCount) scheduleRender({ board: true, tabs: false });
    });
  }).observe(els.boardBody);

  chrome.tabs.onUpdated.addListener(onTabUpdated);
  for (const event of [
    chrome.tabs.onCreated,
    chrome.tabs.onRemoved,
    chrome.tabs.onActivated,
    chrome.tabs.onMoved,
    chrome.tabs.onAttached,
    chrome.tabs.onDetached,
    chrome.windows.onCreated,
    chrome.windows.onRemoved,
  ]) {
    event.addListener(refreshTabsSoon);
  }
}

async function start() {
  try {
    wire();
    [state, account, profile] = await Promise.all([loadState(), readAccount(), readProfile(), refreshTabs()]);
    renderAccountButton();
    render();
    // Check the plan and invitations now and then; never blocks the page.
    if (account.signedIn && Date.now() - account.checkedAt > 10 * 60 * 1000) {
      refreshAccount().then(reloadAccount).catch((err) => console.warn("Shelf: account check failed", err));
    }
    if (account.signedIn) chrome.runtime.sendMessage({ type: "shelf:sync" }).catch(() => {});
  } catch (err) {
    console.error("Shelf: failed to load", err);
    els.main.removeAttribute("aria-busy");
    showError("Couldn't read your saved tabs from browser storage. Reload the page to try again.");
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
