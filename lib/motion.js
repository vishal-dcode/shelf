// Shared motion for the dashboard and the side panel. Purely visual: the
// data has already changed and the page has redrawn when any of this runs,
// nothing here touches state, and the next redraw simply replaces whatever
// is still moving. With "reduce motion" on, things fade or just appear.

import { h } from "./ui.js";

export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Mirrors the motion tokens in styles/theme.css.
export const DURATION = { instant: 80, fast: 120, base: 180, panel: 240, move: 300, slow: 320 };
export const EASE = {
  out: "cubic-bezier(0.23, 1, 0.32, 1)",
  in: "cubic-bezier(0.55, 0, 1, 0.45)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  spring: "cubic-bezier(0.32, 0.72, 0, 1)", // soft landing, no bounce
};

const STAGGER = 25; // ms between items arriving together
const MAX_STAGGER = 10; // later items arrive with the tenth
const MAX_ENTERING = 40; // a bigger batch (an import, a sync) just appears

function play(el, frames, options) {
  if (!el?.isConnected || typeof el.animate !== "function") return null;
  const anim = el.animate(frames, options);
  anim.finished.catch(() => {});
  return anim;
}

// ------------------------------------------------------------ small pieces

// A new item arriving: it rises 6px into place and comes into focus.
export function enter(el, index = 0) {
  if (reduceMotion()) return play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: DURATION.fast, easing: EASE.out });
  return play(el, [{ opacity: 0, transform: "translateY(6px)", filter: "blur(2px)" }, { opacity: 1, transform: "none", filter: "none" }], {
    duration: 280,
    delay: Math.min(index, MAX_STAGGER) * STAGGER,
    easing: EASE.spring,
    fill: "backwards",
  });
}

// Secondary action: a count gives a small bump when something lands in it.
export function bump(el, delay = 0) {
  if (reduceMotion()) return null;
  return play(el, [{ transform: "scale(1)" }, { transform: "scale(1.08)", offset: 0.45 }, { transform: "scale(1)" }], {
    duration: 320,
    delay,
    easing: EASE.inOut,
  });
}

// Save buttons: a small dip, then a gentle swell back to size.
export function pop(el, amount = 1.08) {
  if (reduceMotion()) return null;
  return play(
    el,
    [
      { transform: "scale(1)" },
      { transform: "scale(0.94)", offset: 0.25 },
      { transform: `scale(${amount})`, offset: 0.6 },
      { transform: "scale(1)" },
    ],
    { duration: 360, easing: EASE.inOut },
  );
}

// A dropped item fades up from its placeholder look and settles.
export function settle(el) {
  if (reduceMotion()) return null;
  return play(el, [{ opacity: 0.45, transform: "scale(0.98)" }, { opacity: 1, transform: "none" }], {
    duration: DURATION.move,
    easing: EASE.spring,
  });
}

// Switching space or view happens all day, so the new content only fades
// up 4px, quickly.
export function arrive(els) {
  for (const el of els) {
    for (const anim of el.getAnimations?.() ?? []) if (anim.id === "arrive") anim.cancel();
    const anim = reduceMotion()
      ? play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: DURATION.fast, easing: EASE.out })
      : play(el, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], {
          duration: DURATION.fast,
          easing: EASE.out,
        });
    if (anim) anim.id = "arrive";
  }
}

// Picking something up to drag it. The class raises and tilts it for the
// moment the browser takes its picture of the dragged item; a moment later
// it settles back down as the faded placeholder.
export function lift(el) {
  if (reduceMotion()) return;
  el.classList.add("is-lifting");
  setTimeout(() => el.classList.remove("is-lifting"), 0);
}

// ------------------------------------------------------------------ lists

