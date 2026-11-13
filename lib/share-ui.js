// Account dialogs on the dashboard: upgrade to Pro, share a space, and
// invitations. They reuse the Settings dialog's layout (styles/base.css).
// Emails and roles come from the server and reach the DOM only as text.

import { h, icon } from "./ui.js";
import { FREE_LIMITS, loadState } from "./store.js";
import { api, ApiError } from "./api.js";
import { rotateSpaceKey, shareSpace, stopSharing, leaveSpace, syncNow } from "./sync.js";
import { checkoutUrl, websiteUrl } from "./account.js";
import { CONFIG } from "./config.js";

const ROLE_LABELS = { owner: "Owner", edit: "Can edit", view: "Can view" };

export function dialogEl() {
  return document.getElementById("share");
}

export function open(dialog, title, body, actions, { onClose, focus } = {}) {
  dialog.replaceChildren(
    h(
      "div",
      { class: "settings-head" },
      h("h2", { class: "dialog-title", id: "share-title" }, title),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close", onClick: () => dialog.close() }, icon("close")),
    ),
    ...body,
    h("div", { class: "dialog-actions" }, ...actions),
  );
  const returnFocus = document.activeElement;
  dialog.addEventListener(
    "close",
    () => {
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
      onClose?.();
    },
    { once: true },
  );
  if (!dialog.open) dialog.showModal();
  (focus ?? actions.at(-1))?.focus();
}

function errorLine() {
  const el = h("p", { class: "field-error settings-error", role: "alert", hidden: true });
  return {
    el,
    // `info` shows a neutral note in the same place instead of an error.
    show(err, { info = false } = {}) {
      el.textContent = err ? (err instanceof ApiError || err instanceof Error ? err.message : String(err)) : "";
      el.hidden = !err;
      el.classList.toggle("is-info", info);
      el.setAttribute("role", info ? "status" : "alert");
    },
  };
}

async function busy(button, label, run) {
  const children = [...button.childNodes];
  button.disabled = true;
  if (label) button.textContent = label;
  try {
    return await run();
  } finally {
    button.disabled = false;
    if (label) button.replaceChildren(...children);
  }
}

export function openWebsite(path) {
  chrome.tabs.create({ url: websiteUrl(path) });
}

// ------------------------------------------------------------------- upgrade

const PRO_POINTS = [
  "Unlimited spaces and shelves",
  "Share spaces with anyone by email, view or edit",
  "Shared spaces are end-to-end encrypted",
];

