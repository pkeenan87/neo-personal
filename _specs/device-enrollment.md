# Spec for device-enrollment

branch: claude/feature/device-enrollment
plan: `_plans/phase-3-household-devices.md` (delivery step 3)

## Summary

The browser extension and the desktop agent (plan steps 5–7) run on a member's device and report to the household.
Before either exists, the server needs three things:

1. **Devices as records.** A `devices` table: which member a device protects, what it is, when it last checked in,
   whether it was revoked.
2. **Scoped credentials.** Today a `neo_dt_` token resolves to a full session that can read the household's
   conversations and verdicts. A token on a relative's PC must only be able to report signals, check URLs and keep its
   own device alive. Tokens gain `scopes` and a `device_id`; every existing route keeps requiring `full`, so a
   monitoring token reaches nothing new by accident.
3. **Enrollment without signing in on the device.** The owner generates a one-time **enrollment code** in Settings →
   Household for a member and types it into the extension or agent on that member's device. Nobody signs in to
   Google on grandma's PC. A member can also enroll their own device through the existing browser sign-in
   (device authorization), which then mints a monitoring token instead of a full one.

Devices check in with a **heartbeat**. A device that goes quiet raises a `device_offline` alert. A device removed by
the member or by itself raises a `device_removed` alert, because "uninstall that program" is what a scammer says.

Monitoring is visible: the member is emailed when a device is enrolled for them, sees their devices in Settings →
Household, and can remove them. This step ships no detection and stores no browsing or software data. Signals are
step 4.

## Functional requirements

### Data (migration `0009_devices`)

- **`devices`**:
  - Columns:
    - `id` uuid, `tenant_id` (FK tenants, cascade), `user_id` (the protected member; FK users, cascade).
    - `kind` (`browser_extension` | `desktop_agent`) and `platform` (`chrome` | `edge` | `firefox` | `windows` |
      `macos` | `linux`).
    - `name` (1–64 chars, client-supplied, e.g. "Chrome on Grandma's laptop"; the owner can rename it).
    - `client_version` (≤ 32 chars).
    - `enrolled_by` (FK users, set null) and `enrollment` (`code` | `self`).
    - `created_at`, `last_seen_at`, `offline_alerted_at`, `revoked_at`, `revoked_by` (FK users, set null).
  - RLS `tenant_isolation`. Index on `(tenant_id, user_id)`; partial index on `last_seen_at` where `revoked_at is null`.
- **`device_enrollment_codes`**:
  - Columns: `id`, `tenant_id` (cascade), `user_id` (member the device will protect; cascade),
    `code_hash` (SHA-256, unique), `created_by`, `created_at`, `expires_at`, `redeemed_at`,
    `device_id` (FK devices, set null), `revoked_at`.
  - RLS `tenant_isolation`.
  - Security-definer `lookup_device_enrollment_code(code_hash text) RETURNS TABLE(id uuid, tenant_id uuid)` for
    pending codes only. `EXECUTE` is revoked from PUBLIC and granted to `app_user`, like `lookup_household_invite`
    (migration, `sql/create-app-user.sql`, test helper).
- **`desktop_tokens`** gains:
  - `scopes text[] not null default '{full}'`, with a check that every element is a known scope. Existing rows
    backfill to `{full}`, so the Omarchy bar keeps working.
  - `device_id uuid null` (FK devices, cascade).
  - A check that a token with a `device_id` never has `full`, and a token without one always has it.
- **`alerts.kind`** check gains `device_enrolled`, `device_offline`, `device_removed`.
- `devices` and `device_enrollment_codes` join `tenantTables` and the RLS test's `TENANT_OWNED` list.

### Scopes

| Scope | Grants | Held by |
|---|---|---|
| `full` | Everything a browser session can do except credential management (unchanged) | Omarchy bar, Settings → Desktop tokens, normal device sign-in |
| `device` | Heartbeat, read and unenroll its own device | Every monitoring token |
| `signals:write` | `POST /api/signals` (step 4) | Every monitoring token |
| `url:check` | The on-demand URL check (step 4/5) | Every monitoring token |

Monitoring tokens get `device signals:write url:check`. Scopes are fixed at mint time; there is no upgrade path.

### Enforcement

- `getSession(opts?: { scope?: Scope })`: a desktop token resolves only if it holds `opts.scope ?? "full"`.
  Pages (`requireSession`) and every existing route therefore reject monitoring tokens without code changes at the
  call site.