// Call after each redraw of a list of shelves. It compares with the last
// redraw and animates only what really changed: links that are new, counts
// that went up, shelves that were folded or unfolded, and a dropped link.
// `scene` names what is on screen (a space, Starred) and `filter` the search;
// when either changes, nothing animates item by item.
export function createListMotion({ countSelector }) {
  let last = null;
  let settleKey = null;
  let quiet = false;
  let places = null;

  function read(root) {
    const links = new Map();
    for (const el of root.querySelectorAll('[data-key^="link:"]')) links.set(el.dataset.key, el.closest("li") ?? el);
    const shelves = new Map();
    for (const section of root.querySelectorAll("[data-collection-id]")) {
      const list = section.querySelector(":scope > ul");
      const countEl = section.querySelector(countSelector);
      shelves.set(section.dataset.collectionId, {
        section,
        list,
        open: Boolean(list && !list.hidden),
        countEl,
        count: Number.parseInt(countEl?.textContent ?? "", 10) || 0,
      });
    }
    return { links, shelves };
  }

  return {
    // Call just before a redraw: remembers where every shelf and link is
    // on screen, so the next redraw can glide them to their new places.
    before(root) {
      places = reduceMotion() ? null : measure(root);
    },
    // The link (data-key) or shelf (`shelf:<id>`) just dropped; it settles
    // on the next redraw.
    expectSettle(key) {
      settleKey = key;
    },
    // Skip item motion for the next redraw.
    hush(on = true) {
      quiet = on;
    },
    // Returns true when the scene changed (never on the first redraw), so
    // the page can play its switch motion.
    after(root, { scene, filter }) {
      const now = read(root);
      const sceneChanged = last !== null && last.scene !== scene;
      if (last && !sceneChanged && last.filter === filter && !quiet) {
        const folded = animateChanges(last, now, settleKey);
        if (places && !folded) glide(root, places);
      }
      last = { scene, filter, ...now };
      settleKey = null;
      places = null;
      return sceneChanged;
    },
  };
}

// Where each shelf and link sits, by key, in screen pixels.
function measure(root) {
  const at = new Map();
  for (const el of root.querySelectorAll("[data-collection-id]")) at.set(`shelf:${el.dataset.collectionId}`, el.getBoundingClientRect());
  for (const el of root.querySelectorAll('[data-key^="link:"]')) at.set(el.dataset.key, (el.closest("li") ?? el).getBoundingClientRect());
  return at;
}

const MAX_GLIDING = 160; // a bigger reshuffle just snaps into place

// Reordering, moving a link, deleting one: everything that changed place
// slides from where it was to where it is now (FLIP), easing in and out.
// A link inside a shelf that is itself sliding only moves by the
// difference, and the slide adds to any arrival or settle already playing.
function glide(root, places) {
  const moves = [];
  const shelfShift = new Map();
  for (const el of root.querySelectorAll("[data-collection-id]")) {
    const key = `shelf:${el.dataset.collectionId}`;
    const from = places.get(key);
    if (!from) continue;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    shelfShift.set(el, { dx, dy });
    if (Math.abs(dx) + Math.abs(dy) >= 1) moves.push({ el, dx, dy });
  }
  for (const el of root.querySelectorAll('[data-key^="link:"]')) {
    const from = places.get(el.dataset.key);
    if (!from) continue;
    const item = el.closest("li") ?? el;
    const to = item.getBoundingClientRect();
    const parent = shelfShift.get(item.closest("[data-collection-id]")) ?? { dx: 0, dy: 0 };
    const dx = from.left - to.left - parent.dx;
    const dy = from.top - to.top - parent.dy;
    if (Math.abs(dx) + Math.abs(dy) >= 1) moves.push({ el: item, dx, dy });
  }
  if (moves.length > MAX_GLIDING) return;
  for (const { el, dx, dy } of moves) {
    play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
      duration: DURATION.move,
      easing: EASE.inOut,
      composite: "add",
    });
  }
}

// Returns true when a shelf folded or unfolded (its neighbours then follow
// the fold itself, so nothing else glides).
function animateChanges(before, now, settleKey) {
  let folded = false;
  const fresh = [...now.links].filter(([key]) => !before.links.has(key));
  if (fresh.length <= MAX_ENTERING) {
    let i = 0;
    for (const [, el] of fresh) enter(el, i++);
  }
  for (const [id, shelf] of now.shelves) {
    const old = before.shelves.get(id);
    if (!old) {
      // A new shelf (a saved window): it fades in, then its count bumps
      // once its links have arrived.
      play(shelf.section, [{ opacity: 0 }, { opacity: 1 }], { duration: DURATION.base, easing: EASE.out });
      if (shelf.count) bump(shelf.countEl, Math.min(shelf.count, MAX_STAGGER) * STAGGER + 160);
      continue;
    }
    if (shelf.count > old.count) bump(shelf.countEl, 120);
    if (shelf.open !== old.open) {
      fold(shelf, old);
      folded = true;
    }
  }
  if (settleKey) {
    settle(settleKey.startsWith("shelf:") ? now.shelves.get(settleKey.slice(6))?.section : now.links.get(settleKey));
  }
  return folded;
}

