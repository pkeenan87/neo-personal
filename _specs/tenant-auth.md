# Spec for Tenant Auth

branch: claude/feature/tenant-auth

## Summary

Sign-in and household tenancy for Phase 0. Auth.js v5 in `apps/web` with two providers: Google OAuth and email magic links sent through Resend. On a user's first sign-in, Neo creates a household tenant with that user as `owner` (`createTenantForUser` in `@neo/db`). Every authenticated request resolves a server-side session `{ userId, tenantId, role }`, and every tenant-scoped operation takes `tenantId` from that session only.

Apple Sign In and passkeys come in Phase 2 with the mobile app; household invites and additional members also come in Phase 2. `DEV_AUTH_BYPASS` gives local development a signed-in dev user and is refused in production.

## Functional requirements

Auth.js configuration (`apps/web`, e.g. `auth.ts` exporting `{ handlers, auth, signIn, signOut }`)
- Providers: `Google` (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`) and `Resend` (`AUTH_RESEND_KEY`, from address `EMAIL_FROM`). A provider whose env vars are unset is not registered, and the sign-in page shows only registered providers.
- Adapter: `@auth/drizzle-adapter` on `createDb()` from `@neo/db`, using the `users`, `accounts`, `sessions`, and `verificationTokens` tables from `@neo/db` `schema` (auth tables are global, not tenant-scoped).
- Session strategy: `database` (sessions revocable server-side, which a security product needs). Session max age 30 days, rolling update every 24h.
- `AUTH_SECRET` is required when `DEV_AUTH_BYPASS` is not active; the app fails fast at startup without it in production.
- Route handler at `/api/auth/[...nextauth]`.
- Magic link: tokens expire after 10 minutes and are single use (Auth.js default verification tokens). The email is plain, branded, and contains no tracking pixels.
- Google: request only `openid email profile`. Require `email_verified` from Google.
- Account linking: do not enable `allowDangerousEmailAccountLinking`. A user who signed up with a magic link and later uses Google with the same verified email is linked only if Auth.js's safe linking allows it; otherwise show a clear "sign in with your original method" message.

Household tenant on first sign-in
- In the Auth.js `events.createUser` hook (fires once, when the adapter creates the user), call `createTenantForUser(db, { userId, name })` where `name` is `"<first name>'s household"` or `"My household"` when no name is known. It creates the tenant and a membership with role `owner` in one transaction.
- Idempotent: if a membership already exists for the user (retry, race between two tabs), do not create a second tenant.
- If tenant creation fails, the session callback detects the missing membership and retries `createTenantForUser` once; if it still fails, the user sees an error page and no tenant-scoped route is reachable.

Session shape
- The `session` callback loads the user's membership and returns `session.user` plus `{ userId, tenantId, role }` where `role` is `"owner" | "member"` (Phase 0 only creates owners). Augment the `Session` type via module declaration so it is typed everywhere.
- A user with more than one membership (not possible in Phase 0) uses the most recently active; tenant switching is Phase 2.
- Server helper `requireSession(): Promise<{ userId, tenantId, role }>` used by every API route and server component that touches tenant data. It returns 401 JSON for API routes and redirects to `/` for pages.
- `tenantId` is **never** read from a request body, query string, header, or cookie other than the Auth.js session cookie.

Route protection
- Public: `/`, `/api/auth/*`, `/api/health`, static assets.
- Authenticated: `/chat`, `/chat/[id]`, `/api/agent`, `/api/agent/confirm`, `/api/conversations`.
- Protection runs in the route itself via `requireSession()`. A Next.js middleware / proxy redirect for pages is a convenience, not the enforcement point.
- Conversation access checks `tenantId` (via `tenantScoped`) and, in Phase 0, also `userId` (members will not see each other's chats by default).

DEV_AUTH_BYPASS
- When `DEV_AUTH_BYPASS=true` **and** `NODE_ENV !== "production"` **and** `VERCEL_ENV !== "production"` **and** `VERCEL_ENV !== "preview"`, `requireSession()` returns a fixed dev identity (`dev@neo.local`), creating the dev user and its tenant on first use if a database is configured.
- If `DEV_AUTH_BYPASS=true` in production or preview, the app logs an `error`, ignores the flag, and uses real auth. It never grants a session.
- A visible "Dev auth bypass active" banner shows on every page while it is active.

Audit
- Write `audit_events` rows (tenant-scoped) for `auth.sign_in`, `auth.sign_out`, and `tenant.created`, with provider name and a hashed IP (`hashPii`). Never log emails in plain text or tokens.

Sign-out
- Deletes the database session. "Sign out everywhere" (delete all sessions for the user) is in the account menu.

## Possible Edge Cases

- User signs in with Google, then later requests a magic link for the same email: must resolve to the same user and tenant, not a second household.
- Two concurrent first sign-ins (two tabs completing the magic link): only one tenant is created (unique constraint on `memberships.user_id` for owners in Phase 0, or a transaction-level check).
- Magic link opened on a different device or by an email security scanner that pre-fetches links: Auth.js single-use tokens mean the scanner can consume the token. Mitigate with a confirmation page that requires a click (POST) to complete sign-in.
- Magic link expired or reused: clear error with a "send a new link" action.
- Email addresses differing by case or with `+tags`: normalize case; treat `+tags` as distinct addresses.
- Resend unset (`AUTH_RESEND_KEY` missing): magic link option hidden; in `MOCK_MODE=true` the link is logged to the server console instead of sent.
- Google account with unverified email: reject.
- Session exists but the user's tenant was deleted ("delete everything"): session is invalidated and user is signed out.
- `AUTH_URL` wrong or unset behind a proxy: callback URL mismatch; `AUTH_TRUST_HOST=true` on Vercel.
- Preview deployments: Google OAuth redirect URIs cannot use wildcards; previews rely on magic links.
- Open redirect via `callbackUrl`: only allow same-origin relative paths.

## Acceptance Criteria

- A new user can sign in with Google or a magic link, lands on `/chat`, and has exactly one tenant with role `owner`.
- Signing in again (either method, same verified email) returns the same `userId` and `tenantId`.
- `auth()` / `requireSession()` return `{ userId, tenantId, role }` on the server, typed.
- Every authenticated API route returns 401 without a session and never accepts a client-supplied `tenantId`.
- A user cannot read or delete another tenant's conversation by guessing its id (404, not 403, to avoid confirming existence).
- `DEV_AUTH_BYPASS=true` works locally and has no effect when `NODE_ENV=production`, `VERCEL_ENV=production`, or `VERCEL_ENV=preview`.
- `tenant.created` and `auth.sign_in` audit events are written without plain-text PII.
- The build and tests pass with no auth env vars set.

## Open Questions

- Session strategy `database` adds a DB read per request. Acceptable for Phase 0; revisit with caching if latency matters.
- Should the magic-link email template live in `apps/web` or a shared `packages/email` for Phase 1 notifications? Proposal: `apps/web` now, extract in Phase 1.
- Allowlist or waitlist for signups at launch, in addition to usage caps? Plan says open signup with conservative caps.

## Testing Guidelines

Create test file(s) in the `apps/web/test/` folder (and `packages/db/test/` for `createTenantForUser`), and create meaningful tests for the following cases, without going too heavy:

- `createTenantForUser` creates one tenant and one `owner` membership, and is idempotent when called twice for the same user.
- The session callback returns `{ userId, tenantId, role }` for a user with a membership.
- `requireSession` returns 401 for API routes with no session.
- DEV_AUTH_BYPASS guard: active only when the flag is true and neither `NODE_ENV` nor `VERCEL_ENV` is production (and `VERCEL_ENV` is not preview); table-driven test over env combinations.
- Provider registration: Google omitted when `AUTH_GOOGLE_ID` is unset; Resend omitted when `AUTH_RESEND_KEY` is unset.
- `callbackUrl` sanitizer rejects absolute and protocol-relative URLs.
- Conversation route returns 404 for a conversation belonging to another tenant.
