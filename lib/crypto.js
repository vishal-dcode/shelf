// End-to-end encryption for shared spaces. WebCrypto only, no dependencies.
//
// - Every shared space has a random AES-GCM-256 space key. The space (name,
//   shelves, titles, addresses, notes) is encrypted with it in this browser;
//   the server stores only ciphertext.
// - Every browser that signs in has its own ECDH P-256 device key. The
//   private half is generated non-extractable and kept in IndexedDB, so not
//   even this extension's code can read it out. The public half goes to the
//   server.
// - A space key reaches a member's device wrapped for that device's public
//   key: an ephemeral ECDH exchange, HKDF-SHA-256, then AES-GCM. The space id,
//   key version and recipient are bound in as associated data, so a wrapped
//   key can't be replayed onto another space or device.
//
// Known limit: the server hands out public keys, so a
// compromised server could substitute its own key for a new member's device.
// There is no out-of-band key verification yet.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Bad encoding");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const ECDH = { name: "ECDH", namedCurve: "P-256" };

// Only the fields a P-256 public key needs, so nothing else rides along.
export function publicJwk(jwk) {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("Not a P-256 public key");
  }
  if (jwk.x.length > 64 || jwk.y.length > 64) throw new Error("Not a P-256 public key");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

export async function generateDeviceKey() {
  const pair = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  const jwk = publicJwk(await subtle.exportKey("jwk", pair.publicKey));
  return { privateKey: pair.privateKey, publicJwk: jwk, keyId: toB64(globalThis.crypto.getRandomValues(new Uint8Array(12))) };
}

export function generateSpaceKey() {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

function aad(parts) {
  return enc.encode(parts.join("\u0000"));
}

async function wrappingKey(privateKey, publicKey, info) {
  const bits = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdf = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Wraps `spaceKey` for one device. `context` = { spaceId, keyVersion, keyId }.
export async function wrapSpaceKey(spaceKey, recipientJwk, context) {
  const recipient = await subtle.importKey("jwk", publicJwk(recipientJwk), ECDH, false, []);
  const eph = await subtle.generateKey(ECDH, true, ["deriveBits"]);
  const epk = publicJwk(await subtle.exportKey("jwk", eph.publicKey));
  const info = aad(["shelf-wrap-v1", context.spaceId, String(context.keyVersion), context.keyId]);
  const key = await wrappingKey(eph.privateKey, recipient, info);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const raw = await subtle.exportKey("raw", spaceKey);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: info }, key, raw);
  return JSON.stringify({ v: 1, epk, iv: toB64(iv), ct: toB64(ct) });
}

export async function unwrapSpaceKey(wrapped, privateKey, context) {
  const parsed = JSON.parse(wrapped);
  if (parsed?.v !== 1) throw new Error("Unknown key format");
  const epk = await subtle.importKey("jwk", publicJwk(parsed.epk), ECDH, false, []);
  const info = aad(["shelf-wrap-v1", context.spaceId, String(context.keyVersion), context.keyId]);
  const key = await wrappingKey(privateKey, epk, info);
  const raw = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(parsed.iv), additionalData: info }, key, fromB64(parsed.ct));
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

// Encrypts a space object. `context` = { spaceId, keyVersion }.
export async function encryptSpace(spaceKey, space, context) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = aad(["shelf-space-v1", context.spaceId, String(context.keyVersion)]);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: data }, spaceKey, enc.encode(JSON.stringify(space)));
  return { iv: toB64(iv), ciphertext: toB64(ct) };
}

export async function decryptSpace(spaceKey, { iv, ciphertext }, context) {
  const data = aad(["shelf-space-v1", context.spaceId, String(context.keyVersion)]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: data }, spaceKey, fromB64(ciphertext));
  return JSON.parse(dec.decode(plain));
}

// ------------------------------------------------- device key in IndexedDB

const DB = "shelf-keys";
const STORE = "device";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// This browser's device key, created on first use. Keyed by the account so a
// different sign-in never reuses another person's key.
export async function deviceKey(userId) {
  return navigator.locks.request("shelf-device-key", async () => {
    const db = await openDb();
    try {
      const found = await tx(db, "readonly", (s) => s.get(userId));
      if (found?.privateKey && found.publicJwk && found.keyId) return found;
      const fresh = await generateDeviceKey();
      await tx(db, "readwrite", (s) => s.put(fresh, userId));
      return fresh;
    } finally {
      db.close();
    }
  });
}

export async function forgetDeviceKeys() {
  const db = await openDb();
  try {
    await tx(db, "readwrite", (s) => s.clear());
  } finally {
    db.close();
  }
}
