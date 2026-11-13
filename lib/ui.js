// Shared UI helpers for the side panel and the new-tab dashboard.
// All user data reaches the DOM through textContent / attributes, never HTML.

import { cleanText } from "./store.js";

// ------------------------------------------------------------------ basics

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preference just won't persist; nothing else depends on it.
  }
}

// Static icon paths (trusted constants, 16px grid, 1.5 stroke).
const ICON_PATHS = {
  chevron: '<path d="M6 4l4 4-4 4"/>',
  more: '<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  settings:
    '<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>',
  save: '<path d="M4 2.5h8v11l-4-2.75-4 2.75z"/>',
  move: '<path d="M2.5 8h10M9.5 5l3 3-3 3"/>',
  openAll: '<path d="M9.5 2.5h4v4M13.5 2.5L8 8M6.5 3.5h-3v9h9v-3"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  star: '<path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5z"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
  space: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M2.5 6.5h11"/>',
  upload: '<path d="M8 10.5v-8M5 5.5l3-3 3 3M3 10.5v3h10v-3"/>',
  download: '<path d="M8 2.5v8M5 7.5l3 3 3-3M3 10.5v3h10v-3"/>',
  sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 116.5 3a4.5 4.5 0 006.5 6.5z"/>',
  monitor: '<rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M6 13.5h4M8 11v2.5"/>',
  panel: '<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M10 2.5v11"/>',
  panelLeft: '<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/>',
  rows: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  layout: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  chevronDown: '<path d="M4 6l4 4 4-4"/>',
  selector: '<path d="M5.5 6.5L8 4l2.5 2.5M5.5 9.5L8 12l2.5-2.5"/>',
  window: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6h12"/>',
  folder: '<path d="M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1z"/>',
  note: '<path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12M6 8h4M6 10.5h4"/>',
  home: '<path d="M2.5 7.5L8 2.5l5.5 5V13h-3.5V9.5H6V13H2.5z"/>',
  briefcase: '<rect x="2" y="5" width="12" height="8" rx="1.5"/><path d="M6 5V3.5h4V5M2 8.5h12"/>',
  book: '<path d="M3 3h7a2 2 0 012 2v8H5a2 2 0 01-2-2z"/><path d="M3 11a2 2 0 012-2h7"/>',
  code: '<path d="M5.5 5l-3 3 3 3M10.5 5l3 3-3 3M9 3.5l-2 9"/>',
  heart: '<path d="M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 018 5a2.7 2.7 0 015.5 1.2C13.5 10 8 13.5 8 13.5z"/>',
  globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.8 1.6 2.6 3.4 2.6 5.5S9.8 11.9 8 13.5C6.2 11.9 5.4 10 5.4 8S6.2 4.1 8 2.5z"/>',
  music: '<path d="M6 11.5V4l7-1.5V10"/><circle cx="4.5" cy="11.5" r="1.5"/><circle cx="11.5" cy="10" r="1.5"/>',
  camera: '<path d="M2.5 5.5h2l1-1.5h5l1 1.5h2v7h-11z"/><circle cx="8" cy="8.8" r="2.2"/>',
  cart: '<path d="M2 3h2l1.3 6.5h6.4L13 5H4.6"/><circle cx="6" cy="12.3" r=".8"/><circle cx="11" cy="12.3" r=".8"/>',
  game: '<rect x="2" y="5" width="12" height="7" rx="3"/><path d="M5.5 7v3M4 8.5h3M10.5 8h.01M12 9.5h.01"/>',
  plane: '<path d="M13.5 2.5L2.5 7l4 2 2 4z"/><path d="M6.5 9l7-6.5"/>',
  school: '<path d="M1.5 6L8 3l6.5 3L8 9z"/><path d="M4 7.5v3c0 1 1.8 2 4 2s4-1 4-2v-3"/>',
  bolt: '<path d="M9 2L3.5 9H8l-1 5 5.5-7H8z"/>',
  flask: '<path d="M6.5 2.5h3M7 2.5v4L3.5 12a1 1 0 00.9 1.5h7.2a1 1 0 00.9-1.5L9 6.5v-4"/>',
  palette: '<path d="M8 2.5a5.5 5.5 0 100 11c1 0 1.3-.7.9-1.4-.5-.9 0-1.9 1-1.9H12a1.5 1.5 0 001.5-1.5C13.5 4.8 11 2.5 8 2.5z"/><circle cx="5.2" cy="7" r=".5"/><circle cx="8" cy="5" r=".5"/><circle cx="10.8" cy="7" r=".5"/>',
  users: '<circle cx="6" cy="5.5" r="2.25"/><path d="M2 13c.4-2.2 1.9-3.5 4-3.5s3.6 1.3 4 3.5M10.5 3.6a2.2 2.2 0 010 3.9M11.5 9.7c1.3.4 2.2 1.6 2.5 3.3"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 4.5L8 8.5l5.5-4"/>',
  refresh: '<path d="M13 8a5 5 0 11-1.5-3.5M13 2.5V5h-2.5"/>',
  sparkle: '<path d="M8 2.5l1.2 3.3 3.3 1.2-3.3 1.2L8 11.5 6.8 8.2 3.5 7l3.3-1.2z"/><path d="M12.5 11v3M11 12.5h3"/>',
  login: '<path d="M9.5 2.5h3v11h-3M2.5 8H10M7.5 5.5L10 8l-2.5 2.5"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.5-2.5 2.5-4 5-4s4.5 1.5 5 4"/>',
  logout: '<path d="M6.5 2.5h-3v11h3M6 8h7.5M11 5.5L13.5 8 11 10.5"/>',
  shield: '<path d="M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z"/>',
  bell: '<path d="M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14h3"/>',
  help: '<circle cx="8" cy="8" r="5.5"/><path d="M6.3 6.5a1.8 1.8 0 113 1.2c-.8.5-1.3.9-1.3 1.8M8 11.3h.01"/>',
  edit: '<path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.75h.01M6.67 6.75h.01M9.33 6.75h.01M12 6.75h.01M5 9.5h6"/>',
  card: '<rect x="2" y="3.5" width="12" height="9" rx="2"/><path d="M2 6.5h12M4.5 10h2"/>',
  link: '<path d="M7 9a2.5 2.5 0 003.5 0l2-2A2.5 2.5 0 009 3.5l-.5.5M9 7a2.5 2.5 0 00-3.5 0l-2 2A2.5 2.5 0 007 12.5l.5-.5"/>',
};