- `requireApiSession(opts?)` returns 403 `insufficient_scope` (not 401) when the token is valid but lacks the
  scope, so a client does not mistake it for a revoked token and sign in again.
- `NeoSession` gains `scopes` and `deviceId?`. Browser sessions have `["full"]`.
- A token whose device is revoked, or whose member has left the household, does not resolve (the device join is
  part of the token lookup).
- `lastUsedAt` writes on monitoring tokens are throttled to once per 5 minutes per token, like today.

### Enrollment by code (owner)

- `POST /api/household/members/:userId/enrollment-codes` (owner, browser session) → 201
  `{ id, code, expiresAt, memberName }`.
  - `code` is `XXXX-XXXX-XXXX` from the device-flow 25-char alphabet with no look-alikes (≈ 56 bits).
  - The code is shown once and stored hashed.
  - The code expires after **24 hours** and is single-use.
  - The owner may generate one for themselves.
  - Errors: 404 `not_found` for a user who is not a member; 409 `limit` at 10 pending codes per household or
    20 active devices per household.
- `GET /api/household` adds `devices` (active, newest first) and `enrollmentCodes` (pending, without the code) to
  the response.
- `DELETE /api/household/enrollment-codes/:id` (owner, browser session) → 204; idempotent.
- `POST /api/devices/enroll/preview { code }` (no auth) → 200 `{ householdName, memberName, ownerName, expiresAt }`.
  - Lets the client show "This browser will report scam warnings for <member> to <owner>'s household" and ask for
    consent before redeeming.
  - Errors: 404 `not_found` for unknown, expired, revoked or used codes.
