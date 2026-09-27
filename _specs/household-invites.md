# Spec for household-invites

branch: claude/feature/household-invites
plan: `_plans/phase-3-household-devices.md` (delivery step 1)

## Summary

A household owner can invite people to their household, see who has joined, and remove members. Members can
leave. This is the base for monitored devices and owner alerts (later steps of the plan). Until now every user has
owned a one-person household created at first sign-in (`createTenantForUser`); `memberships` already carries
`owner` / `member` roles and the dashboard already enforces them (`_specs/dashboard.md`), but no one can join
another person's household.

There are two kinds of invite, both single-use and valid for 7 days:

- **Email invite**: sent by Neo to one address. Only an account whose verified email matches can accept it.
- **Link invite**: a link the owner copies and shares however they like (text message, in person). Anyone signed
  in who opens it can accept it. Meant for a parent whose email the owner cannot type correctly, or who has none yet.

A user belongs to exactly one household. Joining one means leaving (and deleting) your own one-person household;
leaving one gives you a fresh one-person household on your next request, as today.

Usage caps are unchanged: they are per tenant, so members share the household's caps.

## Functional requirements

Data (migration `0007_household_invites`):

- Table `household_invites`: `id` uuid, `tenant_id` (FK tenants, cascade), `kind` (`email` | `link`),
  `email` (lowercased, required for `email`, null for `link`), `token_hash` (SHA-256 of the secret, unique),
  `token_prefix` (first 8 chars, for display), `invited_by` (FK users, set null), `created_at`, `expires_at`,
  `accepted_by` (FK users, set null), `accepted_at`, `revoked_at`. RLS `tenant_isolation` like 0001.
- Security-definer `lookup_household_invite(token_hash text)` → `(id, tenant_id)` for a pending, unexpired,
  unrevoked invite, following the pattern and grants of `resolve_inbound_address` (0003).
- Unique index `memberships_one_household` on `memberships(user_id)`. The migration aborts with a clear message if
  existing rows violate it (none are expected; every user owns exactly one household today).
- Invite secret: `neo_inv_` + 43 base64url chars (32 random bytes). Only the hash is stored. The link is
  `<origin>/invite/<secret>`, built from the request origin like `verificationUri` in desktop-auth.

API (browser session required on every route that creates, changes or accepts membership, via
`requireBrowserApiSession`; a desktop token gets 403 `browser_session_required`):

- `GET /api/household` (existing) gains `invites` for owners: pending, unexpired invites with
  `{ id, kind, email, tokenPrefix, createdAt, expiresAt, invitedByName }`. Members get `invites: []`.
- `POST /api/household/invites { kind: "email", email }` or `{ kind: "link" }` (owner) → 201
  `{ invite, url }`. `url` is returned only here, once; it is also the email's link for `email` invites.
  - 400 `invalid_email`; 409 `already_member` (the address belongs to a current member); 409 `invite_pending`
    (an unexpired email invite to the same address exists: revoke it or resend it).
  - 400 `household_full` when members + pending invites would exceed **10**.
  - 429 `rate_limited` at 20 invites per 24 h per tenant.
  - Email invites are sent with the Resend mailer (MOCK_MODE: `memorySentEmails()`), idempotency key
    `invite:<id>`. The email names the inviter and the household, says what joining means, and that the link
    expires in 7 days. Send failure returns 502 `email_failed` and revokes the invite.
- `POST /api/household/invites/:id/resend` (owner, email invites only) → 200 `{ invite }`: issues a new secret, resets
  `expires_at`, sends again (idempotency key `invite:<id>:<n>`). Same rate limit bucket.
- `DELETE /api/household/invites/:id` (owner) → 204; sets `revoked_at`. 404 for unknown or not pending.
- `GET /api/invites/:secret` (session required, any role) → 200 preview
  `{ householdName, inviterName, kind, emailMatches, alreadyMember, currentHousehold: { name, role, memberCount,
  conversationCount, verdictCount, hasForwardingAddress } }`. 404 `not_found` for unknown, expired, revoked or
  used. 429 at 10 per 10 minutes per user.
