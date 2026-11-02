/**
 * Session resolution without Next's request scope (no `next/*` imports). One implementation of
 * the rules every caller shares:
 *
 *  1. `Authorization: Bearer neo_dt_…` decides on its own (also under DEV_AUTH_BYPASS), and a
 *     token resolves only if it holds the scope asked for.
 *  2. DEV_AUTH_BYPASS (ignored on production/preview, see lib/env.ts): a fixed dev identity.
 *  3. The browser cookie, read by an injected resolver: `getSession()` (lib/session.ts) uses
 *     Auth.js `auth()`, which needs Next's request scope; the eve agent (agent/lib/app-session.ts,
 *     a separate server process) uses `sessionFromCookieHeader` below, which reads the same
 *     `sessions` table the Drizzle adapter writes.
 *
 * `lib/session.ts` re-exports the types and `DEV_SESSION_IDS`, so existing imports keep working.
 */
import { hashPii, logger } from "@neo/core";
import { createTenantForUser, isDesktopTokenFormat, sessions, users, type Db, type TokenScope } from "@neo/db";
import { and, eq, gt } from "drizzle-orm";
import { devAuthBypassRefused, env } from "../env";
import { resolveBearerDesktopToken } from "./desktop-tokens";
import { getDb } from "./db";
import { resolveTenant } from "./household-tenant";

export type MembershipRole = "owner" | "member";
export type { TokenScope };

/** Browser (Auth.js or dev-bypass) sessions and `full` desktop tokens. */
export const FULL_SCOPES: TokenScope[] = ["full"];

/**
 * A signed-in person: a browser (Auth.js or dev-bypass) session or a `full` desktop token. The user
 * and the household role are always present, so browser routes and pages never null-check them.
 * `getSession()` and `requireApiSession()` return this for the default `full` scope.
 */
export interface NeoSession {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  email: string;
  name: string;
  /** Present when the session came from a `full` desktop personal access token. */
  desktopTokenId?: string;
  /** What this session may do: `["full"]` for browser sessions; a desktop token's own scopes. */
  scopes: TokenScope[];
  /** A person session never belongs to a device; narrows `NeoSession | DeviceSession` on `deviceId`. */
  deviceId?: undefined;
}

/** `NeoSession` under its person-only name, for code that wants to say so. */
export type PersonSession = NeoSession;

/**
 * A monitoring (device) token. The member comes from the device, never from the token holder: for a
 * member without an account (`userId` and `role` null: no membership, so no role) it is the only
 * identity there is. Device routes read `memberId`/`deviceId` and must not use `role`.
 */
export interface DeviceSession {
  tenantId: string;
  /** The member the device protects (read from the device row). */
  memberId: string;
  deviceId: string;
  /** The member's account; null for a member without one. */
  userId: string | null;
  /** The account's membership role snapshot; null with `userId`. Never an authority on a device route. */
  role: MembershipRole | null;
  email: string;
  name: string;
  desktopTokenId: string;
  scopes: TokenScope[];
}

/** Any resolved session: what a route with a non-`full` scope may receive. */
export type AnySession = NeoSession | DeviceSession;

/** True for a device token's session. */
export function isDeviceSession(session: AnySession): session is DeviceSession {
  return session.deviceId !== undefined;
}

/**
 * The audit actor for a device route: the member's account when it has one (as before), else no
 * user (`audit_events.user_id` is a users FK) and `device:<deviceId>` in the event metadata.
 */
export function deviceAuditActor(session: DeviceSession): { userId: string | null; metadata: { actor?: string } } {
  return session.userId ? { userId: session.userId, metadata: {} } : { userId: null, metadata: { actor: `device:${session.deviceId}` } };
}

/** Identity used by DEV_AUTH_BYPASS when there is no database. */
export const DEV_SESSION_IDS = {
  userId: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-0000000000aa",
} as const;

/** A signed-in browser user, as the cookie resolvers report them. */
export interface CookieIdentity {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  email: string;
  name: string;
}

export type Resolution = { session: AnySession; failure?: undefined } | { session: null; failure: "unauthenticated" | "insufficient_scope" };

const g = globalThis as typeof globalThis & {
  __neoDevIdentity?: { db: Db; email: string; ids: Promise<{ userId: string; tenantId: string }> };
  __neoBypassRefusedLogged?: boolean;
};

async function ensureDevIdentity(db: Db, email: string, name: string): Promise<{ userId: string; tenantId: string }> {
  await db.insert(users).values({ email, name }).onConflictDoNothing({ target: users.email });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!row) throw new Error("dev user could not be created");
  const { tenantId } = await createTenantForUser(db, { userId: row.id, name: "Dev household" });
  return { userId: row.id, tenantId };
}

async function devSession(): Promise<NeoSession> {
  const e = env();
  const base = { role: "owner" as const, email: e.DEV_USER_EMAIL, name: e.DEV_USER_NAME, scopes: [...FULL_SCOPES] };
  const db = getDb();
  if (!db) return { ...DEV_SESSION_IDS, ...base };
  if (g.__neoDevIdentity?.db !== db || g.__neoDevIdentity.email !== e.DEV_USER_EMAIL) {
    const ids = ensureDevIdentity(db, e.DEV_USER_EMAIL, e.DEV_USER_NAME);
    g.__neoDevIdentity = { db, email: e.DEV_USER_EMAIL, ids };
    ids.catch(() => {
      if (g.__neoDevIdentity?.ids === ids) g.__neoDevIdentity = undefined;
    });
  }
  return { ...(await g.__neoDevIdentity.ids), ...base };
}