- `POST /api/devices/enroll { code, kind, platform, name, clientVersion }` (no auth) → 201
  `{ token, tokenId, device: DeviceItem, householdName, memberName }`.
  - In one transaction: lock the code row `FOR UPDATE`, re-check that it is pending, insert the device (enrollment
    `code`, `enrolled_by` = the code's creator), mint the scoped token for the member, mark the code redeemed.
  - Code input is case-insensitive and accepts it with or without dashes or spaces.
  - Errors: 404 `not_found`, 409 `limit` (the household reached 20 active devices), 400 `invalid` for an unknown
    kind or platform or a bad name.
- Rate limits: preview and enroll share **10 per hour per IP**, returning 429 with `Retry-After`.
- Enrollment by code does not count against the member's 10 desktop tokens; devices have their own cap.

### Self-enrollment (member, device authorization)

- `POST /api/desktop/device` accepts an optional `device: { kind, platform, name, clientVersion }`.
  - With it, the request is a **monitoring** request. Without it, behaviour is unchanged (a full token).
  - The request row stores the device fields (new nullable columns on `desktop_auth_requests`).
- `/desktop/authorize` shows what is being granted, and says it plainly:
  - Monitoring requests: "report scam warnings from this device to <household>. It cannot read your checks or
    chats."
  - Full requests: "full access to your Neo account".
- On redemption, a monitoring request creates the device (enrollment `self`, `enrolled_by` = the approver) and
  mints a monitoring token. The response adds `device: DeviceItem`.

### Heartbeat and self-service (scope `device`)

- `POST /api/devices/heartbeat { clientVersion? }` → 200 `{ device: DeviceItem, householdName, memberName,
  heartbeatSeconds: 3600 }`.
  - Sets `last_seen_at` (and `client_version` if given).
  - Clears `offline_alerted_at`, so the next outage alerts again.
  - Rate limit: 12 per hour per device.
- `DELETE /api/devices/self` → 204: revokes the device and its token.
  - Used by the extension's "Stop protecting this browser" and by the agent's uninstaller.

### Management (browser session)

- `PATCH /api/household/devices/:id { name }` (owner) → 200 `{ device }`.
- `DELETE /api/household/devices/:id` → 204, revoking the device and its token.
  - Allowed to the owner, and to the member for a device that protects them.
  - Otherwise 403 `forbidden`; unknown ids get 404.

### Alerts (templates in `lib/server/alerts/templates.ts`)

| Kind | Trigger | Severity | Title | Dedupe key |
|---|---|---|---|---|
| `device_enrolled` | Self-enrollment by a member | `low` | `<name> added <device>` | `device_enrolled:<deviceId>` |
| `device_offline` | No heartbeat for 48 hours | `medium` | `<device> (<name>) has not checked in for 2 days` | `device_offline:<deviceId>:<last_seen_at epoch>` |
| `device_removed` | Removed by the member, or by the device itself | `high` | `<name> removed <device>` / `<device> was uninstalled` | `device_removed:<deviceId>` |

- An owner's own actions (generating a code, enrolling, removing a device) never alert.
- Devices protecting the owner never raise `device_offline` or `device_removed`.
- `device_id` is set on the alert, and becomes an FK to `devices` (set null) in this migration.

### Offline job

- Inngest cron `devices-offline`, hourly.
- Selects active devices with `last_seen_at < now - 48h` and no `offline_alerted_at`, then raises `device_offline`
  and sets `offline_alerted_at`, per tenant through `tenantScoped()`.
- The cross-tenant scan uses a security-definer `list_stale_devices(before timestamptz)` returning
  `(id, tenant_id)` only.
- In `MOCK_MODE` the job is exported as a function the tests call.
- A device that has never sent a heartbeat counts from `created_at`.

### Member notification

- Enrollment by code emails the member:
  - Subject `A device is now protected by Neo`.
  - Body: who enrolled it, the device name, what it reports and what it never reports, and a link to Settings →
    Household to remove it.
  - Resend idempotency key `device-enrolled:<deviceId>`.
- Self-enrollment does not email the member, who just approved it.

### Lifecycle

- `detachMember` (leave or remove) revokes the member's devices and pending enrollment codes in the household, and the devices' tokens.
- Joining another household deletes the old tenant, and with it its devices (cascade).
- Revoking a device revokes every token with its `device_id`.
- Retention: devices revoked more than 90 days ago, and redeemed, revoked or expired codes older than 30 days, are
  deleted by the daily retention job (`purge_old_devices()`, security definer).

### Wire types and audit

- Wire types (`apps/web/lib/household-types.ts`):
  - `DeviceItem = { id, userId, memberName, kind, platform, name, clientVersion, enrollment, enrolledByName,
    createdAt, lastSeenAt, status: "active" | "offline" | "never_seen" }`.
  - `status` is computed: `offline` after 48 h without a heartbeat.
  - `EnrollmentCodeItem = { id, userId, memberName, createdAt, expiresAt }`.
- Audit events:
  - `device.enrollment_code_created` (`{ codeId, userId }`), `device.enrollment_code_revoked`.
  - `device.enrolled` (`{ deviceId, userId, enrollment }`), `device.renamed`.
  - `device.revoked` (`{ deviceId, by: "owner" | "member" | "device" }`).

### UI

- **Settings → Household**:
  - A "Devices" section under Members. For the owner it lists every active device, grouped by member, with
    kind/platform icon, name, "Last checked in 3 hours ago" or "Offline since Tuesday", Rename and Remove.
  - The owner gets "Add a device" per member, which reveals the code with a copy button, the expiry, and short
    instructions ("Install Neo on their browser or PC, choose *I have an enrollment code*, and enter this code").
    Pending codes are listed with Cancel.
  - Members see only their own devices, with Remove. Removing asks for confirmation ("<owner> will be told").
  - Until the extension and agent ship, "Add a device" says they are coming soon and the section is hidden when
    there are no devices. The endpoints exist for client development against MOCK_MODE.
- **Settings → Desktop** lists only `full` tokens; monitoring tokens are managed as devices.

### Contracts, privacy, mock mode

- **Contracts**: add the tables, scopes, `getSession` options and routes to `docs/contracts.md` before
  implementation.
- **Privacy page**: devices send a heartbeat (version, time); this step collects nothing else; members are told
  when a device is enrolled for them and can remove it.
- **Mock mode**: every store has an in-memory twin (`memory-devices.ts`).

## Possible Edge Cases

- **The owner reads the code to grandma over the phone.** The 12-character code in three groups is built for this.
  The 24-hour expiry leaves time, and a wrong guess costs one of 10 attempts per hour from that IP.
- **A code is intercepted.** Whoever redeems it gets a device that can only *send signals about the member*. It
  cannot read anything. The owner sees an unexpected device and removes it, and the member gets the enrollment
  email.
- **Two clients redeem the same code at once.** The `FOR UPDATE` lock means one device is created and the other
  gets 404 `not_found`.
- **The member is removed between code creation and redemption.** `detachMember` revokes their pending codes, and
  redemption re-checks that the member still belongs to the household (404 otherwise).
- **A monitoring token calls `/api/verdicts`, `/api/agent` or a page.** 403 `insufficient_scope` for API routes;
  pages treat it as signed out.
- **An old client sends a full-scope device-flow request from the monitoring UI.** Not possible to prevent on the
  server. The approval page states "full access to your Neo account", which is the mitigation.
- **An attacker starts a monitoring device-flow request and phishes a member to approve it.** They get a device
  reporting for that member, which is useless to them. The owner sees the device and the `device_enrolled` alert.
- **The laptop is closed for a long weekend.** One `medium` `device_offline` alert: in the feed, and emailed only at
  the `medium` threshold. The heartbeat clears it; the next outage alerts again.
- **A scammer tells grandma to uninstall the extension.** Uninstalling through the extension's own UI calls
  `DELETE /api/devices/self` and raises a `high` `device_removed` alert. Uninstalling from the browser menu is
  caught as offline after 48 hours; step 5 adds `runtime.setUninstallURL` for a faster signal.
- **The member leaves the household.** Their devices are revoked; the clients get 401 on the next heartbeat and
  show "This device is no longer connected to a household".
- **A device token is used after revocation.** It does not resolve: 401, as for a revoked desktop token.
- **The owner enrolls a device for themselves.** Allowed; it never raises offline or removed alerts.

## Acceptance Criteria

- [ ] Existing `neo_dt_` tokens keep working unchanged after migration 0009 (backfilled `full`); the Omarchy bar
      still works on production.
- [ ] An enrollment code, generated by the owner for a member, redeems once into a device and a scoped token. A
      second redemption, an expired code and a cancelled code return 404.
- [ ] A monitoring token gets 403 `insufficient_scope` on every existing API route (tested against the route list)
      and cannot render any page; it can heartbeat and unenroll itself.
- [ ] Self-enrollment through the device flow with `device` creates a device and a monitoring token; without it,
      a full token as today; the approval page names what is granted.
- [ ] The member is emailed on code enrollment; self-enrollment raises a `low` alert; removal by the member or
      the device raises a `high` alert; the owner's own actions raise none.
- [ ] A device without a heartbeat for 48 hours raises one `device_offline` alert; a heartbeat re-arms it.
- [ ] Leaving or being removed revokes the member's devices; their tokens stop resolving.
- [ ] Owners see and manage all devices; members see and remove only their own; desktop tokens cannot manage
      devices or codes.
- [ ] Migration 0009 applies on PGlite and Neon; RLS test covers `devices` and `device_enrollment_codes`.

## Open Questions

- **Offline threshold and severity.** The plan says 24 hours. This spec uses **48 hours at `medium`**: an evening
  when the laptop is shut would otherwise email the owner nightly. Revisit once real heartbeat data exists.
- **One device, several members** (a shared family PC). This spec binds a device to one member. Revisit with the
  Windows agent, which could report for "the household" instead.
- **Heartbeat carrying health** (detector list version, permissions granted, monitoring paused). Deferred to the
  signals spec, which defines the lists and their ETags.

## Testing Guidelines

Create test files in the `./test` folders for the new feature, with meaningful tests for the following cases,
without going too heavy:

- `packages/db/test/devices.test.ts` (PGlite as `app_user`): code create / lookup / redeem once, concurrent
  redeem, expiry, device cap, scope check constraints, backfilled `full` on existing tokens, token lookup refusing
  revoked devices, `list_stale_devices`, purge, RLS isolation.
- `apps/web/test/device-enrollment.test.ts` (memory stores): owner code routes and member 403s, preview and enroll,
  rate limits, heartbeat, self-unenroll, management routes by role, alerts raised or not by actor, member email,
  leaving revokes devices, the offline job.
- `apps/web/test/scopes.test.ts`: a monitoring token against every `app/api/**/route.ts` handler (walk the
  directory so new routes are covered automatically), `getSession({ scope })`, pages treat it as signed out.
- `apps/web/test/desktop-auth.test.ts`: device-flow requests with and without `device`.
- `apps/web/test/household-settings.test.tsx`: the Devices section for owner and member, add-a-device code reveal.
