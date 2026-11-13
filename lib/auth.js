// Sign-in with Clerk over OAuth 2.0 (authorization code + PKCE, public
// client). Works the same in Chrome and Firefox through
// identity.launchWebAuthFlow, so no Clerk SDK or bundler is needed.
//
// Tokens live in chrome.storage.local under AUTH_KEY, which only this
// extension can read. The access token is a short-lived JWT the Shelf API
// verifies; the refresh token (scope offline_access) renews it. Signing out
// revokes the refresh token at Clerk and deletes both.

import { CONFIG, PLACEHOLDER } from "./config.js";
import { toB64 } from "./crypto.js";

export const AUTH_KEY = "shelf:auth";
const SCOPES = "email profile offline_access";

export function accountsConfigured() {
  return !PLACEHOLDER.test(CONFIG.clerkOAuthClientId) && !PLACEHOLDER.test(CONFIG.apiBase);
}

export class SignedOutError extends Error {
  constructor() {
    super("Signed out");
    this.name = "SignedOutError";
  }
}

const ORIGINS = () => [`${new URL(CONFIG.clerkFrontendApi).origin}/*`, `${new URL(CONFIG.apiBase).origin}/*`];

// Firefox lets people withhold host permissions, and asks separately before
// an add-on sends any personal data (here: the sign-in and the account's
// email). Both are asked for here, while we have the click on "Sign in".
// browsingActivity: signed in, the titles and addresses of saved tabs sync.
const DATA_COLLECTION = ["authenticationInfo", "personallyIdentifyingInfo", "browsingActivity"];

async function ensureHostAccess() {
  const origins = ORIGINS();
  const all = await chrome.permissions.getAll();
  const wanted = "data_collection" in all ? { origins, data_collection: DATA_COLLECTION } : { origins };
  if (await chrome.permissions.contains(wanted)) return;
  if (!(await chrome.permissions.request(wanted))) {
    throw new Error("Shelf needs your permission to reach its sign-in server before you can sign in.");
  }
}

function randomString(bytes = 32) {
  return toB64(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier) {
  return toB64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

async function tokenRequest(params) {
  const res = await fetch(`${CONFIG.clerkFrontendApi}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CONFIG.clerkOAuthClientId, ...params }),
    credentials: "omit",
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.access_token !== "string") {
    const err = new Error(body.error_description || body.error || `Sign-in failed (${res.status})`);
    err.oauthError = body.error;
    throw err;
  }
  return body;
}

// Reads the claims of a token we just received from Clerk over TLS. Only
// used to show who is signed in; the server verifies signatures itself.
function claimsOf(jwt) {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "===".slice((part.length + 3) % 4)));
  } catch {
    return {};
  }
}

function toStored(tokens, previous) {
  const id = tokens.id_token ? claimsOf(tokens.id_token) : {};
  const access = claimsOf(tokens.access_token);
  const expiresIn = Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 3600;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Date.now() + expiresIn * 1000,
    userId: access.sub ?? id.sub ?? previous?.userId ?? null,
    email: typeof id.email === "string" ? id.email : (previous?.email ?? null),
  };
}

export async function readAuth() {
  const stored = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY];
  return stored && typeof stored.accessToken === "string" ? stored : null;
}

export async function signIn() {
  if (!accountsConfigured()) throw new Error("Accounts aren't set up in this build of Shelf yet.");
  await ensureHostAccess();
  const verifier = randomString(48);
  const state = randomString(24);
  const redirectUri = chrome.identity.getRedirectURL("oauth");
  const url = new URL(`${CONFIG.clerkFrontendApi}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CONFIG.clerkOAuthClientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    prompt: "login",
  }).toString();

  const result = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  const back = new URL(result);
  const expected = new URL(redirectUri);
  if (back.origin !== expected.origin || back.pathname !== expected.pathname) {
    throw new Error("Sign-in returned to an unexpected address.");
  }
  const params = back.searchParams;
  if (params.get("state") !== state) throw new Error("Sign-in was interrupted. Try again.");
  if (params.get("error")) throw new Error(params.get("error_description") || "Sign-in was cancelled.");
  const code = params.get("code");
  if (!code) throw new Error("Sign-in was cancelled.");

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const stored = toStored(tokens, null);
  await chrome.storage.local.set({ [AUTH_KEY]: stored });
  return stored;
}

// A valid access token, refreshed when it is within a minute of expiring.
// One refresh at a time across every page and the background worker.
export async function accessToken() {
  return navigator.locks.request("shelf-auth", async () => {
    const stored = await readAuth();
    if (!stored) throw new SignedOutError();
    if (stored.expiresAt - 60_000 > Date.now()) return stored.accessToken;
    if (!stored.refreshToken) {
      await chrome.storage.local.remove(AUTH_KEY);
      throw new SignedOutError();
    }
    try {
      const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: stored.refreshToken });
      const next = toStored(tokens, stored);
      await chrome.storage.local.set({ [AUTH_KEY]: next });
      return next.accessToken;
    } catch (err) {
      if (err.oauthError === "invalid_grant" || err.oauthError === "invalid_client") {
        await chrome.storage.local.remove(AUTH_KEY);
        throw new SignedOutError();
      }
      throw err;
    }
  });
}

export async function signOutTokens() {
  const stored = await readAuth();
  await chrome.storage.local.remove(AUTH_KEY);
  if (!stored?.refreshToken) return;
  // Best effort: the local copy is already gone either way.
  await fetch(`${CONFIG.clerkFrontendApi}/oauth/token/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CONFIG.clerkOAuthClientId, token: stored.refreshToken, token_type_hint: "refresh_token" }),
    credentials: "omit",
  }).catch(() => {});
}