- `POST /api/invites/:secret/accept { confirmLeave: true }` (browser session) → 200 `{ tenantId, householdName }`.
  Rules, checked in this order inside one transaction:
  1. The invite is pending (else 404 `not_found`).
  2. `email` invites: the session email (lowercased) equals the invite email and the user's email is verified
     (else 403 `email_mismatch`).
  3. The user is not already a member of the inviting household (else 409 `already_member`).
  4. The user's current household is theirs alone: they are its owner and its only member (else 409
     `owns_household_with_members` for an owner with members, 409 `already_in_household` for a member of
     another household, who must leave first).
  5. `confirmLeave` is `true` (else 400 `confirm_required`); the UI shows what will be deleted first.
  Then: mark the invite accepted, delete the user's old tenant (cascade deletes its conversations, verdicts,
  artifacts, forwarding address and usage rows; their blobs are deleted after commit, see edge cases), insert a `member` membership in the inviting tenant, revoke every
  desktop token and pending desktop-auth request the user holds (they snapshot the old tenant), and write audit
  events in both tenants. 429 at 10 per 10 minutes per user.
- `DELETE /api/household/members/:userId` (owner) → 204. Cannot target the owner (400 `cannot_remove_owner`).
  404 for a non-member.
- `POST /api/household/leave` (member) → 204. Owners get 400 `owner_cannot_leave`.
- Removing or leaving: delete the membership, delete the leaver's conversations and turns in the household
  (their private chats), keep their verdicts (household security history; shown as "Former member"), revoke their
  desktop tokens and delete their pending desktop sign-ins. The next request resolves no tenant and
  `resolveTenant` creates a fresh one-person household, as today.

Sessions:

- The Auth.js `session` callback already resolves the tenant per request, so a browser session moves to the new
  household on the next request. Desktop tokens are revoked rather than re-pointed.
- `findTenantForUser` keeps its ordering; with the unique index it can return only one row.

Emails (Resend, plain HTML + text like the verdict email):

- Invite (to the invitee).
- "<name> joined your household" (to the owner) on accept.
- "You were removed from <household>" (to the member) on removal. No email on leave.

Audit events: `household.invite_created`, `household.invite_revoked`, `household.invite_resent`,
`household.invite_accepted` (inviting tenant; the deleted household's id is logged, hashed, since its own audit
rows are deleted with it), `household.member_removed`, `household.member_left`.
Emails in metadata are hashed with `hashPii`.

UI:

- **Settings → Household** (`/settings/household`), linked from Settings. Owner: household name, members
  (name, email, role, joined, Remove), pending invites (email or "Link invite", expires, Resend / Revoke), and an
  Invite form (email field, or "Create a link" which shows the URL once with a Copy button and a note that anyone
  with the link can join). Member: household name, owner, members' names, and Leave household.
- **`/invite/[secret]`**: signed-out visitors go through `requireSession(returnTo)` like `/desktop/authorize`.
  Signed in, the page shows who invited them to which household and what joining means: the owner will see their
  verdicts and alerts; their current one-person household and its history (counts from the preview) will be
  deleted. One primary button, "Join <household>", and "Not now". Each 4xx code has its own message
  (wrong account for `email_mismatch`, with a sign-out link; owners with members are told to remove them first).
- Confirmations for Remove and Leave use in-page dialogs, not `window.confirm`.

MOCK_MODE and tests: an in-memory invite store and in-memory membership moves, like `desktop-auth`, so the flow
runs without `DATABASE_URL`.

Contracts: add the routes, error codes and `household_invites` to `docs/contracts.md` before implementation.
Privacy page: add that household owners see members' verdicts and alerts, and that joining deletes your previous
one-person household.

## Possible edge cases

