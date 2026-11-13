// The avatar and the photo picker for your profile (lib/profile.js).
// A picked photo is re-drawn to a 160 px square JPEG before it is stored, so
// nothing from the original file (metadata, other formats) is kept. It is
// shown through a blob: URL; the page's CSP allows no data: images.

import { h } from "./ui.js";
import { PHOTO_MAX } from "./profile.js";

const PHOTO_PX = 160;

// Returns a square, centre-cropped JPEG data URL. Throws a readable error for
// files that aren't usable images.
export async function photoFromFile(file) {
  if (!file || !/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type)) throw new Error("Choose a JPEG, PNG or WebP image.");
  if (file.size > 15_000_000) throw new Error("That image is too large. Choose one under 15 MB.");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image couldn't be read. Try a JPEG or PNG.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PHOTO_PX;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff"; // transparent PNGs get a plain background, not black
  ctx.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
  bitmap.close?.();
  for (const quality of [0.86, 0.72, 0.6]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= PHOTO_MAX) return url;
  }
  throw new Error("That image couldn't be shrunk enough. Try another one.");
}

// One blob: URL per photo, reused while the photo stays the same.
let cached = { photo: null, url: null };
function photoUrl(photo) {
  if (cached.photo === photo) return cached.url;
  if (cached.url) URL.revokeObjectURL(cached.url);
  const bytes = Uint8Array.from(atob(photo.slice(photo.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  cached = { photo, url: URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })) };
  return cached.url;
}

export function initials(name) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = [...parts[0]][0] ?? "";
  const last = parts.length > 1 ? ([...parts.at(-1)][0] ?? "") : "";
  return (first + last).toUpperCase();
}

// Without a photo the avatar is a glyph: a pastel tile, a head-and-shoulders
// shape and a simple mark, in the spirit of DiceBear's "glyphs" style. It is
// drawn here from fixed shapes and colours, never fetched, so no name or
// email leaves the browser. The same seed always gives the same glyph.
const GLYPH_COLORS = [
  ["#ffdfe4", "#7a2a3a", "#f0506e"], // rose
  ["#dde8ff", "#33507f", "#5b8def"], // blue
  ["#ffe8d4", "#7a4f2a", "#f7a35c"], // peach
  ["#e1e3f2", "#2f3560", "#545aa8"], // slate
  ["#dff3dd", "#356b37", "#5cc062"], // green
  ["#efe0ff", "#57307f", "#a95cf0"], // violet
  ["#e8e8e8", "#4a4a4a", "#8a8a8a"], // grey
  ["#fde8c8", "#6e5216", "#e5a524"], // amber
  ["#d6f2f2", "#1f5e60", "#34a7aa"], // teal
];
// Each mark is drawn around (32, 22) with stroke="currentColor".
const GLYPH_MARKS = [
  '<path d="M23 17l9 9 9-9"/>', // chevron
  '<path d="M32 13l9 9-9 9-9-9z"/>', // diamond
  '<path d="M22 26a10 10 0 0 1 20 0"/>', // arch
  '<path d="M38 14a10 10 0 0 1-12 14"/>', // crescent
  '<path d="M24 30a10 10 0 0 1 14-14"/>', // quarter arc
  '<path d="M22 28a10 10 0 0 1 20 0" stroke-width="7"/>', // dome
  '<path d="M38 26a7 7 0 1 1 0-8"/>', // open ring
  '<path d="M25 15h13v13"/>', // corner
  '<path d="M32 14v16M24 22h16"/>', // plus
  '<circle cx="32" cy="22" r="6"/>', // ring
];

function hashSeed(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function glyphSvg(seed) {
  const n = hashSeed(seed || "shelf");
  const [bg, body, mark] = GLYPH_COLORS[n % GLYPH_COLORS.length];
  const shape = GLYPH_MARKS[Math.floor(n / GLYPH_COLORS.length) % GLYPH_MARKS.length];
  // Only the fixed tables above go into this markup, never the seed itself.
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="${bg}"/>` +
    `<circle cx="32" cy="70" r="24" fill="${body}"/>` +
    `<g fill="none" stroke="${mark}" stroke-width="5" stroke-linecap="square" stroke-linejoin="miter">${shape}</g></svg>`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "avatar-glyph");
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  for (const node of [...parsed.documentElement.childNodes]) svg.appendChild(document.importNode(node, true));
  return svg;
}

// The avatar: the photo if there is one, else a glyph from `seed` (the
// account's email when signed in, so renaming yourself keeps the glyph).
export function avatar(profile, extraClass = "", seed = null) {
  const cls = `avatar${extraClass ? ` ${extraClass}` : ""}`;
  if (profile?.photo) {
    return h("span", { class: `${cls} has-photo` }, h("img", { src: photoUrl(profile.photo), alt: "", draggable: "false" }));
  }
  return h("span", { class: `${cls} has-glyph` }, glyphSvg(seed || profile?.name || "shelf"));
}