export function icon(name, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon ${extraClass}`.trim());
  // ICON_PATHS is fixed markup above, never user input. Parsing it as SVG
  // keeps this inert and store-linter friendly.
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${ICON_PATHS[name] || ""}</svg>`,
    "image/svg+xml",
  );
  for (const node of [...parsed.documentElement.childNodes]) svg.appendChild(document.importNode(node, true));
  return svg;
}

// Site icons come from the browser's own icon cache via the `favicon`
// permission, so pages never contact the saved sites. For a site the browser
// has no icon for, the cache returns a generic globe; we detect that by
// comparing pixels with the icon it returns for a made-up address, and show a
// folder instead.

const faviconUrl = (pageUrl) =>
  chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);

// Firefox has no icon cache for extensions (the build drops the `favicon`
// permission), so it shows the folder icon without requesting anything.
const hasIconCache = (() => {
  try {
    return chrome.runtime.getManifest().permissions.includes("favicon");
  } catch {
    return true;
  }
})();

function pixelKey(img) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 16, 16);
  return ctx.getImageData(0, 0, 16, 16).data.join(",");
}

let defaultIconKey = null;
function genericIconKey() {
  defaultIconKey ??= new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => {
      try {
        resolve(pixelKey(probe));
      } catch {
        resolve(null);
      }
    };
    probe.onerror = () => resolve(null);
    probe.src = faviconUrl("https://shelf-no-icon.invalid/");
  });
  return defaultIconKey;
}

