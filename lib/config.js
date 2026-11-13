// Where the extension's account features talk to. Public values only: no
// secret ever ships in the extension. `scripts/build.mjs` copies the two
// origins into the manifest (host permissions and CSP connect-src) and
// refuses a store build while any value below is still a placeholder.
// A fork that runs its own server changes these values.

export const CONFIG = Object.freeze({
  // Clerk Frontend API of the Shelf application (development instance).
  // Decoded from the publishable key; becomes https://clerk.<your-domain>
  // once a production instance exists.
  clerkFrontendApi: "https://clerk.autoshelf.site",
  // Client ID of the Clerk OAuth application "Shelf extension" (public
  // client, PKCE required). Placeholder until that app is created.
  clerkOAuthClientId: "jXV0njNsQrkmVtPp",
  // The Shelf API (a Cloudflare Worker).
  apiBase: "https://api.autoshelf.site",
  // The website (Cloudflare Pages): pricing, checkout and account pages.
  website: "https://autoshelf.site",
  // Flip to true once Paddle's live account is approved and the live keys are
  // set. While false, the Upgrade dialog
  // says Pro is coming soon instead of opening the (sandbox) checkout.
  paymentsLive: false,
  // Launch period: false means there are no plans at all. Everyone gets every
  // feature, and nothing mentions Pro, prices or subscriptions. The server
  // matches it with EVERYONE_PRO. Flip both together when Pro goes on sale.
  plansEnabled: false,
});

export const PLACEHOLDER = /replace/i;