export function openUpgrade({ kind, account, onSignIn, onRefresh, onClose }) {
  const dialog = dialogEl();
  const reason =
    kind === "spaces"
      ? `The free plan holds ${FREE_LIMITS.spaces} spaces. Everything you have stays; to add more, upgrade to Shelf Pro.`
      : kind === "collections"
        ? `The free plan holds ${FREE_LIMITS.collections} shelves. Everything you have stays; to add more, upgrade to Shelf Pro.`
        : kind === "share"
          ? "Sharing a space is part of Shelf Pro. The people you invite only need a free account."
          : "Shelf Pro: unlimited spaces and shelves, and shared spaces.";
  const error = errorLine();
  const actions = [];
  if (kind === "spaces") {
    // The open-source build holds 3 spaces; the store builds have no cap.
    open(
      dialog,
      "Three spaces in this build",
      [
        h("p", { class: "dialog-body" }, `This open-source build of Shelf holds ${FREE_LIMITS.spaces} spaces. Everything you have stays. For unlimited spaces, sync and sharing, install Shelf from the Chrome Web Store or Firefox Add-ons.`),
      ],
      [
        h("button", { type: "button", class: "btn btn-ghost", onClick: () => dialog.close() }, "Not now"),
        h("button", { type: "button", class: "btn btn-primary", onClick: () => { openWebsite(""); dialog.close(); } }, "Get Shelf"),
      ],
      { onClose },
    );
    return;
  }
  if (!CONFIG.plansEnabled) {
    // Launch period: no plans, nothing for sale. An account removes the caps.
    const why =
      kind === "spaces"
        ? `Without an account Shelf holds ${FREE_LIMITS.spaces} spaces. Everything you have stays.`
        : kind === "collections"
          ? `Without an account Shelf holds ${FREE_LIMITS.collections} shelves. Everything you have stays.`
          : kind === "share"
            ? "Sharing a space needs an account, for you and for the people you invite."
            : "Some of Shelf needs an account.";
    if (account.signedIn) {
      open(dialog, "Not available right now", [h("p", { class: "dialog-body" }, "Try again in a moment. If it keeps happening, sign out and in again.")],
        [h("button", { type: "button", class: "btn btn-primary", onClick: () => dialog.close() }, "OK")], { onClose });
      return;
    }
    open(
      dialog,
      "Sign in for unlimited spaces",
      [
        h("p", { class: "dialog-body" }, why),
        h(
          "ul",
          { class: "pro-points" },
          ["Unlimited spaces and shelves", "Your spaces on every browser you sign in on", "Share spaces with anyone by email"].map((p) =>
            h("li", {}, icon("check"), h("span", {}, p)),
          ),
        ),
        error.el,
      ],
      [
        h("button", { type: "button", class: "btn btn-ghost", onClick: () => dialog.close() }, "Not now"),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary",
            onClick: async (e) => {
              try {
                await busy(e.currentTarget, "Signing in…", onSignIn);
                dialog.close();
              } catch (err) {
                error.show(err);
              }
            },
          },
          "Sign in",
        ),
      ],
      { onClose },
    );
    return;
  }
  if (!CONFIG.paymentsLive && account.plan !== "pro") {
    // Payments aren't open yet: say so, and don't send anyone to checkout.
    open(
      dialog,
      "Shelf Pro is coming soon",
      [
        h("p", { class: "dialog-body" }, reason),
        h(
          "ul",
          { class: "pro-points" },
          PRO_POINTS.map((p) => h("li", {}, icon("check"), h("span", {}, p))),
        ),
        h("p", { class: "settings-hint" }, "Pro isn't on sale yet. Everything on the free plan keeps working, and your data stays as it is."),
      ],
      [h("button", { type: "button", class: "btn btn-primary", onClick: () => dialog.close() }, "OK")],
      { onClose },
    );
    return;
  }
  if (!account.signedIn) {
    actions.push(
      h("button", { type: "button", class: "btn btn-ghost", onClick: () => dialog.close() }, "Not now"),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-primary",
          onClick: async (e) => {
            try {
              await busy(e.currentTarget, "Signing in…", onSignIn);
              dialog.close();
            } catch (err) {
              error.show(err);
            }
          },
        },
        "Sign in to upgrade",
      ),
    );
  } else {
    actions.push(
      h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost",
          onClick: async (e) => {
            try {
              const next = await busy(e.currentTarget, "Checking…", onRefresh);
              if (next.plan === "pro") dialog.close();
              else error.show("Your account is still on the free plan. If you just paid, wait a moment and check again.");
            } catch (err) {
              error.show(err);
            }
          },
        },
        "I've paid",
      ),
      // Checkout opens on the website in a new tab; the plan switches when
      // Paddle tells the server (usually seconds), then "I've paid" sees it.
      h("button", { type: "button", class: "btn btn-ghost", onClick: () => chrome.tabs.create({ url: checkoutUrl("year", account) }) }, "Yearly"),
      h("button", { type: "button", class: "btn btn-primary", onClick: () => chrome.tabs.create({ url: checkoutUrl("month", account) }) }, "Monthly"),
    );
  }
  open(
    dialog,
    "Shelf Pro",
    [
      h("p", { class: "dialog-body" }, reason),
      h(
        "ul",
        { class: "pro-points" },
        PRO_POINTS.map((p) => h("li", {}, icon("check"), h("span", {}, p))),
      ),
      h(
        "p",
        { class: "settings-hint" },
        "14 days free, then $2 a month or $18 a year (₹99 or ₹899 in India). Renews automatically until you cancel, which you can do anytime from Manage subscription. Payment is handled by Paddle, Shelf's reseller.",
      ),
      error.el,
    ],
    actions,
    { onClose },
  );
}

// --------------------------------------------------------------------- share