const iconByHost = new Map(); // host -> "site" | "generic"

export function favicon(pageUrl) {
  const fallback = () => icon("folder", "favicon favicon-fallback");
  if (!hasIconCache) return fallback();
  let host = "";
  try {
    host = new URL(pageUrl).host;
  } catch {
    return fallback();
  }
  if (iconByHost.get(host) === "generic") return fallback();

  const img = h("img", { class: "favicon", src: faviconUrl(pageUrl), alt: "", width: 16, height: 16 });
  if (iconByHost.get(host) === "site") return img;

  // First sighting of this site on the page: fade the icon in once it has
  // loaded instead of popping. Known sites (every later redraw) show at once.
  img.classList.add("is-loading");
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
  img.addEventListener(
    "load",
    async () => {
      img.classList.remove("is-loading");
      try {
        const generic = await genericIconKey();
        const isGeneric = generic !== null && pixelKey(img) === generic;
        iconByHost.set(host, isGeneric ? "generic" : "site");
        if (isGeneric && img.isConnected) img.replaceWith(fallback());
      } catch {
        // Can't read pixels: keep whatever the browser gave us.
      }
    },
    { once: true },
  );
  return img;
}

export function createAnnouncer(el) {
  return (message) => {
    el.textContent = "";
    // Clear, then set on the next task, so a repeated message is still read out.
    setTimeout(() => (el.textContent = message), 50);
  };
}

// Wraps store `update` for a page: saves, hands the new state back, announces
// success, picks the element to focus next, and turns failures into a message.
export function createMutator(update, { setState, announce, showError, hideError, setFocus, scheduleRender, onPlanLimit }) {
  return async function mutate(mutator, { success, focus } = {}) {
    try {
      const { state, result } = await update(mutator);
      setState(state);
      if (focus !== undefined) setFocus(typeof focus === "function" ? focus(result) : focus);
      if (success) announce(typeof success === "function" ? success(result) : success);
      hideError();
      scheduleRender();
      return result;
    } catch (err) {
      if (err?.name === "PlanLimitError" && onPlanLimit) {
        onPlanLimit(err);
        return undefined;
      }
      console.error("Shelf:", err);
      showError(
        err instanceof Error && (err.name === "PlanLimitError" || err.name === "ReadOnlyError" || /full|limit|empty|least one/i.test(err.message))
          ? `${err.message}.`
          : "Couldn't save that change. Browser storage refused it. Try again.",
      );
      return undefined;
    }
  };
}

// ------------------------------------------------------------------- theme

const colorQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function themePref() {
  return readPref("shelf:theme") || "system";
}

