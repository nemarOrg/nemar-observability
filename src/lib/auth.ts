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

const ADMIN_ROLES = new Set(["admin", "owner"]);

/**
 * Resolve an admin from the request's Authorization header, or null. Returns
 * null for: no/empty Bearer, an invalid/expired token, or a non-admin user.
 */
export async function resolveAdmin(
  env: Bindings,
  authHeader: string | null,
): Promise<AdminUser | null> {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  let res: Response;
  try {
    res = await fetch(`${env.NEMAR_API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    console.error("[auth] /users/me delegation failed:", err);
    return null;
  }
  if (!res.ok) return null;

  const json = (await res.json().catch(() => null)) as {
    user?: { username?: string; role?: string };
  } | null;
  const user = json?.user;
  if (!user?.role || !ADMIN_ROLES.has(user.role)) return null;
  return { username: user.username ?? "unknown", role: user.role };
}