// Shelves open and close smoothly (slow in, slow out) and the chevron
// swings past its mark and back. Closing puts the old list back for the
// length of the fold, inert and hidden from assistive tech, then removes it.
function fold(shelf, old) {
  const chev = shelf.section.querySelector(".chev");
  if (reduceMotion()) return;
  play(
    chev,
    shelf.open
      ? [{ transform: "rotate(0deg)" }, { transform: "rotate(90deg)" }]
      : [{ transform: "rotate(90deg)" }, { transform: "rotate(0deg)" }],
    { duration: DURATION.panel, easing: EASE.inOut },
  );

  if (shelf.open) {
    const list = shelf.list;
    if (!list || list.hidden) return;
    const height = list.offsetHeight;
    const margin = getComputedStyle(list).marginTop;
    list.style.overflow = "clip";
    play(
      list,
      [
        { height: "0px", marginTop: "0px", opacity: 0 },
        { height: `${height}px`, marginTop: margin, opacity: 1 },
      ],
      { duration: DURATION.panel, easing: EASE.inOut },
    )?.finished.finally(() => list.style.removeProperty("overflow"));
    return;
  }

  const ghost = old.list;
  if (!ghost || ghost.isConnected || ghost.hidden) return;
  ghost.removeAttribute("id");
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  for (const el of ghost.querySelectorAll("[data-key], [data-link-id], [id]")) {
    el.removeAttribute("data-key");
    el.removeAttribute("data-link-id");
    el.removeAttribute("id");
  }
  if (shelf.list) shelf.list.before(ghost);
  else shelf.section.append(ghost);
  const height = ghost.offsetHeight;
  const margin = getComputedStyle(ghost).marginTop;
  ghost.style.overflow = "clip";
  const anim = play(
    ghost,
    [
      { height: `${height}px`, marginTop: margin, opacity: 1 },
      { height: "0px", marginTop: "0px", opacity: 0 },
    ],
    { duration: 180, easing: EASE.inOut, fill: "forwards" },
  );
  if (anim) anim.finished.finally(() => ghost.remove());
  else ghost.remove();
}

// ---------------------------------------------------------- nav indicator

// Before a redraw: where the current item in `container` is. Clears any
// indicator still sliding from the last switch.
export function captureCurrent(container) {
  for (const pill of container.querySelectorAll(".nav-pill")) pill.remove();
  const el = container.querySelector('[aria-current="page"]');
  return el ? { key: el.dataset.key, rect: el.getBoundingClientRect() } : null;
}

// After it: the current-page tile slides from the old item to the new one.
// Needs a positioned container that keeps the tile under its content (the
// sticky sidebar); otherwise the tile just switches, as before.
export function slideCurrent(container, from) {
  if (!from || reduceMotion()) return;
  const el = container.querySelector('[aria-current="page"]');
  if (!el || el.dataset.key === from.key) return;
  if (getComputedStyle(container).position !== "sticky") return;
  const box = container.getBoundingClientRect();
  const to = el.getBoundingClientRect();
  if (!to.width || !from.rect.width) return;
  const pill = h("span", { class: "nav-pill", "aria-hidden": "true" });
  Object.assign(pill.style, {
    left: `${to.left - box.left - container.clientLeft + container.scrollLeft}px`,
    top: `${to.top - box.top - container.clientTop + container.scrollTop}px`,
    width: `${to.width}px`,
    height: `${to.height}px`,
  });
  container.append(pill);
  el.classList.add("is-pill-target");
  const anim = play(
    pill,
    [{ transform: `translate(${from.rect.left - to.left}px, ${from.rect.top - to.top}px)` }, { transform: "none" }],
    { duration: DURATION.base, easing: EASE.inOut },
  );
  const done = () => {
    pill.remove();
    el.classList.remove("is-pill-target");
  };
  if (anim) anim.finished.finally(done);
  else done();
}