export function applyTheme() {
  const pref = themePref();
  const dark = pref === "dark" || (pref === "system" && colorQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function setThemePref(value) {
  writePref("shelf:theme", value);
  applyTheme();
}

export function isDarkTheme() {
  return document.documentElement.dataset.theme === "dark";
}

// The track-and-thumb mark of an on/off switch. The control around it carries
// role="switch" (or menuitemcheckbox) and aria-checked; CSS reads that state.
export function switchMark() {
  return h("span", { class: "switch", "aria-hidden": "true" }, h("span", { class: "switch-thumb" }));
}

// Keeps every open Shelf page on the same theme.
export function watchTheme(onChange) {
  colorQuery.addEventListener("change", () => {
    applyTheme();
    onChange?.();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "shelf:theme") {
      applyTheme();
      onChange?.();
    }
  });
}

// --------------------------------------------------------------- overlays

// Pages defer re-renders while a menu or dialog is open, then catch up here.
const settledListeners = new Set();
export function onOverlaySettled(fn) {
  settledListeners.add(fn);
}
function settled() {
  settledListeners.forEach((fn) => fn());
}

export function overlayOpen() {
  return Boolean(openMenuState) || Boolean(document.querySelector("dialog[open]"));
}

// ------------------------------------------------------------------ dialog

let dialog = null;
function dialogEls() {
  if (dialog) return dialog;
  const $ = (id) => document.getElementById(id);
  dialog = {
    el: $("dialog"),
    form: $("dialog-form"),
    title: $("dialog-title"),
    body: $("dialog-body"),
    field: $("dialog-field"),
    label: $("dialog-label"),
    input: $("dialog-input"),
    error: $("dialog-error"),
    secondField: $("dialog-second-field"),
    secondLabel: $("dialog-second-label"),
    second: $("dialog-second"),
    secondError: $("dialog-second-error"),
    areaField: $("dialog-area-field"),
    areaLabel: $("dialog-area-label"),
    area: $("dialog-area"),
    checkWrap: $("dialog-check-wrap"),
    check: $("dialog-check"),
    checkLabel: $("dialog-check-label"),
    cancel: $("dialog-cancel"),
    confirm: $("dialog-confirm"),
  };
  return dialog;
}

// Opens the shared modal. Resolves with { value, areaValue, checked } or null
// if cancelled. `validate(value)` returns an error message or null.
// `area: { label, value, maxLength }` adds a multi-line field (notes).
// `second: { label, value, maxLength, placeholder, normalize(text) }` adds a
// second single-line field (a web address). `normalize` returns the cleaned
// value or null if it is invalid; the result comes back as `secondValue`.
export function ask({
  area,
  title,
  body,
  label,
  value = "",
  confirmLabel,
  danger = false,
  checkbox,
  cancel = true,
  maxLength = 80,
  inputMode = "text",
  placeholder = "",
  emptyMessage = "Enter a name.",
  validate,
  anchor,
  second,
}) {
  const d = dialogEls();
  d.title.textContent = title;
  d.body.hidden = !body;
  d.body.textContent = body ?? "";
  d.field.hidden = !label;
  d.label.textContent = label ?? "";
  d.input.value = value;
  d.input.maxLength = maxLength;
  d.input.inputMode = inputMode;
  d.input.placeholder = placeholder;
  d.input.removeAttribute("aria-invalid");
  d.error.hidden = true;
  d.secondField.hidden = !second;
  d.secondLabel.textContent = second?.label ?? "";
  d.second.value = second?.value ?? "";
  d.second.maxLength = second?.maxLength ?? 2048;
  d.second.placeholder = second?.placeholder ?? "";
  d.second.removeAttribute("aria-invalid");
  d.secondError.hidden = true;
  d.el.classList.toggle("is-wide", Boolean(area));
  if (d.areaField) {
    d.areaField.hidden = !area;
    d.areaLabel.textContent = area?.label ?? "";
    d.area.value = area?.value ?? "";
    d.area.maxLength = area?.maxLength ?? 10000;
  }
  d.checkWrap.hidden = !checkbox;
  d.checkLabel.textContent = checkbox ?? "";
  d.check.checked = false;
  d.cancel.hidden = !cancel;
  d.confirm.textContent = confirmLabel;
  d.confirm.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;

  const returnFocus = document.activeElement;
  // Cleared here rather than on close, so a closing popover fades out where
  // it stood instead of jumping to the centre.
  clearPlacement(d.el);
  d.el.showModal();
  // With an anchor, the dialog floats beside that button instead of centring.
  if (anchor?.isConnected) placeNear(d.el, anchor);
  if (label) d.input.select();
  else (cancel ? d.cancel : d.confirm).focus();

  // Resolves directly from submit / cancel / Escape. The async `close` event is
  // only a fallback (some embedded browsers delay or drop it).
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      d.form.removeEventListener("submit", onSubmit);
      d.cancel.removeEventListener("click", onDismiss);
      d.el.removeEventListener("cancel", onDismiss);
      d.el.removeEventListener("close", onDismiss);
      if (d.el.open) d.el.close();
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
      resolve(result);
      settled();
    };
    function onSubmit(event) {
      event.preventDefault();
      const text = cleanText(d.input.value, maxLength);
      const problem = label ? (!text ? emptyMessage : validate?.(text) ?? null) : null;
      if (problem) {
        d.input.setAttribute("aria-invalid", "true");
        d.error.textContent = problem;
        d.error.hidden = false;
        d.input.focus();
        return;
      }
      let secondValue;
      if (second) {
        secondValue = second.normalize(d.second.value);
        if (!secondValue) {
          d.second.setAttribute("aria-invalid", "true");
          d.secondError.textContent = second.invalidMessage ?? "Enter a valid value.";
          d.secondError.hidden = false;
          d.second.focus();
          return;
        }
      }
      finish({
        value: text,
        areaValue: area && d.area ? d.area.value : undefined,
        secondValue,
        checked: d.check.checked,
      });
    }
    const onDismiss = () => finish(null);
    d.form.addEventListener("submit", onSubmit);
    d.cancel.addEventListener("click", onDismiss);
    d.el.addEventListener("cancel", onDismiss);
    d.el.addEventListener("close", onDismiss);
  });
}

