// Keyboard shortcuts for the dashboard: defaults, validation, matching and
// display. Stored as a display preference (localStorage "shelf:shortcuts"),
// like theme and layout, and re-validated on every read.
//
// A combo is { code, alt, ctrl, shift, meta }. `code` is KeyboardEvent.code,
// so shortcuts follow the physical key and work on any keyboard layout (and
// with Option on a Mac, where the typed character changes).
// The "spaces" action has no code: its modifiers plus 1–9 pick a space.

import { readPref, writePref } from "./ui.js";

const PREF = "shelf:shortcuts";

export const SHORTCUT_ACTIONS = [
  { id: "settings", label: "Open settings" },
  { id: "search", label: "Search" },
  { id: "sidebar", label: "Toggle sidebar" },
  { id: "tabs", label: "Toggle open tabs" },
  { id: "spaces", label: "Go to space 1–9", modifiersOnly: true },
];

// Alt-based defaults: browsers leave Alt + letter/punctuation to the page.
export const DEFAULT_SHORTCUTS = Object.freeze({
  settings: { code: "Comma", alt: true, ctrl: false, shift: false, meta: false },
  search: { code: "KeyK", alt: true, ctrl: false, shift: false, meta: false },
  sidebar: { code: "BracketLeft", alt: true, ctrl: false, shift: false, meta: false },
  tabs: { code: "BracketRight", alt: true, ctrl: false, shift: false, meta: false },
  spaces: { code: null, alt: true, ctrl: false, shift: false, meta: false },
});

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const CODE_LABELS = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

const CODE_PATTERN = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/;

// Combos the browser handles before the page sees them, so they can't work.
const BROWSER_KEYS = new Set(["KeyT", "KeyW", "KeyN", "KeyQ", "KeyL", "KeyR", "KeyH", "KeyJ", "KeyD", "KeyP", "Tab"]);

function clean(combo, modifiersOnly) {
  if (!combo || typeof combo !== "object") return null;
  const out = {
    code: modifiersOnly ? null : combo.code,
    alt: combo.alt === true,
    ctrl: combo.ctrl === true,
    shift: combo.shift === true,
    meta: combo.meta === true,
  };
  if (!modifiersOnly && (typeof out.code !== "string" || !CODE_PATTERN.test(out.code))) return null;
  return problemWith(out, modifiersOnly) ? null : out;
}

// Why a combo can't be used on its own, or null.
function problemWith(combo, modifiersOnly) {
  const isFunctionKey = /^F\d+$/.test(combo.code ?? "");
  if (!combo.alt && !combo.ctrl && !combo.meta && !isFunctionKey) {
    return modifiersOnly
      ? "Use Alt, Ctrl or ⌘ with the numbers, so typing a number never switches spaces."
      : "Add Alt, Ctrl or ⌘, so the shortcut never fires while you type.";
  }
  if (modifiersOnly && (combo.ctrl || combo.meta) && !combo.alt && !combo.shift) {
    return "Your browser keeps Ctrl or ⌘ plus a number for switching tabs.";
  }
  if (!modifiersOnly && (combo.ctrl || combo.meta) && !combo.alt && BROWSER_KEYS.has(combo.code)) {
    return "Your browser keeps this shortcut for itself.";
  }
  if (!modifiersOnly && combo.alt && !combo.ctrl && !combo.meta && ["KeyF", "KeyE"].includes(combo.code)) {
    return "Alt+F and Alt+E open the browser menu.";
  }
  return null;
}

export function loadShortcuts() {
  let stored = {};
  try {
    const parsed = JSON.parse(readPref(PREF) || "{}");
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {
    // Corrupt preference: fall back to defaults.
  }
  const result = {};
  for (const { id, modifiersOnly } of SHORTCUT_ACTIONS) {
    result[id] = clean(stored[id], modifiersOnly) ?? { ...DEFAULT_SHORTCUTS[id] };
  }
  return result;
}

export function saveShortcuts(shortcuts) {
  writePref(PREF, JSON.stringify(shortcuts));
}

export function resetShortcuts() {
  writePref(PREF, "");
  return loadShortcuts();
}

// Builds a combo from a keydown, or null while only modifiers are held.
export function comboFromEvent(event) {
  if (["Alt", "Control", "Shift", "Meta", "AltGraph", "CapsLock"].includes(event.key)) return null;
  return { code: event.code, alt: event.altKey, ctrl: event.ctrlKey, shift: event.shiftKey, meta: event.metaKey };
}

function sameModifiers(a, b) {
  return a.alt === b.alt && a.ctrl === b.ctrl && a.shift === b.shift && a.meta === b.meta;
}

export function matches(combo, event) {
  return combo.code === event.code && sameModifiers(combo, comboFromEvent(event) ?? {});
}

// 1–9 when the event is the spaces combo, otherwise 0.
export function spaceNumber(spacesCombo, event) {
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (!digit) return 0;
  return sameModifiers(spacesCombo, comboFromEvent(event) ?? {}) ? Number(digit[1]) : 0;
}

// Checks a newly recorded combo for `actionId` against the rules and the
// other shortcuts. Returns { combo } or { error }.
export function validateRecording(actionId, raw, shortcuts) {
  const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
  if (action.modifiersOnly && !/^Digit[1-9]$/.test(raw.code)) {
    return { error: "Hold the modifier keys and press a number, for example Alt+1." };
  }
  if (!action.modifiersOnly && !CODE_PATTERN.test(raw.code)) {
    return { error: "Use a letter, number, punctuation key or F1–F12." };
  }
  const combo = { ...raw, code: action.modifiersOnly ? null : raw.code };
  const problem = problemWith(combo, action.modifiersOnly);
  if (problem) return { error: problem };
  for (const other of SHORTCUT_ACTIONS) {
    if (other.id === actionId) continue;
    const taken = shortcuts[other.id];
    const clash = other.modifiersOnly
      ? !action.modifiersOnly && /^Digit[1-9]$/.test(combo.code) && sameModifiers(taken, combo)
      : action.modifiersOnly
        ? /^Digit[1-9]$/.test(taken.code) && sameModifiers(taken, combo)
        : taken.code === combo.code && sameModifiers(taken, combo);
    if (clash) return { error: `Already used for “${other.label}”.` };
  }
  return { combo };
}

// Key caps for display, e.g. ["Alt", "K"] or ["⌥", "K"] on a Mac.
export function keyParts(combo) {
  const parts = [];
  if (combo.ctrl) parts.push(IS_MAC ? "⌃" : "Ctrl");
  if (combo.alt) parts.push(IS_MAC ? "⌥" : "Alt");
  if (combo.shift) parts.push(IS_MAC ? "⇧" : "Shift");
  if (combo.meta) parts.push(IS_MAC ? "⌘" : "Win");
  if (combo.code === null) parts.push("1–9");
  else parts.push(CODE_LABELS[combo.code] ?? combo.code.replace(/^Key|^Digit/, ""));
  return parts;
}

export function formatShortcut(combo, digit) {
  const parts = keyParts(combo);
  if (digit) parts[parts.length - 1] = String(digit);
  return parts.join(IS_MAC ? "" : "+");
}
