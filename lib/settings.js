// Settings dialog for the dashboard: a list of pages on the left (tabs along
// the top on narrow screens) and one page at a time on the right. Pages:
// profile, appearance, keyboard shortcuts, plan, your data. The last page
// shown is remembered. Changes apply as they are made; there is no Save.
// Everything user-written (name, email) reaches the DOM only as text.

import { h, icon, isDarkTheme, setThemePref, switchMark } from "./ui.js";
import { CONFIG } from "./config.js";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  comboFromEvent,
  formatShortcut,
  keyParts,
  loadShortcuts,
  resetShortcuts,
  saveShortcuts,
  validateRecording,
} from "./shortcuts.js";
import { NAME_MAX, readProfile, saveProfile } from "./profile.js";
import { avatar, photoFromFile } from "./profile-ui.js";

const PAGE_KEY = "shelf:settings-page";
const PAGES = [
  { id: "profile", label: "Profile", iconName: "user" },
  { id: "appearance", label: "Appearance", iconName: "palette" },
  { id: "shortcuts", label: "Shortcuts", iconName: "keyboard" },
  // No plans during the launch period, so no Plan page (CONFIG.plansEnabled).
  CONFIG.plansEnabled ? { id: "plan", label: "Plan", iconName: "card" } : null,
  { id: "data", label: "Your data", iconName: "folder" },
].filter(Boolean);

function readPage() {
  try {
    const id = localStorage.getItem(PAGE_KEY);
    return PAGES.some((p) => p.id === id) ? id : "profile";
  } catch {
    return "profile";
  }
}

function writePage(id) {
  try {
    localStorage.setItem(PAGE_KEY, id);
  } catch {
    // Storage can be refused (private windows); the dialog opens on Profile.
  }
}

const keyCaps = (combo) => keyParts(combo).map((part) => h("kbd", {}, part));
const isDefault = (shortcuts) =>
  SHORTCUT_ACTIONS.every(({ id }) => formatShortcut(shortcuts[id]) === formatShortcut(DEFAULT_SHORTCUTS[id]));

// A setting: label (and optional hint) on the left, its control on the right.
function row(label, control, hint) {
  return h(
    "div",
    { class: "settings-row" },
    h("span", { class: "settings-text" }, h("span", { class: "settings-label" }, label), hint ? h("small", {}, hint) : null),
    control,
  );
}

