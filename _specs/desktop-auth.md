# Spec for desktop-auth

branch: claude/desktop-auth
plan: `_plans/phase-3-desktop-auth.md`

## Summary

Desktop and shell clients (first: the Omarchy NeoShield bar plugin, later the Tauri app) call the same
API as the browser, authenticated with a **desktop token** (`Authorization: Bearer neo_dt_…`) instead of a
session cookie. A token is obtained by **signing in through the browser** with the existing Google or
magic-link login, using a device-authorization flow shaped like RFC 8628: the client shows a short code,
the person approves it on a signed-in page, the client redeems a secret device code for the token.
No token is ever copied by hand; the manual create-and-paste path on Settings → Desktop stays as a fallback.

## Functional requirements

Desktop tokens (migration `0005_desktop_tokens`):

- `neo_dt_` + 43 base64url chars (32 random bytes). Only the SHA-256 hash is stored, with an 8-char display
  prefix, a name, `last_used_at`, `revoked_at`; `tenant_id` and `role` are snapshotted at creation.
- `getSession()` accepts a Bearer desktop token and resolves it to `{ userId, tenantId, role, desktopTokenId }`.
  Every existing route therefore works for a desktop client unchanged. `email` is empty and `name` is `"desktop"`.
- `GET|POST /api/settings/desktop-tokens` need a **browser** session (a desktop token cannot mint tokens:
  403 `browser_session_required`). `DELETE ?id=` accepts a desktop token only for its own id (`omarchy-neo logout`).
- At most 10 active tokens per user; names 1–64 chars.

Device authorization (migration `0006_desktop_auth`, table `desktop_auth_requests`, no RLS like Auth.js sessions):

- `POST /api/desktop/device { clientName? }` (no auth) → 201 `{ deviceCode, userCode, verificationUri,
  verificationUriComplete, expiresIn: 600, interval: 5 }`. `userCode` is `XXXX-XXXX` from a 25-char alphabet
  without look-alikes; `deviceCode` is `neo_dc_` + 43 base64url chars, stored hashed. `verificationUri` is
  built from the request origin so previews and self-hosts get their own host. 429 `rate_limited` at 10/hour per IP.
- `/desktop/authorize?code=` requires a session; `requireSession(returnTo)` sends signed-out users to
  `/?signin=required&next=…` and the landing page hands `next` (same-origin path only, `safeCallbackPath`) to
  Auth.js as the callback URL. The page shows the code, the client name and the signed-in account, and asks the
  person to approve only if they started it and the code matches. Without `?code=` it offers a code input.
- `POST /api/desktop/device/approve { userCode, approve }` (browser session) → 200 `{ status, clientName }`.
  404 `not_found` (unknown or expired), 409 `already_decided`, 429 `rate_limited` at 20 per 10 minutes per user.
  Approval snapshots `{ userId, tenantId, role, email, name }` onto the row; it does **not** mint a token.
- `POST /api/desktop/device/token { deviceCode }` (no auth) → 202 `{ status: "pending", interval }` until decided;
  200 `{ status: "approved", token, tokenId, clientName, email, name }` **once**: the row is deleted first, then
  the desktop token is minted named after the client; 403 `denied`, 410 `expired`, 404 `not_found` (also after
  redemption), 400 `token_limit`; 429 at 60/minute per IP.
- Requests expire after 10 minutes; expired rows are purged on the next start and reported once as `expired`.
- Without `DATABASE_URL` every piece has an in-memory twin (MOCK_MODE and tests).

Plugin (`omarchy-neoshield-plugin`):

- `omarchy-neo login [--base-url] [--no-browser] [-y]`: start → print code and link → `xdg-open` → poll → verify the
  token against `/api/usage` → save `config.json` (mode 600, with `tokenId` and `account`) → start the systemd poller.
  Refuses plain `http://` except localhost. `setup` is an alias; `setup --paste` keeps the manual path.
- `omarchy-neo logout` revokes its own token via `DELETE /api/settings/desktop-tokens?id=` and clears the config.
- The panel's setup card says "Sign in with Neo" and launches `login` in a terminal.

## Possible edge cases

- Two polls redeem at once: the delete-then-mint order means only one wins; the other sees `not_found`.
- The approver already has 10 tokens: redemption returns 400 `token_limit`; the row is consumed, the CLI says to revoke one.
- The person signs in as a different account than they expected: the page names the account; the CLI prints "Signed in as <email>".
- Someone sends a victim an authorize link with the attacker's code: the page warns to approve only a sign-in they started;
  approving would bind the *victim's* account to the attacker's device, so the warning is prominent and codes expire in 10 minutes.
- Someone guesses a pending user code and approves it with their own account: the victim's CLI would sign in as the attacker;
  mitigated by the 25^8 code space, 10-minute life and the 20 per 10 min per-user approval limit.
- The CLI is rate limited while polling: it backs off (doubling, max 60 s) instead of failing.
- Membership changes after a token is minted: the token keeps its snapshotted tenant and role until revoked (documented limitation).

## Acceptance criteria

- [x] Full flow on the in-memory store: start → pending → approve → redeem once → Bearer session → self-revoke (`apps/web/test/desktop-auth.test.ts`).
- [x] Full flow on PGlite with the committed migrations (`packages/db/test/desktop-auth.test.ts`).
- [x] A desktop token gets 403 on token management and on approve; can only revoke itself.
- [x] Unknown, expired, denied and already-redeemed codes return the documented statuses; rate limits return 429 with `Retry-After`.
- [x] `omarchy-neo login` against a MOCK_MODE dev server signs in, lists the token under Settings → Desktop, `logout` revokes it.
- [ ] On production: migrations 0005 and 0006 applied, then `omarchy-neo login` with a real Google account.

## Open questions

- Whether to also let a token refresh itself (rotate) without a browser. Not needed for a bar widget; revisit with the Tauri app.
- Per-instance rate limits are per Vercel function instance. Good enough while secrets are unguessable; move to a shared store if abuse shows up in logs.

## Testing guidelines

`apps/web/test/desktop-auth.test.ts` (routes + session on memory stores), `packages/db/test/desktop-auth.test.ts`
(codes, normalization, PGlite flow), `packages/db/test/desktop-tokens.test.ts`, plugin `tests/test_neo.py`.