function placeNear(el, anchor) {
  el.classList.add("is-popover");
  const a = anchor.getBoundingClientRect();
  const r = { width: el.offsetWidth, height: el.offsetHeight }; // unscaled size
  const left = Math.max(8, Math.min(a.right - r.width, window.innerWidth - r.width - 8));
  const below = a.bottom + 8;
  const top = below + r.height > window.innerHeight - 8 ? Math.max(8, a.top - r.height - 8) : below;
  el.style.setProperty("left", `${left}px`);
  el.style.setProperty("top", `${top}px`);
  el.style.setProperty("transform-origin", `right ${top < a.top ? "bottom" : "top"}`);
}

function clearPlacement(el) {
  el.classList.remove("is-popover");
  el.style.removeProperty("left");
  el.style.removeProperty("top");
  el.style.removeProperty("transform-origin");
}

// Note editor on top of `ask`. Resolves with { title, body } or null.
export async function askNote({ heading, title = "", body = "", confirmLabel }) {
  const answer = await ask({
    title: heading,
    label: "Title",
    value: title,
    maxLength: 300,
    emptyMessage: "Enter a title.",
    area: { label: "Note", value: body, maxLength: 10000 },
    confirmLabel,
  });
  return answer ? { title: answer.value, body: answer.areaValue ?? "" } : null;
}

// -------------------------------------------------------------------- menu

let openMenuState = null;

