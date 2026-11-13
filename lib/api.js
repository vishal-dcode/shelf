// Calls to the Shelf API (a Cloudflare Worker). Every call carries the Clerk access
// token; cookies are never sent. Errors come back as ApiError with the
// server's plain message, which never includes internals.

import { CONFIG } from "./config.js";
import { accessToken } from "./auth.js";

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = "GET", body, signal } = {}) {
  const token = await accessToken();
  let res;
  try {
    res = await fetch(`${CONFIG.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      signal,
    });
  } catch {
    throw new ApiError(0, "Can't reach Shelf's server. Check your connection.", "offline");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.code);
  return data;
}