/** The `neo_dt_…` token in an `Authorization: Bearer` header, or undefined when there is none. */
export function bearerDesktopToken(authorization: string | null | undefined): string | undefined {
  if (!authorization?.toLowerCase().startsWith("bearer ")) return undefined;
  const token = authorization.slice(7).trim();
  return isDesktopTokenFormat(token) ? token : undefined;
}

async function sessionFromDesktopToken(token: string, scope: TokenScope): Promise<Resolution> {
  try {
    const resolved = await resolveBearerDesktopToken(token);
    if (!resolved) return { session: null, failure: "unauthenticated" };
    if (!resolved.scopes.includes(scope)) return { session: null, failure: "insufficient_scope" };
    if (resolved.deviceId) {
      // A monitoring token needs the device's member; resolveDesktopToken returns it from the device row.
      if (!resolved.memberId) return { session: null, failure: "unauthenticated" };
      return {
        session: {
          userId: resolved.userId,
          tenantId: resolved.tenantId,
          role: resolved.role,
          memberId: resolved.memberId,
          email: "",
          name: "desktop",
          desktopTokenId: resolved.id,
          scopes: [...resolved.scopes],
          deviceId: resolved.deviceId,
        },
      };
    }
    // A full token is always a person's (desktop_tokens_subject_check).
    if (!resolved.userId || !resolved.role) return { session: null, failure: "unauthenticated" };
    return {
      session: {
        userId: resolved.userId,
        tenantId: resolved.tenantId,
        role: resolved.role,
        email: "",
        name: "desktop",
        desktopTokenId: resolved.id,
        scopes: [...resolved.scopes],
      },
    };
  } catch (err) {
    logger.error("Desktop token lookup failed", "auth", {
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { session: null, failure: "unauthenticated" };
  }
}

export interface ResolveInput {
  /** The request's Authorization header. */
  authorization: string | null | undefined;
  /** Scope a desktop token must hold. Browser sessions always resolve with `["full"]`. */
  scope: TokenScope;
  /** Reads the browser cookie session; null when there is none. */
  cookie: () => Promise<CookieIdentity | null>;
}

/**
 * The request's session, or why there is none. A Bearer desktop token decides on its
 * own (also under DEV_AUTH_BYPASS): valid with the scope, valid without it
 * (`insufficient_scope`), or unknown/revoked (`unauthenticated`).
 */
export async function resolveSessionCore(input: ResolveInput): Promise<Resolution> {
  const token = bearerDesktopToken(input.authorization);
  if (token) return sessionFromDesktopToken(token, input.scope);

  const e = env();
  if (e.DEV_AUTH_BYPASS) return { session: await devSession() };
  if (devAuthBypassRefused() && !g.__neoBypassRefusedLogged) {
    g.__neoBypassRefusedLogged = true;
    logger.error("DEV_AUTH_BYPASS is set on a production/preview deployment and is ignored", "auth");
  }

  const who = await input.cookie();
  if (!who) return { session: null, failure: "unauthenticated" };
  return { session: { ...who, scopes: [...FULL_SCOPES] } };
}

// ─── Cookie sessions without Next ──────────────────────────────────

/** Auth.js v5 session cookie names (the `__Secure-` prefix is used on https). */
const SESSION_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

/** Values of the named cookies in a `Cookie` header, in the order asked. */
export function cookieValues(header: string | null | undefined, names: readonly string[]): string[] {
  if (!header) return [];
  const found = new Map<string, string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!names.includes(name) || found.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      found.set(name, decodeURIComponent(value));
    } catch {
      found.set(name, value);
    }
  }
  return names.flatMap((n) => (found.has(n) ? [found.get(n)!] : []));
}

/**
 * The signed-in user behind an Auth.js session cookie, read straight from the `sessions` table
 * (database strategy, see auth.ts): token known, not expired, user has a household (created on
 * first use exactly as the Auth.js `session` callback does). Null without a database: the JWT
 * strategy used then never carries a tenant, so `getSession()` resolves no cookie session there
 * either, and DEV_AUTH_BYPASS is the only way in. Any error is null (fail closed).
 *
 * `sessions` is Auth.js's own table (keyed by an unguessable token, no `tenant_id`), so this is
 * the one place a lookup is not tenant-scoped; everything after it is.
 */
export async function sessionFromCookieHeader(cookieHeader: string | null | undefined, now = new Date()): Promise<CookieIdentity | null> {
  const db = getDb();
  if (!db) return null;
  try {
    for (const token of cookieValues(cookieHeader, SESSION_COOKIES)) {
      const [row] = await db
        .select({ userId: sessions.userId, email: users.email, name: users.name })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.sessionToken, token), gt(sessions.expires, now)))
        .limit(1);
      if (!row) continue;
      const tenant = await resolveTenant(db, row.userId, row.name);
      if (!tenant) {
        logger.warn("Signed-in user has no household", "auth", { userIdHash: hashPii(row.userId) });
        return null;
      }
      const email = row.email ?? "";
      return { userId: row.userId, tenantId: tenant.tenantId, role: tenant.role, email, name: row.name?.trim() || email.split("@")[0] || "there" };
    }
    return null;
  } catch (err) {
    logger.error("Cookie session lookup failed", "auth", { errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    return null;
  }
}

/**
 * The session of a request that has only headers (no Next request scope): the eve channel's caller.
 * The default `full` scope is always a person.
 */
export async function resolveRequestSession(headers: Headers, scope?: "full"): Promise<NeoSession | null>;
export async function resolveRequestSession(headers: Headers, scope: TokenScope): Promise<AnySession | null>;
export async function resolveRequestSession(headers: Headers, scope: TokenScope = "full"): Promise<AnySession | null> {
  const r = await resolveSessionCore({
    authorization: headers.get("authorization"),
    scope,
    cookie: () => sessionFromCookieHeader(headers.get("cookie")),
  });
  return r.session;
}