// ------------------------------------------------------------- reordering

// Before a redraw: where each element matching `selector` is, by data-key.
export function captureRects(container, selector) {
  const at = new Map();
  if (reduceMotion()) return at;
  for (const el of container.querySelectorAll(selector)) at.set(el.dataset.key, el.getBoundingClientRect());
  return at;
}

// After it: each one that changed place glides there, easing in and out.
// Its whole row moves, so hover and drop marks travel with it.
export function glideRects(container, selector, rects, rowSelector = "li") {
  if (!rects?.size) return;
  for (const el of container.querySelectorAll(selector)) {
    const from = rects.get(el.dataset.key);
    if (!from) continue;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) + Math.abs(dy) < 1) continue;
    play(el.closest(rowSelector) ?? el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
      duration: DURATION.move,
      easing: EASE.inOut,
      composite: "add",
    });
  }
}

// ---------------------------------------------------------------- sidebar

// Folding the dashboard sidebar to its icon rail and back. While folding,
// the full layout stays and its labels fade out as the column narrows; the
// rail layout takes over at the end. Unfolding swaps layout at once and the
// labels fade in as the column opens. A redraw part way through keeps going.
let foldTimer = 0;
let sidebarSeen = false;

export function foldSidebar(app, sidebar, wasRail, rail) {
  const first = !sidebarSeen;
  sidebarSeen = true;
  if (wasRail === rail || first) {
    if (rail && sidebar.classList.contains("is-folding")) sidebar.classList.remove("is-collapsed");
    return;
  }
  clearTimeout(foldTimer);
  sidebar.classList.remove("is-folding", "is-unfolding");
  if (reduceMotion()) {
    app.classList.remove("is-sliding");
    return;
  }
  app.classList.add("is-sliding");
  if (rail) {
    sidebar.classList.remove("is-collapsed");
    sidebar.classList.add("is-folding");
  } else {
    sidebar.classList.add("is-unfolding");
  }
  foldTimer = setTimeout(
    () => {
      app.classList.remove("is-sliding");
      sidebar.classList.remove("is-unfolding");
      if (sidebar.classList.contains("is-folding")) sidebar.classList.replace("is-folding", "is-collapsed");
    },
    rail ? DURATION.panel : DURATION.panel + DURATION.fast * 2,
  );
}

// -------------------------------------------------------------- open tabs

// The Open tabs panel slides in from the right edge as its column opens,
// and slides back out before the column closes. `apply` flips the state
// and redraws. A second toggle mid-slide just applies at once.
let tabsSliding = false;
let tabsTimer = 0;

export async function slideTabsPanel(app, panel, opening, apply) {
  if (reduceMotion() || tabsSliding) {
    apply();
    return;
  }
  tabsSliding = true;
  clearTimeout(tabsTimer);
  app.classList.add("is-sliding-tabs");
  if (!opening && !panel.hidden) {
    const out = play(panel, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(24px)" }], {
      duration: DURATION.base,
      easing: EASE.in,
      fill: "forwards",
    });
    await out?.finished.catch(() => {});
    apply();
    out?.cancel();
  } else {
    apply();
    play(panel, [{ opacity: 0, transform: "translateX(32px)" }, { opacity: 1, transform: "none" }], {
      duration: DURATION.panel + 60,
      easing: EASE.spring,
    });
  }
  tabsSliding = false;
  tabsTimer = setTimeout(() => app.classList.remove("is-sliding-tabs"), DURATION.panel + 60);
}

// ---------------------------------------------------------------- switches

// On/off switches: the thumb stretches about 15% while it travels, then
// the spring in base.css settles it. Runs after the control's own click
// handler has flipped aria-checked.
if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => {
    const control = event.target instanceof Element ? event.target.closest("[aria-checked]") : null;
    const thumb = control?.querySelector(":scope > .switch > .switch-thumb");
    if (!thumb || reduceMotion()) return;
    play(thumb, [{ scale: "1 1" }, { scale: "1.15 1", offset: 0.4 }, { scale: "1 1" }], {
      duration: DURATION.base,
      easing: EASE.out,
    });
  });
}