// Opens the dialog. `page` picks the first page (else the last one used).
// `onShortcutsChange(shortcuts)` and `onProfileChange(profile)` run after
// each change so the page can redraw; `announce(text)` speaks status
// messages; `onClose()` runs once it has closed. `data` = { signedIn, email,
// plan, planText, onExport, onImport, onSignIn, onUpgrade,
// onManageSubscription, onDeleteAccountData }; each of those closes the
// dialog first, so its own dialog, tab or file picker opens on its own.
export async function openSettings({ page, onShortcutsChange, onProfileChange, announce, onClose, data }) {
  const dialog = document.getElementById("settings");
  let profile = await readProfile();
  let shortcuts = loadShortcuts();
  let recording = null; // { id, button }
  let current = PAGES.some((p) => p.id === page) ? page : readPage();

  const after = (fn) => () => {
    dialog.close();
    fn();
  };

  // --------------------------------------------------------------- profile
  const photoInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", hidden: true });
  const avatarSlot = h("span", { class: "profile-avatar" });
  const photoError = h("p", { class: "field-error", role: "alert", hidden: true });
  const removePhoto = h(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-sm",
      onClick: async () => {
        await updateProfile({ photo: null });
        announce("Photo removed");
        uploadPhoto.focus();
      },
    },
    "Remove",
  );
  const uploadPhoto = h("button", { type: "button", class: "btn btn-secondary btn-sm", onClick: () => photoInput.click() }, icon("upload"), "Upload photo");
  const nameInput = h("input", {
    type: "text",
    id: "settings-name",
    maxlength: String(NAME_MAX),
    autocomplete: "name",
    placeholder: data.email ? data.email.split("@")[0] : "Your name",
    "aria-describedby": "settings-name-hint",
  });
  nameInput.value = profile.name;
  const nameStatus = h("span", { class: "settings-saved", "aria-live": "polite" });
  let savedTimer = 0;

  async function updateProfile(patch) {
    profile = await saveProfile(patch);
    paintProfile();
    onProfileChange?.(profile);
  }
  function paintProfile() {
    avatarSlot.replaceChildren(avatar(profile, "avatar-xl", data.email));
    removePhoto.hidden = !profile.photo;
    uploadPhoto.lastChild.textContent = profile.photo ? "Change photo" : "Upload photo";
  }
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    photoInput.value = "";
    if (!file) return;
    photoError.hidden = true;
    try {
      await updateProfile({ photo: await photoFromFile(file) });
      announce("Photo updated");
    } catch (err) {
      photoError.textContent = err.message;
      photoError.hidden = false;
    }
  });
  const commitName = async () => {
    const name = nameInput.value.replace(/\s+/g, " ").trim();
    if (name === profile.name) return;
    await updateProfile({ name });
    nameInput.value = profile.name;
    nameStatus.replaceChildren(icon("check"), "Saved");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => nameStatus.replaceChildren(), 2000);
  };
  nameInput.addEventListener("change", commitName);
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitName();
    }
  });
  paintProfile();

  const profilePage = [
    h(
      "div",
      { class: "profile-head" },
      avatarSlot,
      h(
        "div",
        { class: "profile-photo" },
        h("span", { class: "settings-buttons" }, uploadPhoto, removePhoto),
        h("small", {}, "A square crop of it, shown only to you."),
        photoError,
        photoInput,
      ),
    ),
    h(
      "div",
      { class: "field" },
      h("span", { class: "field-label-row" }, h("label", { for: "settings-name" }, "Display name"), nameStatus),
      nameInput,
      h(
        "small",
        { class: "settings-hint", id: "settings-name-hint" },
        data.signedIn ? "Shown in the sidebar. Synced to every browser you sign in on." : "Shown in the sidebar. Sign in to keep it on every browser.",
      ),
    ),
    data.signedIn ? row("Email", h("span", { class: "settings-value" }, data.email ?? "Signed in")) : null,
  ];

  // ------------------------------------------------------------ appearance
  const darkSwitch = h(
    "button",
    {
      type: "button",
      role: "switch",
      class: "switch-btn",
      "aria-checked": String(isDarkTheme()),
      "aria-label": "Dark mode",
      onClick: () => {
        const dark = !isDarkTheme();
        setThemePref(dark ? "dark" : "light");
        darkSwitch.setAttribute("aria-checked", String(dark));
        announce(dark ? "Dark mode on" : "Dark mode off");
      },
    },
    switchMark(),
  );
  const appearancePage = [row("Dark mode", darkSwitch, "Easier on the eyes at night. Applies to every Shelf page.")];

  // ------------------------------------------------------------- shortcuts
  const scError = h("p", { class: "field-error settings-error", role: "alert", hidden: true });
  const showError = (text) => {
    scError.textContent = text ?? "";
    scError.hidden = !text;
  };
  const shortcutButtons = new Map();
  const reset = h(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-sm",
      onClick: () => {
        stopRecording();
        showError(null);
        shortcuts = resetShortcuts();
        SHORTCUT_ACTIONS.forEach(({ id }) => paintKey(id));
        refreshReset();
        onShortcutsChange(shortcuts);
        announce("Shortcuts reset");
      },
    },
    icon("refresh"),
    "Reset to defaults",
  );
  const refreshReset = () => {
    reset.disabled = isDefault(shortcuts);
    reset.title = reset.disabled ? "Already using the default keys" : "";
  };

  function paintKey(id) {
    const button = shortcutButtons.get(id);
    const { label } = SHORTCUT_ACTIONS.find((a) => a.id === id);
    button.classList.remove("is-recording");
    button.replaceChildren(...keyCaps(shortcuts[id]), icon("edit", "kbd-edit"));
    button.setAttribute("aria-label", `${label}: ${formatShortcut(shortcuts[id])}. Change shortcut`);
  }
  function stopRecording() {
    if (!recording) return;
    const { id } = recording;
    recording = null;
    paintKey(id);
  }
  function startRecording(id) {
    stopRecording();
    showError(null);
    const button = shortcutButtons.get(id);
    const { label, modifiersOnly } = SHORTCUT_ACTIONS.find((a) => a.id === id);
    recording = { id, button };
    button.classList.add("is-recording");
    button.replaceChildren(h("span", { class: "kbd-listening" }), h("span", {}, modifiersOnly ? "Press modifier + 1" : "Press keys…"));
    button.setAttribute("aria-label", `Press the new shortcut for ${label}. Escape cancels`);
  }
  function onRecordKey(event, id) {
    if (recording?.id !== id) return;
    if (event.key === "Tab") return stopRecording();
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") return stopRecording();
    const raw = comboFromEvent(event);
    if (!raw) return; // still holding modifiers
    const result = validateRecording(id, raw, shortcuts);
    if (result.error) {
      showError(result.error);
      return stopRecording();
    }
    shortcuts = { ...shortcuts, [id]: result.combo };
    saveShortcuts(shortcuts);
    stopRecording();
    refreshReset();
    onShortcutsChange(shortcuts);
    announce(`${SHORTCUT_ACTIONS.find((a) => a.id === id).label}: ${formatShortcut(result.combo)}`);
  }
  const shortcutRows = SHORTCUT_ACTIONS.map(({ id, label }) => {
    const button = h("button", {
      type: "button",
      class: "kbd-btn",
      "aria-describedby": "settings-sc-hint",
      onClick: () => (recording?.id === id ? stopRecording() : startRecording(id)),
      onKeydown: (event) => onRecordKey(event, id),
      onBlur: () => recording?.id === id && stopRecording(),
    });
    shortcutButtons.set(id, button);
    return h("li", { class: "settings-row" }, h("span", { class: "settings-label" }, label), button);
  });
  const shortcutsPage = [
    h("p", { class: "settings-intro", id: "settings-sc-hint" }, "Select a shortcut, then press the new keys. Esc cancels."),
    h("ul", { class: "settings-list" }, shortcutRows),
    scError,
    h("div", { class: "settings-page-foot" }, reset),
  ];

  // ------------------------------------------------------------------ plan
  const isPro = data.plan === "pro";
  const planPage = data.signedIn
    ? [
        h(
          "div",
          { class: `plan-card${isPro ? " is-pro" : ""}` },
          h("span", { class: "plan-card-icon" }, icon(isPro ? "sparkle" : "star")),
          h(
            "span",
            { class: "settings-text" },
            h("span", { class: "settings-label" }, isPro ? "Shelf Pro" : "Free plan"),
            h("small", {}, isPro ? data.planText || "Thanks for supporting Shelf." : "More shelves and sharing come with Pro."),
          ),
          isPro
            ? h("button", { type: "button", class: "btn btn-secondary btn-sm", onClick: after(data.onManageSubscription) }, "Manage subscription")
            : h("button", { type: "button", class: "btn btn-primary btn-sm", onClick: after(data.onUpgrade) }, icon("sparkle"), "Upgrade"),
        ),
        h(
          "p",
          { class: "settings-hint" },
          isPro ? "Change your card, download invoices or cancel on Paddle's billing page." : "You can keep using Shelf for free as long as you like.",
        ),
      ]
    : [
        row(
          "Not signed in",
          h("button", { type: "button", class: "btn btn-secondary btn-sm", onClick: after(data.onSignIn) }, icon("login"), "Sign in"),
          "Sign in to upgrade, share spaces and sync.",
        ),
      ];

  // -------------------------------------------------------------- your data
  const dataPage = [
    row(
      "Backup file",
      h(
        "span",
        { class: "settings-buttons", role: "group", "aria-label": "Backup file" },
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: after(data.onImport) }, icon("upload"), "Import"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: after(data.onExport) }, icon("download"), "Export"),
      ),
      "A .json copy of every space. Importing adds to what's here.",
    ),
    row(
      "Sync",
      data.signedIn
        ? h("span", { class: "settings-status" }, h("span", { class: "settings-dot", "aria-hidden": "true" }), "On")
        : h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: after(data.onSignIn) }, "Sign in"),
      data.signedIn
        ? "Spaces and profile sync across your browsers."
        : "Sign in to sync across browsers.",
    ),
    data.signedIn
      ? h(
          "div",
          { class: "settings-danger" },
          row(
            "Delete account data",
            h("button", { type: "button", class: "btn btn-danger btn-sm", onClick: after(data.onDeleteAccountData) }, "Delete…"),
            "Erases your data from Shelf's server. This browser keeps its copy.",
          ),
        )
      : null,
  ];

  // ------------------------------------------------------------ the layout
  const bodies = { profile: profilePage, appearance: appearancePage, shortcuts: shortcutsPage, plan: planPage, data: dataPage };
  const tabs = new Map();
  const panels = new Map();
  for (const p of PAGES) {
    const tab = h(
      "button",
      {
        type: "button",
        role: "tab",
        id: `settings-tab-${p.id}`,
        class: "settings-tab",
        "aria-controls": `settings-panel-${p.id}`,
        onClick: () => show(p.id, { focusTab: false }),
      },
      icon(p.iconName),
      h("span", {}, p.label),
    );
    tabs.set(p.id, tab);
    panels.set(
      p.id,
      h(
        "section",
        { role: "tabpanel", id: `settings-panel-${p.id}`, class: "settings-panel", "aria-labelledby": `settings-tab-${p.id}`, tabindex: "-1" },
        h("h3", { class: "settings-page-title" }, p.id === "shortcuts" ? "Keyboard shortcuts" : p.label),
        ...bodies[p.id].filter(Boolean),
      ),
    );
  }

  function show(id, { focusTab = false } = {}) {
    stopRecording();
    current = id;
    writePage(id);
    for (const [pid, tab] of tabs) {
      const on = pid === id;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      panels.get(pid).hidden = !on;
    }
    tabs.get(id).scrollIntoView({ block: "nearest", inline: "nearest" }); // top bar on narrow screens
    if (focusTab) tabs.get(id).focus();
  }

  // Arrow keys move between pages (up/down, or left/right in the top bar).
  const nav = h(
    "div",
    {
      role: "tablist",
      class: "settings-nav",
      "aria-label": "Settings pages",
      "aria-orientation": "vertical",
      onKeydown: (event) => {
        const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
        let i = PAGES.findIndex((p) => p.id === current);
        if (event.key in keys) i = (i + keys[event.key] + PAGES.length) % PAGES.length;
        else if (event.key === "Home") i = 0;
        else if (event.key === "End") i = PAGES.length - 1;
        else return;
        event.preventDefault();
        show(PAGES[i].id, { focusTab: true });
      },
    },
    ...tabs.values(),
  );

  dialog.replaceChildren(
    h(
      "div",
      { class: "settings-head" },
      h("h2", { class: "dialog-title", id: "settings-title" }, "Settings"),
      h(
        "button",
        { type: "button", class: "icon-btn", "aria-label": "Close settings", title: "Close", onClick: () => dialog.close() },
        icon("close"),
      ),
    ),
    h("div", { class: "settings-layout" }, nav, h("div", { class: "settings-panels" }, ...panels.values())),
  );
  SHORTCUT_ACTIONS.forEach(({ id }) => paintKey(id));
  refreshReset();
  show(current);

  const returnFocus = document.activeElement;
  dialog.addEventListener(
    "close",
    () => {
      recording = null;
      clearTimeout(savedTimer);
      if (nameInput.value.trim() !== profile.name) commitName();
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
      onClose?.();
    },
    { once: true },
  );
  dialog.showModal();
  if (page === "profile") nameInput.focus();
  else tabs.get(current).focus();
}