- **A brand-new user opens an invite.** Sign-in creates their one-person household first (`createUser` event);
  it is empty, so accepting deletes nothing of value. The preview shows zero counts.
- **Invite forwarded to the wrong person.** Email invites only work for the matching verified address; link
  invites are single-use, so the owner sees an unexpected member and can remove them. The link invite UI says so.
- **Invitee has used Neo for months on their own.** The preview lists the conversations, verdicts and forwarding
  address that will be deleted. Moving history between households is out of scope.
- **Two accepts of one link at once.** The accept transaction locks the invite row (`FOR UPDATE`) and checks
  `accepted_at` after locking; the loser gets 404.
- **Two invites accepted by one user at once.** The unique `memberships(user_id)` index makes the second insert
  fail; it returns 409 `already_in_household` and its transaction (including the old-tenant delete) rolls back.
- **Owner removes a member while the member is mid-chat.** The member's next request lands in a fresh household;
  the in-flight turn fails to persist and the client shows the generic storage error.
- **Invite to an address that later becomes a member through a link invite.** Accepting the email invite then
  returns 409 `already_member`; it stays pending until it expires or is revoked.
- **Household deleted by owner** (not built yet): cascade removes invites.
- **Blob objects of the deleted household.** Artifact rows cascade; blobs are deleted in the same request after
  commit (best effort, logged on failure) through `BlobClient` (`packages/db/src/blob.ts`).
- **Desktop token used to accept.** 403 `browser_session_required`, so a stolen token cannot move an account.
- **Secret in the URL path.** `/invite/[secret]` sends `Referrer-Policy: no-referrer`, loads no third-party
  resources, and the secret is never logged (log `tokenPrefix` only).
- **Case and whitespace in emails.** Normalized (trim, lowercase) on invite and on comparison.

## Acceptance criteria

- [x] Email invite accepted by the matching account: membership moves, the old household and its data are gone, the
      owner is emailed (`packages/db/test/household-invites.test.ts`, `apps/web/test/household-invites.test.ts`).
- [ ] The same on production with two real accounts, including the dashboard member filter.
- [x] Link invite accepted by a second account; reusing the link returns 404.
- [x] Wrong account or unverified email for an email invite: 403 `email_mismatch`, nothing changes.
- [x] Owner with members cannot accept (409); member of another household cannot accept (409).
- [x] Remove and leave: membership gone, the user's conversations in the household deleted, verdicts kept, desktop
      tokens revoked, next sign-in creates a fresh household.
- [x] Expired, revoked and used invites return 404; resend issues a new link and the old one stops working.
- [x] Limits: 10 members + pending, 20 invites per day, accept and preview rate limits return 429 with `Retry-After`.
- [x] Desktop tokens get 403 on every mutating household route.
- [x] Migration 0007 applies on PGlite; RLS test covers `household_invites`; the flow runs as `app_user`.
- [ ] Migration 0007 applied on Neon (production).
- [x] Emails render in MOCK_MODE (`memorySentEmails()`).
- [ ] Invite email delivered by Resend in production.

## Open questions

- Should a household be able to have a second owner (two parents)? Out of scope here; the role check constraint
  already allows it, so it can be added without a migration.
- Ownership transfer and deleting a household. Out of scope; needed before an owner can ever join another household.

## Testing guidelines

- `packages/db/test/household-invites.test.ts` (PGlite, committed migrations): secret format and hashing, lookup
  function returns only pending invites, accept transaction (deletes old tenant, inserts membership, locks the
  invite), unique-membership race, leave/remove data rules.
- `packages/db/test/rls.test.ts`: `household_invites` isolation.
- `apps/web/test/household-invites.test.ts` (routes on memory stores): every status code above, owner vs member
  vs desktop token, rate limits, emails recorded in `memorySentEmails()`.
- `apps/web/test/invite-page.test.tsx`: preview copy for a new user vs one with history, and each error message.