// `space` is the local space; `account` from lib/account.js.
export async function openShare({ space, account, announce, onUpgrade, onClose }) {
  const dialog = dialogEl();
  if (!space.shared) {
    if (account.plan !== "pro") return onUpgrade("share");
    const error = errorLine();
    const start = h(
      "button",
      {
        type: "button",
        class: "btn btn-primary",
        onClick: async (e) => {
          try {
            await busy(e.currentTarget, "Encrypting…", () => shareSpace(space.id));
            announce(`${space.name} is shared`);
            const fresh = { ...space, shared: { role: "owner", id: null } };
            await showMembers(dialog, fresh, announce, onClose, true);
          } catch (err) {
            if (err instanceof ApiError && err.code === "pro_required") return onUpgrade("share");
            error.show(err);
          }
        },
      },
      "Start sharing",
    );
    return open(
      dialog,
      `Share ${space.name}`,
      [
        h(
          "p",
          { class: "dialog-body" },
          "Shelf encrypts this space in your browser before it leaves. Shelf's server stores only scrambled data; the people you invite get the key from your browser, never from the server.",
        ),
        h("p", { class: "settings-hint" }, "Next, invite people by email and choose whether each can view or edit."),
        error.el,
      ],
      [h("button", { type: "button", class: "btn btn-ghost", onClick: () => dialog.close() }, "Cancel"), start],
      { onClose },
    );
  }
  return showMembers(dialog, space, announce, onClose, false);
}

async function showMembers(dialog, space, announce, onClose, justShared) {
  // Re-read so the shared id is the one just stored.
  const current = (await loadState()).spaces.find((s) => s.id === space.id) ?? space;
  const sharedId = current.shared?.id;
  const owner = current.shared?.role === "owner";
  const error = errorLine();
  const list = h("ul", { class: "settings-list member-list", "aria-label": "People in this space" });

  async function refresh() {
    let detail;
    try {
      detail = await api(`/v1/spaces/${encodeURIComponent(sharedId)}`);
    } catch (err) {
      error.show(err);
      return null;
    }
    list.replaceChildren(
      ...detail.members.map((m) => {
        const label = h("span", { class: "member-who" }, h("strong", {}, m.isYou ? `${m.email} (you)` : m.email), h("small", {}, m.status === "invited" ? "Invited" : ROLE_LABELS[m.role]));
        let control = null;
        if (owner && m.role !== "owner") {
          const select = h(
            "select",
            {
              class: "member-role",
              "aria-label": `Role for ${m.email}`,
              onChange: async () => {
                try {
                  await api(`/v1/spaces/${encodeURIComponent(sharedId)}/members/${encodeURIComponent(m.id)}`, {
                    method: "PATCH",
                    body: { role: select.value },
                  });
                  announce(`${m.email}: ${ROLE_LABELS[select.value].toLowerCase()}`);
                  await refresh();
                } catch (err) {
                  error.show(err);
                }
              },
            },
            h("option", { value: "view" }, "Can view"),
            h("option", { value: "edit" }, "Can edit"),
          );
          select.value = m.role;
          const remove = h(
            "button",
            {
              type: "button",
              class: "icon-btn",
              "aria-label": `Remove ${m.email}`,
              title: "Remove",
              onClick: async (e) => {
                try {
                  await busy(e.currentTarget, "", async () => {
                    await api(`/v1/spaces/${encodeURIComponent(sharedId)}/members/${encodeURIComponent(m.id)}`, { method: "DELETE" });
                    // New key, so they can't read anything saved from now on.
                    if (m.status === "active") await rotateSpaceKey(sharedId);
                  });
                  announce(`Removed ${m.email}`);
                  await refresh();
                } catch (err) {
                  error.show(err);
                }
              },
            },
            icon("close"),
          );
          control = h("span", { class: "member-actions" }, select, remove);
        }
        return h("li", { class: "settings-row member-row" }, label, control);
      }),
    );
    return detail;
  }

  const body = [];
  if (justShared) body.push(h("p", { class: "settings-hint" }, "Shared. Invite people below; the invitation appears in their Shelf when they sign in."));
  body.push(
    h(
      "section",
      { class: "settings-group", "aria-labelledby": "share-people" },
      h("h3", { class: "overline", id: "share-people" }, "People"),
      list,
    ),
  );

  let detail = null;
  const actions = [];
  if (owner) {
    const email = h("input", {
      id: "share-email",
      type: "email",
      maxlength: "254",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "name@example.com",
      required: true,
    });
    const role = h("select", { class: "member-role", "aria-label": "Role" }, h("option", { value: "view" }, "Can view"), h("option", { value: "edit" }, "Can edit"));
    const invite = h(
      "button",
      {
        type: "submit",
        class: "btn btn-secondary",
      },
      "Invite",
    );
    const form = h(
      "form",
      {
        class: "invite-form",
        onSubmit: async (event) => {
          event.preventDefault();
          error.show(null);
          const address = email.value.trim();
          if (!address) return email.focus();
          try {
            const res = await busy(invite, "Inviting…", () =>
              api(`/v1/spaces/${encodeURIComponent(sharedId)}/members`, { method: "POST", body: { email: address, role: role.value } }),
            );
            email.value = "";
            announce(res.emailed || res.email === "off" ? `Invited ${address}` : `Invited ${address}, but the email didn't send`);
            if (res.email === "off") error.show(`Invited. Let ${address} know: they'll find it under Invitations in Shelf's account menu after signing in with that address.`, { info: true });
            else if (!res.emailed) error.show("Invited, but the email didn't send. Tell them to open Shelf and sign in with that address.");
            await refresh();
          } catch (err) {
            error.show(err);
          }
        },
      },
      h("label", { for: "share-email", class: "sr-only" }, "Email address"),
      email,
      role,
      invite,
    );
    body.push(
      h(
        "section",
        { class: "settings-group", "aria-labelledby": "share-invite" },
        h("h3", { class: "overline", id: "share-invite" }, "Invite"),
        form,
        h("p", { class: "settings-hint" }, "They need a free Shelf account with this email. Removing someone gives the space a new key."),
      ),
    );
    actions.push(
      h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-quiet-danger",
          onClick: async (e) => {
            try {
              await busy(e.currentTarget, "Stopping…", () => stopSharing(sharedId));
              announce(`Stopped sharing ${current.name}`);
              dialog.close();
            } catch (err) {
              error.show(err);
            }
          },
        },
        "Stop sharing",
      ),
    );
  } else {
    actions.push(
      h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-quiet-danger",
          onClick: async (e) => {
            const me = detail?.members.find((m) => m.isYou);
            if (!me) return;
            try {
              await busy(e.currentTarget, "Leaving…", () => leaveSpace(sharedId, me.id));
              announce(`Left ${current.name}`);
              dialog.close();
            } catch (err) {
              error.show(err);
            }
          },
        },
        "Leave space",
      ),
    );
  }
  body.push(error.el);
  actions.push(h("button", { type: "button", class: "btn btn-primary", onClick: () => dialog.close() }, "Done"));
  open(dialog, `Sharing ${current.name}`, body, actions, { onClose });
  detail = await refresh();
}

