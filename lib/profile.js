// Your profile: a display name and a small photo. Kept in this browser and,
// when signed in, synced with your spaces (lib/personal-sync.js), newest
// edit wins. No DOM here: the background worker imports this file. The
// photo picker and avatar live in lib/profile-ui.js.

export const PROFILE_KEY = "shelf:profile";
export const NAME_MAX = 40;
export const PHOTO_MAX = 120_000; // characters of data URL; a 160 px JPEG is ~8-15 KB
const PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;

export const EMPTY_PROFILE = Object.freeze({ name: "", photo: null, updatedAt: 0 });

export function sanitizeProfile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_PROFILE };
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
  const photo = typeof raw.photo === "string" && raw.photo.length <= PHOTO_MAX && PHOTO_RE.test(raw.photo) ? raw.photo : null;
  const updatedAt = Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : 0;
  return { name, photo, updatedAt };
}

export async function readProfile() {
  const stored = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY];
  return sanitizeProfile(stored);
}

// Saves a change made here; `patch` = { name } and/or { photo }.
export async function saveProfile(patch) {
  const next = sanitizeProfile({ ...(await readProfile()), ...patch, updatedAt: Date.now() });
  await chrome.storage.local.set({ [PROFILE_KEY]: next });
  return next;
}

// Newest edit wins; a profile never set (updatedAt 0) never beats one that was.
export function newerProfile(a, b) {
  return (b?.updatedAt ?? 0) > (a?.updatedAt ?? 0) ? b : a;
}