// items: [{ label, onSelect, checked?, swatch?, danger?, disabled?, disabledReason?,
//            shortcut? (key hint shown on the right),
//            toggle? (boolean: an on/off switch; onSelect returns the new value
//                     and the menu stays open) } | "separator"]
// options: { label, align: "end" (default, menu's right edge meets the button's) | "start" }
export function openMenu(anchor, items, { label, align = "end" } = {}) {
  closeMenu();
  const list = h("ul", { class: "menu", role: "menu", "aria-label": label ?? anchor.getAttribute("aria-label") });
  for (const item of items) {
    if (item === "separator") {
      list.append(h("li", { class: "menu-sep", role: "separator" }));
      continue;
    }
    if (item.node) {
      list.append(h("li", { class: "menu-custom", role: "none" }, item.node));
      continue;
    }
    if (item.heading) {
      list.append(h("li", { class: "menu-heading", role: "presentation" }, item.heading));
      continue;
    }
    const radio = item.checked !== undefined;
    const toggle = item.toggle !== undefined;
    const btn = h(
      "button",
      {
        type: "button",
        class: `menu-item${item.danger ? " is-danger" : ""}`,
        role: toggle ? "menuitemcheckbox" : radio ? "menuitemradio" : "menuitem",
        tabindex: "-1",
        "aria-checked": toggle ? String(item.toggle) : radio ? String(item.checked) : null,
        "aria-label": item.ariaLabel ?? null,
        "aria-disabled": item.disabled ? "true" : null,
        "aria-keyshortcuts": item.keyshortcuts ?? null,
        title: item.disabledReason ?? null,
        onClick: (event) => {
          if (item.disabled) return;
          if (toggle) {
            event.currentTarget.setAttribute("aria-checked", String(Boolean(item.onSelect())));
            return;
          }
          closeMenu({ restoreFocus: true });
          item.onSelect();
        },
      },
      radio ? h("span", { class: "check-mark" }, item.checked ? icon("check") : null) : null,
      item.swatch ? h("span", { class: `swatch swatch-${item.swatch}`, "aria-hidden": "true" }) : null,
      item.iconName ? icon(item.iconName, "menu-icon") : null,
      h("span", { class: "menu-label" }, item.label),
      item.shortcut ? h("kbd", { class: "menu-kbd", "aria-hidden": "true" }, item.shortcut) : null,
      toggle ? switchMark() : null,
      item.more ? icon("chevron", "menu-more") : null,
    );
    list.append(h("li", { role: "none" }, btn));
  }
  document.body.append(list);

  const rect = anchor.getBoundingClientRect();
  // Its real size: the opening animation starts slightly scaled down, and a
  // scaled measurement would place the menu over its own button.
  const menuRect = { width: list.offsetWidth, height: list.offsetHeight };
  const wanted = align === "start" ? rect.left : rect.right - menuRect.width;
  const left = Math.min(wanted, window.innerWidth - menuRect.width - 8);
  const below = rect.bottom + 4;
  const top = below + menuRect.height > window.innerHeight ? Math.max(8, rect.top - menuRect.height - 4) : below;
  list.style.left = `${Math.max(8, left)}px`;
  list.style.top = `${top}px`;
  // Grow out of the corner nearest the button.
  list.style.transformOrigin = `${align === "start" ? "left" : "right"} ${top < rect.top ? "bottom" : "top"}`;

  anchor.setAttribute("aria-expanded", "true");
  const buttons = [...list.querySelectorAll(".menu-item, [data-menu-nav]")];
  const focusAt = (i) => buttons[(i + buttons.length) % buttons.length]?.focus();
  focusAt(Math.max(0, buttons.findIndex((b) => b.getAttribute("aria-checked") === "true")));

  list.addEventListener("keydown", (event) => {
    const i = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown") focusAt(i + 1);
    else if (event.key === "ArrowUp") focusAt(i - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(buttons.length - 1);
    else if (event.key === "Escape") closeMenu({ restoreFocus: true });
    else if (event.key === "Tab") closeMenu();
    else return;
    event.preventDefault();
  });
  const onOutside = (event) => {
    if (!list.contains(event.target) && !anchor.contains(event.target)) closeMenu();
  };
  document.addEventListener("pointerdown", onOutside, true);
  openMenuState = { list, anchor, onOutside };
}

export function closeMenu({ restoreFocus = false } = {}) {
  if (!openMenuState) return;
  const { list, anchor, onOutside } = openMenuState;
  openMenuState = null;
  document.removeEventListener("pointerdown", onOutside, true);
  list.remove();
  anchor.setAttribute("aria-expanded", "false");
  if (restoreFocus && anchor.isConnected) anchor.focus();
  settled();
}

export function toggleMenu(anchor, buildItems, options) {
  if (openMenuState?.anchor === anchor) closeMenu({ restoreFocus: true });
  else openMenu(anchor, buildItems(), options);
}

// ------------------------------------------------------------ drag & drop

export const DRAG_MIME = "application/x-shelf";

// Where a drop at (x, y) lands among `items` (elements in reading order).
// "list" = one column, split rows at their vertical middle.
// "grid" = wrapping rows, split cards at their horizontal middle.
export function dropIndex(items, x, y, layout = "list") {
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (layout === "list") {
      if (y < r.top + r.height / 2) return { index: i, before: items[i] };
    } else {
      if (y < r.top) return { index: i, before: items[i] };
      if (y <= r.bottom && x < r.left + r.width / 2) return { index: i, before: items[i] };
    }
  }
  return { index: items.length, before: null };
}

// First web address in a text/uri-list payload (links dragged in from pages).
export function uriFromDrop(dataTransfer) {
  return dataTransfer
    .getData("text/uri-list")
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith("#"));
}
