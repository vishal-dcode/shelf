// The signed-in account as this browser knows it: who, which plan, pending
// invitations. Shared by the dashboard, side panel and background worker.
//
// ACCOUNT_KEY holds what the UI shows. PLAN_KEY (lib/store.js) holds only the
// plan and how long it may be trusted offline; the caps read it on every save.

import { PLAN_KEY, update } from "./store.js";
import { accountsConfigured, readAuth, signIn as oauthSignIn, signOutTokens, SignedOutError } from "./auth.js";
import { api } from "./api.js";
import { deviceKey, forgetDeviceKeys } from "./crypto.js";
import { CONFIG } from "./config.js";

export const ACCOUNT_KEY = "shelf:account";
export const SYNC_KEY = "shelf:sync";
// Account sync bookkeeping (lib/personal-sync.js): { userId, version, base }.
export const PERSONAL_KEY = "shelf:sync-personal";
// A Pro plan stays trusted this long without reaching the server (offline).
const OFFLINE_GRACE = 7 * 24 * 60 * 60 * 1000;

export { accountsConfigured };

export async function readAccount() {
  const [auth, stored] = await Promise.all([readAuth(), chrome.storage.local.get(ACCOUNT_KEY)]);
  if (!auth) return { signedIn: false, plan: "free", invites: [] };
  const account = stored[ACCOUNT_KEY] ?? {};
  return {
    signedIn: true,
    userId: auth.userId,
    email: account.email ?? auth.email ?? null,
    plan: account.plan === "pro" || !CONFIG.plansEnabled ? "pro" : "free",
    subscription: account.subscription && typeof account.subscription === "object" ? account.subscription : null,
    invites: Array.isArray(account.invites) ? account.invites : [],
    checkedAt: account.checkedAt ?? 0,
  };
}

// Asks the server who we are, which plan we have and what invitations are
// waiting, and registers this browser's encryption key.
export async function refreshAccount({ fresh = false } = {}) {
  const auth = await readAuth();
  if (!auth) return readAccount();
  try {
    const me = await api(`/v1/me${fresh ? "?fresh=1" : ""}`);
    const key = await deviceKey(me.userId);
    if (!me.deviceKeyIds?.includes(key.keyId)) {
      await api("/v1/me/keys", { method: "PUT", body: { keyId: key.keyId, publicKey: key.publicJwk } });
    }
    // Offline, Pro is trusted for a week, or until a cancelled subscription
    // ends if that's sooner. Renewals are Paddle's job; the server hears
    // about them by webhook, so a renewal never depends on this browser.
    const sub = me.subscription ?? null;
    const endsAt = Number.isFinite(sub?.endsAt) ? sub.endsAt : Infinity;
    const until = me.plan === "pro" ? Math.min(Date.now() + OFFLINE_GRACE, Math.max(endsAt, Date.now())) : 0;
    await chrome.storage.local.set({
      [ACCOUNT_KEY]: { email: me.email, plan: me.plan, subscription: sub, invites: me.invites ?? [], checkedAt: Date.now() },
      [PLAN_KEY]: { plan: me.plan, until },
    });
  } catch (err) {
    if (err instanceof SignedOutError) await clearLocalAccount();
    else throw err;
  }
  return readAccount();
}

export async function signIn() {
  await oauthSignIn();
  const account = await refreshAccount({ fresh: true });
  chrome.runtime.sendMessage({ type: "shelf:sync" }).catch(() => {});
  return account;
}

// Removes the account from this browser. Spaces other people shared are
// theirs, so their copies go. Your own shared spaces stay, still linked, and
// pick up where they left off when you sign in again. The device key stays
// too (it is stored per account), so this browser can still decrypt them
// then; signing in as someone else never touches it.
async function clearLocalAccount() {
  await chrome.storage.local.remove([ACCOUNT_KEY, PLAN_KEY]);
  await update(
    (d) => {
      d.spaces = d.spaces.filter((s) => !s.shared || s.shared.role === "owner");
      if (d.spaces.length === 0) d.spaces.push({ id: crypto.randomUUID(), name: "Personal", collections: [] });
      if (!d.spaces.some((s) => s.id === d.activeSpaceId)) d.activeSpaceId = d.spaces[0].id;
    },
    { sync: true },
  );
}

// Settings → "Forget this browser's encryption key": for a shared computer.
export async function forgetThisBrowser() {
  await signOut();
  await chrome.storage.local.remove([SYNC_KEY, PERSONAL_KEY]);
  await update((d) => {
    for (const s of d.spaces) delete s.shared;
  }, { sync: true });
  await forgetDeviceKeys();
}

// Deletes everything Shelf's server holds about this account (including the
// synced copy of your spaces), then signs out. This browser's copy stays;
// shared spaces become plain local spaces.
export async function deleteAccountData() {
  await api("/v1/me", { method: "DELETE" });
  await chrome.storage.local.remove([SYNC_KEY, PERSONAL_KEY]);
  await update((d) => {
    d.spaces = d.spaces.filter((s) => !s.shared || s.shared.role === "owner");
    for (const s of d.spaces) delete s.shared;
    if (d.spaces.length === 0) d.spaces.push({ id: crypto.randomUUID(), name: "Personal", collections: [] });
    if (!d.spaces.some((s) => s.id === d.activeSpaceId)) d.activeSpaceId = d.spaces[0].id;
  }, { sync: true });
  await signOut();
}

export async function signOut() {
  await signOutTokens();
  await clearLocalAccount();
}

export function websiteUrl(path) {
  return `${CONFIG.website}${path}`;
}

// Checkout runs on Shelf's website with Paddle.js (its pay page).
// The Shelf account id rides along as Paddle custom data, which is how the
// webhook knows whose plan to change. It isn't secret; paying with someone
// else's id would only gift them Pro.
export function checkoutUrl(interval, account) {
  const plan = interval === "year" ? "year" : "month";
  return websiteUrl(`/pay.html?plan=${plan}&user=${encodeURIComponent(account.userId ?? "")}`);
}

// Paddle's customer portal: cancel, change card or UPI mandate, invoices.
export async function billingPortalUrl() {
  const { url } = await api("/v1/billing/portal", { method: "POST" });
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !/(^|\.)paddle\.com$/.test(parsed.hostname)) throw new Error("Unexpected billing link.");
  return parsed.href;
}

// "Pro · renews 7 Dec", "Pro · ends 7 Dec", "Pro · payment problem".
export function subscriptionText(account) {
  const sub = account.subscription;
  if (!sub) return null;
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (sub.status === "past_due") return "payment problem";
  if (Number.isFinite(sub.endsAt)) return `ends ${day(sub.endsAt)}`;
  if (sub.status === "trialing" && Number.isFinite(sub.renewsAt)) return `trial until ${day(sub.renewsAt)}`;
  if (Number.isFinite(sub.renewsAt)) return `renews ${day(sub.renewsAt)}`;
  return null;
}
