// Admin authentication by DELEGATION. Rather than reproduce nemar-cli's token
// hashing + table shape (the worst coupling), we forward the caller's Bearer
// token to nemar-cli's `GET /users/me` and trust its answer. The dashboard
// never reads the tokens/users tables for auth.
//
// v1 is Bearer-only: the admin pastes their nm_ API key in the UI. The
// app.nemar.org session cookie is not sent to dashboard.nemar.org (sibling
// domain), so cookie SSO is a separate future change.

import type { Bindings } from "../types";

export interface AdminUser {
  username: string;
  role: string;
}

/**
 * The three answers the check can give. "unavailable" is not "denied": the
 * identity service could not say, so a caller must not be told the token is
 * wrong, and nothing here may be cached as if it were an answer.
 */
export type AdminCheck =
  | { status: "admin"; admin: AdminUser }
  | { status: "denied" }
  | { status: "unavailable" };

const ADMIN_ROLES = new Set(["admin", "owner"]);
const DENIED: AdminCheck = { status: "denied" };
const UNAVAILABLE: AdminCheck = { status: "unavailable" };

/** How long the identity service may take before the check gives up. */
export const IDENTITY_TIMEOUT_MS = 5_000;

/**
 * Resolve an admin from the request's Authorization header. "denied" is: no or
 * empty Bearer, a token nemar-cli rejects (401, 403), or a user who is not an
 * admin. "unavailable" is: a network error, a timeout (of the request or of its
 * body), any other non-2xx status (a 5xx, a 429, a 404 from a wrong
 * NEMAR_API_BASE), a body that is not JSON, or JSON without a user and a string
 * role, each logged without the token or the body.
 */
export async function resolveAdmin(
  env: Bindings,
  authHeader: string | null,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<AdminCheck> {
  if (!authHeader) return DENIED;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return DENIED;
  const token = match[1].trim();
  if (!token) return DENIED;

  let res: Response;
  try {
    res = await fetch(`${env.NEMAR_API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network/DNS error or a timeout (e.g. misconfigured NEMAR_API_BASE). Say
    // "could not check", not "not an admin", and log loudly so an outage is
    // diagnosable.
    console.error("[auth] /users/me unreachable (check NEMAR_API_BASE):", env.NEMAR_API_BASE, err);
    return UNAVAILABLE;
  }
  if (res.status === 401 || res.status === 403) return DENIED; // bad/expired token: expected, no log
  if (!res.ok) {
    // Not a verdict on the token: the identity service is down, throttling or
    // misrouted. The body is not read, so nothing of it is logged.
    console.error("[auth] /users/me answered", res.status, "(check NEMAR_API_BASE)");
    return UNAVAILABLE;
  }

  let json: unknown;
  try {
    // The timeout covers this read too: a body that stalls after the headers ends here.
    json = await res.json();
  } catch (err) {
    // The error's name only: a JSON error message can quote the start of the body.
    const name = err instanceof Error ? err.name : "unknown";
    if (name === "TimeoutError" || name === "AbortError") {
      console.error("[auth] /users/me body did not arrive in time:", name);
    } else {
      console.error("[auth] /users/me returned a body that is not JSON:", name);
    }
    return UNAVAILABLE;
  }
  // A shape this check does not know is the identity service changing under
  // us, not a verdict on the token: say so (without the body) rather than
  // turn every admin away in silence.
  const user = (json as { user?: unknown } | null)?.user;
  const role = (user as { role?: unknown } | null | undefined)?.role;
  if (typeof user !== "object" || user === null || typeof role !== "string") {
    console.error("[auth] /users/me answered without a user and a string role; shape changed?");
    return UNAVAILABLE;
  }
  if (!ADMIN_ROLES.has(role)) return DENIED;
  const username = (user as { username?: unknown }).username;
  return {
    status: "admin",
    admin: { username: typeof username === "string" ? username : "unknown", role },
  };
}
