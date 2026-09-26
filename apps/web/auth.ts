/**
 * Auth.js v5 (_specs/tenant-auth.md): Google + Resend magic link, Drizzle
 * adapter on the shared @neo/db client, database sessions, and a household
 * tenant created for every new user.
 *
 * Config is built lazily per request (NextAuth(() => config)) so importing
 * this module never needs env vars or a database: the build and the test
 * suite run with neither. Without DATABASE_URL no provider is registered and
 * only DEV_AUTH_BYPASS can sign anyone in.
 */
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { hashPii, logger } from "@neo/core";
import {
  accounts,
  authenticators,
  createTenantForUser,
  findTenantForUser,
  sessions,
  users,
  verificationTokens,
  type Db,
} from "@neo/db";
import NextAuth, { type NextAuthConfig } from "next-auth";
import type { Provider } from "next-auth/providers";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { headers } from "next/headers";
import { authProviders, emailFrom, resendApiKey, type EnvSource } from "@/lib/env";
import { resolveAuthRedirect } from "@/lib/safe-redirect";
import { recordAudit } from "@/lib/server/audit";
import { getDb } from "@/lib/server/db";
import type { MembershipRole } from "@/lib/session";

declare module "next-auth" {
  interface Session {
    /** Set by the session callback; absent when the user has no household (tenant creation failed). */
    userId?: string;
    tenantId?: string;
    role?: MembershipRole;
  }
}

const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const SESSION_UPDATE_AGE_S = 24 * 60 * 60;
const MAGIC_LINK_MAX_AGE_S = 10 * 60;

/** "<first name>'s household", or "My household" when no name is known. */
export function householdName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${first}'s household` : "My household";
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function ipHash(): Promise<string | undefined> {
  try {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || undefined;
    return ip ? hashPii(ip) : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the user's tenant, creating the household once if it is missing (retry path of the spec). */
export async function resolveTenant(db: Db, userId: string, name: string | null | undefined) {
  const existing = await findTenantForUser(db, userId);
  if (existing) return existing;
  try {
    await createTenantForUser(db, { userId, name: householdName(name) });
    return await findTenantForUser(db, userId);
  } catch (err) {
    logger.error("Tenant creation retry failed", "auth", { userIdHash: hashPii(userId), errorMessage: errorMessage(err) });
    return undefined;
  }
}

/** Google OIDC profile -> Auth.js user, keeping the email_verified claim (exported for tests). */
export function googleProfile(p: { sub: string; name?: string; email?: string; picture?: string; email_verified?: boolean }) {
  return {
    id: p.sub,
    name: p.name ?? null,
    email: p.email ?? null,
    image: p.picture ?? null,
    emailVerified: p.email_verified === true ? new Date() : null,
  };
}

/** Registered providers for the current env (exported for tests). */
export function buildProviders(source: EnvSource = process.env): Provider[] {
  const enabled = authProviders(source);
  const providers: Provider[] = [];
  if (enabled.google) {
    providers.push(
      Google({
        clientId: source.AUTH_GOOGLE_ID,
        clientSecret: source.AUTH_GOOGLE_SECRET,
        authorization: { params: { scope: "openid email profile" } },
        // The default mapper leaves emailVerified empty; record Google's claim so
        // the users row reflects it (the signIn callback still requires it to be true).
        profile: (p) => googleProfile(p),
      }),
    );
  }
  if (enabled.resend) {
    const key = resendApiKey(source);
    providers.push(
      Resend({
        ...(key ? { apiKey: key } : {}),
        from: emailFrom(source),
        maxAge: MAGIC_LINK_MAX_AGE_S,
        // No key (only possible in MOCK_MODE on a non-deployed environment, see
        // authProviders): log the link to the server console instead of sending it.
        ...(key
          ? {}
          : {
              sendVerificationRequest: async ({ url }: { url: string }) => {
                console.warn(`[auth] MOCK_MODE magic link (not emailed): ${url}`);
              },
            }),
      }),
    );
  }
  return providers;
}

export function buildAuthConfig(source: EnvSource = process.env): NextAuthConfig {
  const db = getDb();
  const providers = buildProviders(source);
  return {
    providers,
    ...(db
      ? {
          adapter: DrizzleAdapter(db, {
            usersTable: users,
            accountsTable: accounts,
            sessionsTable: sessions,
            verificationTokensTable: verificationTokens,
            authenticatorsTable: authenticators,
          }),
          session: { strategy: "database" as const, maxAge: SESSION_MAX_AGE_S, updateAge: SESSION_UPDATE_AGE_S },
        }
      : { session: { strategy: "jwt" as const, maxAge: SESSION_MAX_AGE_S } }),
    pages: { signIn: "/", error: "/", verifyRequest: "/?signin=check-email" },
    callbacks: {
      async signIn({ account, profile }) {
        // Google: only verified email addresses.
        if (account?.provider === "google") return profile?.email_verified === true;
        return true;
      },
      redirect({ url, baseUrl }) {
        return resolveAuthRedirect(url, baseUrl);
      },
      async session({ session, user }) {
        if (!db || !user?.id) return session;
        const tenant = await resolveTenant(db, user.id, user.name);
        if (!tenant) return session;
        return { ...session, userId: user.id, tenantId: tenant.tenantId, role: tenant.role };
      },
    },
    events: {
      async createUser({ user }) {
        if (!db || !user.id) return;
        try {
          await createTenantForUser(db, { userId: user.id, name: householdName(user.name) });
        } catch (err) {
          // The session callback retries once; see resolveTenant.
          logger.error("Tenant creation on first sign-in failed", "auth", {
            userIdHash: hashPii(user.id),
            errorMessage: errorMessage(err),
          });
        }
      },
      async signIn({ user, account }) {
        if (!db || !user.id) return;
        const tenant = await findTenantForUser(db, user.id).catch(() => undefined);
        if (!tenant) return;
        const ip = await ipHash();
        await recordAudit(tenant.tenantId, user.id, "auth.sign_in", {
          provider: account?.provider ?? "unknown",
          ...(ip ? { ipHash: ip } : {}),
        });
      },
      async signOut(message) {
        const userId = "session" in message ? message.session?.userId : message.token?.sub;
        if (!db || !userId) return;
        const tenant = await findTenantForUser(db, userId).catch(() => undefined);
        if (!tenant) return;
        const ip = await ipHash();
        await recordAudit(tenant.tenantId, userId, "auth.sign_out", ip ? { ipHash: ip } : {});
      },
    },
    logger: {
      error(error) {
        logger.error("Auth.js error", "auth", { errorType: error.name, errorMessage: errorMessage(error) });
      },
      warn(code) {
        logger.warn("Auth.js warning", "auth", { errorType: code });
      },
      debug() {},
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => buildAuthConfig());