// ------------------------------------------------------------------ invites

export function openInvites({ invites, announce, onChanged, onClose }) {
  const dialog = dialogEl();
  const error = errorLine();
  const list = h("ul", { class: "settings-list member-list" });
  let pending = [...invites];

  function paint() {
    if (pending.length === 0) {
      list.replaceChildren(h("li", { class: "settings-row" }, h("span", { class: "meta" }, "No invitations waiting.")));
      return;
    }
    list.replaceChildren(
      ...pending.map((inv) => {
        const act = (kind) =>
          h(
            "button",
            {
              type: "button",
              class: kind === "accept" ? "btn btn-primary" : "btn btn-ghost",
              onClick: async (e) => {
                try {
                  await busy(e.currentTarget, kind === "accept" ? "Adding…" : "Declining…", () =>
                    api(`/v1/invites/${encodeURIComponent(inv.id)}/${kind}`, { method: "POST" }),
                  );
                  pending = pending.filter((x) => x.id !== inv.id);
                  announce(kind === "accept" ? `Added the space from ${inv.ownerEmail}` : "Declined");
                  paint();
                  await onChanged();
                  if (kind === "accept") syncNow().catch(() => {});
                } catch (err) {
                  error.show(err);
                }
              },
            },
            kind === "accept" ? "Accept" : "Decline",
          );
        return h(
          "li",
          { class: "settings-row member-row" },
          h("span", { class: "member-who" }, h("strong", {}, inv.ownerEmail), h("small", {}, `Shared a space · ${ROLE_LABELS[inv.role]}`)),
          h("span", { class: "member-actions" }, act("decline"), act("accept")),
        );
      }),
    );
  }
  paint();
  open(
    dialog,
    "Invitations",
    [
      list,
      h("p", { class: "settings-hint" }, "An accepted space appears in your sidebar once the owner's Shelf next opens and hands your browser the key."),
      error.el,
    ],
    [h("button", { type: "button", class: "btn btn-primary", onClick: () => dialog.close() }, "Done")],
    { onClose },
  );
}
