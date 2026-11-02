# Spec for v2-m2-child

branch: claude/feature/v2-m2-child
plan: `_plans/v2.md` (M2); architecture: `_specs/v2-architecture.md` (§2, §3, §6); builds on `_specs/v2-m1-elder.md`
status: draft, 2026-11-02

## Summary

M2 makes Child mode real for Patrick's own children. Their computers are Windows, macOS, and Chrome or Chromebooks. The children don't sign in to Neo. A parent sets a child's mode and age once. The household's devices pull a signed policy bundle and enforce it locally:
- the extension blocks web categories and forces SafeSearch;
- the desktop agent closes blocked apps, holds new apps until a parent approves them, and enforces daily screen time and downtime.

A child can ask for more time or ask to unblock something. The parent answers in chat or from an email link. Neo stays visible to the child: Child mode is shown on the device, and nothing is covert.

## Owner decisions (2026-11-02)
- **Enforcement:** the extension and the desktop agent warn **and block**. There's no DNS filtering in M2. Other browsers and apps are covered by tamper alerts, not by filtering.
- **Age bands:** three defaults, derived from `birth_year`: under 10, 10–13, and 14–17. Every setting can be changed.
- **Children have no Neo account.** M2 adds devices that belong to a member without an account (§2).
- **Platforms:** Windows and macOS through the desktop agent; Chrome and Chromebooks through the extension only. macOS still depends on the Apple Developer Program and a real Mac (unchanged from Phase 3).

## Functional requirements

### 1. Slices (one PR each, in order)
1. **(1a) Member-only devices (server refactor):** the migration in §2 and every read moved to `member_id`. **No behaviour change: every existing test passes unchanged.**
   **(1b) Child policy (server):** the Child policy schema, age-band defaults, the Child engine rules, Child enabled in the console, `consents`, and the `child_requests` table (used in slice 3). Standard and Elder behaviour is unchanged.
2. **Policy bundles:** compile, sign, `GET /api/devices/policy`, `policyVersion` on the heartbeat, and the signing key setup.
3. **Child requests (server and agent):** the request API for devices, parent notification, eve tools to approve or deny, and an email-link fallback.
4. **Extension release:** category blocking, SafeSearch, a block page with "Ask to unblock", and the new signals.
5. **Desktop agent release:** app blocklist, install approval, screen time and downtime, tamper detection, and requests from the tray. Signed MSI and pkg.

Server slices ship first. Older clients ignore the new fields, and new clients must not send detectors that an older server rejects (`docs/contracts.md`).

### 2. Member-only devices (slice 1)
- **Migration** (next free number at implementation; Outlook #50 renumbers after it):
  - `devices.member_id` is NOT NULL (backfilled in 0017) and `devices.user_id` becomes nullable.
  - The same applies to `device_enrollment_codes` (`member_id` NOT NULL, `user_id` nullable).
  - `device_signals` gains `member_id` (backfilled from the device), and `user_id` becomes nullable. A new index on `(tenant_id, member_id, observed_at desc)` replaces the user index for reads.
  - `alerts.member_id` becomes the subject everywhere. `subject_user_id` stays and is filled when the member has an account.
  - `desktop_tokens` (monitoring tokens): `user_id` becomes nullable and the table gains `member_id`. A check constraint enforces that a `full` token has a `user_id` and a monitoring token has a `device_id`. The `role` snapshot is nullable and is never set for a member-only device.
  - `device_expected_tools` is keyed by device and doesn't change.
  - `tenants.time_zone` is an IANA name, null until set. The console asks the owner to confirm it on the first Child-mode setup, prefilled from the browser. Screen time and downtime use it; null is treated as UTC.
  - `consents` (`tenant_id`, `member_id`, `kind` `monitoring_notice|guardian_consent|elder_self_consent`, `granted_by`, `granted_at`, `evidence` jsonb) with tenant RLS.
  - Alert kinds `self_harm_attempts`, `app_approval` and `child_request` are added by dropping and re-adding `alerts_kind_check`, as 0010 and 0017 do.
- **Reads:** every read of `devices.user_id`, `device_signals.user_id` and `alerts.subject_user_id` moves to `member_id`. That is about 50 call sites; the code trace lists the files. This includes:
  - the signals ingest (`recentUserSignals` becomes member-keyed),
  - correlation dedupe keys: **unchanged (`<kind>:<userId>:<bucket>`) for members with an account**, so no pair is alerted twice across the deploy; `<kind>:m:<memberId>:<bucket>` only for members without an account,
  - the outbox recipients,
  - the weekly digest,
  - incident tools and the dashboard ("member sees their own" becomes member-by-user).
- **Device-token sessions:** a device enrolled for a member without an account resolves to `{ tenantId, memberId, deviceId, userId: null, role: null }`. There is no membership, so there is no role. Device routes take the member from the device, never read `role`, and never use the token holder's user. Audit calls from device routes record `device:<deviceId>` as the actor. `full` tokens (people) are unchanged.
- **Enrollment:**
  - Owners create a member without an account from the console: display name, role `adult|child|elder`, and birth year for a child, plus a contact email for an adult or elder helper. This also closes the M1 gap of adding a helper without an account.
  - Owners create enrollment codes for any member: `POST /api/household/protected-members/[id]/enrollment-codes`.
  - Self-enrollment stays tied to the signed-in user's own member.

### 3. Child policy (slice 1)
- **`PolicyRulesSchema` gains:**
  - `web: { categories: Category[], safeSearch: boolean, youtubeRestricted: "off"|"moderate"|"strict", allow: domain[], block: domain[] }`
  - `apps: { block: AppRef[], requireApproval: boolean, approved: AppRef[] }`, where `AppRef` is a signer plus image name, or a macOS bundle id
  - `screenTime: { dailyMinutes: { mon..sun: number|null }, downtime: { start: "HH:MM", end: "HH:MM" }[], warnMinutes: number, allowDuringDowntime: AppRef[] }`
  - `notify.childRequestsTo`: `owners` or `helpers`, default `owners`
  
  `Category` is one of a fixed set: `adult`, `gambling`, `weapons`, `self_harm`, `drugs`, `proxy_vpn`, `social`, `games`, `streaming`, `dating`.
- **`MODE_DEFAULTS.child` by age band** (from `birth_year` and the household time zone; a missing birth year uses 10–13). Every value can be changed in the console:

  | | under 10 | 10–13 | 14–17 |
  | --- | --- | --- | --- |
  | Blocked categories | all ten | adult, gambling, weapons, self_harm, drugs, proxy_vpn, dating | adult, gambling, self_harm, drugs, proxy_vpn |
  | SafeSearch / YouTube | on / strict | on / moderate | on / moderate |
  | New apps need approval | yes | yes | no (notify only) |
  | Daily screen time | 1 h weekdays, 2 h weekend | 2 h / 3 h | none |
  | Downtime | 19:30–07:00 | 21:00–07:00 | 23:00–06:00 |
- **Child-mode signal rules (policy engine):**

  | Detector | Child decision | Notes |
  | --- | --- | --- |
  | `web_blocked` | record, digest | 3 or more `self_harm` blocks in 1 hour: incident `self_harm_attempts`, high, notifyNow |
  | `app_installed` | requireApproval: incident `app_approval`, medium, notifyNow (creates a child request); otherwise record and digest | |
  | `app_blocked` | record, digest | |
  | `screen_time_exhausted` | record, digest | |
  | `tamper_detected` | incident `protection_disabled`, high, notifyNow | client detector; reasons below |
  | remote-access detectors | as Elder | an unknown remote tool on a child's device is high |
  | `protection_disabled` (server: uninstall beacon, offline) | high, notifyNow, as in M1 | |

  `tamper_detected` reasons: `browser_without_extension`, `vpn_app`, `extension_disabled`, `clock_changed`, `agent_service_stopped` (reported after the service restarts).
- **Console:**
  - The mode picker enables Child. Choosing it asks for birth year and shows the age-band defaults.
  - Editors for categories, SafeSearch, the app lists, the weekly screen-time grid and downtime.
  - A per-device "pending on device" badge, shown until the device reports the current `policyVersion`.
  - Turning Child mode **off** emails every owner (as for Elder).
- **Consent and notice (light; family-first):**
  - Enabling Child mode records a `consents` row (`monitoring_notice`, granted by the owner) in a new table.
  - The device always shows that Child mode is on: the extension popup and block page, and the desktop tray.
  - Verifiable parental consent (COPPA) stays deferred until outside households join (`SECURITY.md`).

### 4. Policy bundles (slice 2)
- **Compile:** the effective policy for a device (household → mode defaults (age band) → member → device) is compiled into a bundle:

  ```
  { v: 1, deviceId, memberId, policyVersion, issuedAt, expiresAt, timeZone, mode,
    web: { categories, safeSearch, youtubeRestricted, allow, block },
    apps: { block, requireApproval, approved },
    screenTime: { dailyMinutes, downtime, warnMinutes, allowDuringDowntime, grants: [{ minutes, until }] } }
  ```
  - `policyVersion` is a SHA-256 hash of the canonical bundle body, excluding the timestamps.
  - `expiresAt` is 7 days out.
  - Bundles carry rules only; there are no category domain lists in them (§5).
- **Sign:** Ed25519 over the canonical JSON bytes of `{ bundle }`. The response is `{ bundle, sig, keyId }`.
  - Clients embed the policy **public** keys at build time (`NEO_POLICY_PUBKEYS`, comma-separated, so the key can rotate) and verify before applying.
  - The policy key is separate from the desktop update key.
  - **Correction to `_specs/v2-architecture.md` §6:** the server signs each bundle when it's requested, so the private key must be usable server-side. Preferred: **Vercel KMS** (managed signing keys, OIDC auth, the key never in env). Verify in slice 2 that it supports Ed25519 (`docs-lookup`). Fallback: an env secret `NEO_POLICY_SIGNING_KEY` (Production only, sensitive) with `keyId` rotation.
  - Self-hosters generate their own key pair and build clients with their public key. Without a key, the server serves unsigned bundles only to clients built without `NEO_POLICY_PUBKEYS` (dev only).
- **`GET /api/devices/policy`** (scope `device` plus `deviceId`, reusing the lists route's ETag pattern; its own rate limit of 120 an hour per device, so the 60 s pending-request poll fits):
  - Returns `ETag: "<policyVersion>"`, 304 on a match, and `Cache-Control: private, no-cache`.
  - Standard and Elder devices get a bundle too (with empty web, apps and screenTime), so clients have one code path.
- **Heartbeat:** the request adds `policyVersion` (what the device applied), stored as `devices.policy_version_applied`. The response adds `policyVersion` (current). A client fetches the policy when the two differ.
- **Fast changes:** a parent's approval (more time, unblock, allow an app) bumps the bundle. Devices also poll `GET /api/devices/policy` every 60 s while a request from that device is pending, so the change lands within about a minute.
- **Offline:** a device keeps enforcing its last valid bundle past `expiresAt`. Expiry only affects the "pending" badge and a digest note. An invalid signature is rejected; the last valid bundle stays, and the client reports `tamper_detected { reason: "bad_policy_signature" }`.

### 5. Category data (slice 4)
- The bundle names categories, and the extension holds the domain data.
- **Category lists** are built in CI from an open-source category list (see Open Questions for the source and its licence). A hashed set of about 1M domains runs to several MB, which is over the 4.5 MB function response limit. So the lists are **published as versioned static assets** (a GitHub release asset, as `desktop-latest` does, or a public Vercel Blob path), not served from a route. Their versions and URLs come from `GET /api/signals/lists`, and the extension downloads them with an ETag.
- **Matching (Chrome caps dynamic DNR rules at roughly 30k):**
  - **DNR dynamic rules** (blocking navigations before they load) for the policy's `block` list plus the top domains of each blocked category, within the rule budget.
  - **Full category coverage** through a compact, hashed domain set checked in the existing `detect.content.ts` at `document_start`. On a match it sends the tab to the block page.
  - **Unknown domains** are not looked up on the server. There's no browsing-history upload, and the privacy minimum holds.
- Telemetry is the domain and category only (`web_blocked { domain, category }`), never full URLs (Notion §6).

### 6. Extension (slice 4)
- **Permissions:** add `declarativeNetRequestWithHostAccess`, which works with the existing `<all_urls>` and should show no new install warning. Confirm with Chrome's permission warnings docs before release. Don't add `tabs`, `webNavigation` or `history`, because they'd force a re-consent prompt and disable the extension until the user accepts.
- **SafeSearch:**
  - DNR redirect rules for Google, Bing and DuckDuckGo (safe parameters).
  - `modifyHeaders` for YouTube (`YouTube-Restrict: Strict|Moderate`).
  - Rules are rebuilt whenever the bundle changes.
- **Block page:** a new extension page in `web_accessible_resources`. It says the site is blocked in Child mode, shows the category, and has an **"Ask to unblock"** button. The button sends a child request with the domain and an optional short reason. It shows the request's status and reloads when the request is approved.
- **Bundle:** fetched on heartbeat when `policyVersion` differs. The signature is verified with an embedded public key (WebCrypto Ed25519; check that both Chrome and Firefox 128+ support it, otherwise use a small audited library). Stored in `storage.local`.
- **`payment_page` detector (M1 handoff):** gift-card, crypto-ATM and wire-transfer checkout pages, matched from a list plus checkout keywords. It reports `payment_page { domain, category }` (no URL), which wakes Elder rule 4 (`payment_under_pressure`). It runs for every mode; the server decides.
- **Tamper:** the uninstall beacon already exists. A disable can't be seen from inside, so the desktop agent reports `browser_without_extension` (§7), and a heartbeat gap gives the server `protection_disabled` (M1).
- **Chromebooks:** the extension can only be enforced (not removable) if the child's account is supervised by Family Link or managed. Docs: how to force-install it for a supervised account. Without that, removal is detected through the uninstall beacon.
- Release through `extension-release.yml`, and the Chrome Web Store and AMO by hand, as today.

### 7. Desktop agent (slice 5)
- **New capability: acting.** The service (SYSTEM / root) may terminate a process in two cases: a blocked app, or an app still waiting for approval. It always shows a tray message first ("Sam's laptop: Roblox is blocked in Child mode"). It never acts on system processes, signed OS components, Neo itself, or the allow lists.
- **App blocklist:** matched on signer plus image name on Windows and bundle id on macOS (`AppRef`). A match is closed within one fast scan (5 s) and reported as `app_blocked`.
- **Install approval:** a newly installed app on a `requireApproval` device is reported as `app_installed`. The server opens a child request. Until it's approved, launches are closed with "Waiting for a parent to approve". Approved apps are added to `apps.approved` in the bundle.
- **Screen time:**
  - The service tracks active, unlocked console-session time for the device's interactive users.
    - Windows: WTS session enumeration plus lock and unlock notifications.
    - macOS: the `/dev/console` owner plus idle time.
  - Time counts against the child's daily budget in the household time zone. Any OS account on a Child-mode device counts; there's no per-OS-user mapping in M2.
  - At `warnMinutes` (default 10) before the budget runs out, or before downtime starts, the tray warns. At zero the service locks the session:
    - Windows: disconnect the console session (it returns to the lock screen). Verify on real hardware.
    - macOS: a lock through the logged-in user's session. Verify on a real Mac.
  
  It reports `screen_time_exhausted`. The tray's "Ask for more time" sends a `more_time` child request, and approved minutes arrive as bundle `grants`.
- **Tamper detection:** `browser_without_extension` (a known browser installed or run without Neo's extension enrolled for the member), `vpn_app` (from a list), `clock_changed`, and `agent_service_stopped` (detected after restart from a gap in the service's own journal). All are sent as `tamper_detected`.
- **IPC:** new ops `policy_status` and `request` (pipe and socket). The tray shows "Child mode is on", today's remaining time, and request status.
- **Policy pubkey:** a second compile-time key, `option_env!("NEO_POLICY_PUBKEYS")`, verified with Ed25519, separate from `NEO_DESKTOP_UPDATE_PUBKEY`.
- New signed MSI and pkg through the existing release workflows. Existing agents auto-update.

### 8. Child requests (slice 3)
- **Table `child_requests`:** `tenant_id`, `member_id`, `device_id`, `kind` (`more_time|unblock_site|install_app`), `detail` (domain, `AppRef` or minutes; minimized), `reason` (≤140 characters, child-supplied, attacker-controlled), `status` (`pending|approved|denied|expired`), `decided_by`, `decided_at`, `grant` (minutes or the allow entry), `alert_id`, and timestamps. Tenant RLS.
- **`POST /api/devices/requests`** (scope `device`): the member comes from the device. Rate limited to 5 pending per device and 20 a day. `GET /api/devices/requests/:id` returns the status for the device's own requests.
- **Parent notification:** a templated alert of kind `child_request`, medium. It goes through the outbox to the notify target (`owners` or helpers), with **Approve** and **Deny** links. The links take a signed, single-use, 24-hour token and need a signed-in owner, with a confirmation step. With `NEO_EVE_CHAT=true` there's also an "Ask Neo" link.
- **eve tools** `approve_request` and `deny_request`:
  - Input is `{ requestId, minutes? }` only, with minutes capped at 120. `minutes` is the one value taken from the model, so the `always()` prompt shows the exact number and target ("Give Sam **30** more minutes today on the family PC?"), and the owner approves that figure, not the model's paraphrase. With no `minutes`, the requested amount from the row is used.
  - `always()` approval, plus `requireHouseholdAdmin` at execution.
  - The grant is derived from the request row, never from the model.
  - The child's `reason` reaches the model only through `wrapToolResult`.
  - `list_requests` is read-only.
- **Approval effects:** `more_time` becomes a grant valid today. `unblock_site` adds the domain to the member's `web.allow` (permanent, or "once for 1 hour" as a grant). `install_app` adds the app to `apps.approved`. Each approval bumps the policy (§4 fast changes) and resolves the alert.
- Requests expire at the end of the child's day.

## Possible Edge Cases
- **A child changes the system clock:** reported as `clock_changed`. The screen-time ledger uses monotonic time plus server time from the heartbeat, not the wall clock.
- **Two devices for one child:** each enforces its own budget in M2. A shared budget across devices is M3.
- **A shared family PC with several OS accounts:** a device has one member, and that member's mode applies to every OS account on it. The console warns about this when a Child-mode device is shared.
- **The policy can't be fetched (offline, server down):** the last valid bundle keeps applying. A brand-new device has none, so it runs with detection only and shows "Waiting for settings".
- **Category list false positives:** the parent allows the domain in the console, and the child can ask to unblock.
- **A child request whose reason has injected text:** it's shown to the parent as quoted text, and reaches the model only inside the envelope. The grant never comes from the reason.
- **A parent approves from an email link without being signed in:** they sign in first, then confirm. The token alone does nothing.
- **Time zone changes and daylight saving:** budgets reset at local midnight in the household time zone.
- **A member switched from Child to Standard:** the next bundle is empty, and the device lifts all blocks within about a minute (fast poll) or at the next heartbeat.
- **Rollout:** devices on the old client keep working (no policy fetch). The console shows "Update Neo on this device to enforce Child mode".

## Acceptance Criteria
- An owner can add a child without an account, enroll a Windows PC and a Chrome browser with codes, and set Child mode with an age band. Both devices show Child mode within one heartbeat.
- On Chrome: a site in a blocked category shows the block page, Google search is SafeSearch, and YouTube is Restricted. "Ask to unblock" reaches the parent, and after approval the site loads within about a minute.
- On Windows: a blocked app closes within 5 s, a newly installed app waits for approval, and screen time warns 10 minutes ahead and then locks. "More time", once approved, unlocks with the granted minutes.
- A bundle with a bad signature is rejected and reported. Older clients keep working.
- Standard and Elder behaviour, and every existing test, are unchanged.

## Open Questions
- **Category list source and licence.** Candidates include the UT1 (Toulouse) blacklists (CC BY-SA), and OISD or Hagezi category lists. Pick one per category, and check the licence for redistribution inside the extension.
- **Vercel KMS Ed25519 support** (§4). If it isn't supported, accept the env-secret fallback?
- **Windows "lock":** disconnect versus logoff versus a tray-driven `LockWorkStation`. Decide on real hardware.
- **Chromebooks:** is Family Link (supervised account) in use, so the extension can be force-installed? If not, extension-only enforcement on a Chromebook is easy to remove.
- **Shared budget across a child's devices** (M2 or M3)?

## Testing Guidelines
Create test files in `./test` (per package), covering at least:
- **Migration:** user columns become nullable with no data loss, `member_id` is backfilled on signals, and a member-only device enrolls, heartbeats and sends signals. Elder and Standard paths are unchanged (the existing suites pass).
- **Policy:**
  - Age-band defaults.
  - Child rules in the engine (including the `self_harm` threshold and `app_installed` with and without approval).
  - Merge order.
  - Canonical compile: the same input gives the same `policyVersion`.
- **Bundles:**
  - Sign and verify with the embedded keys.
  - A tampered byte fails.
  - ETag 304.
  - A Standard device gets an empty bundle.
  - Key rotation by `keyId`.
- **Requests:**
  - A device can create requests only for its own member.
  - Rate limits.
  - The approve and deny tools: `always()`, admin re-check, grant from the row and not from input, the reason wrapped.
  - The email-link token is single-use and needs sign-in.
- **Extension:** DNR rule generation from a bundle (within the budget), SafeSearch rules, hashed-set matching, and that the block page sends a request.
- **Desktop (`agent-core`, pure):** app matching, the screen-time ledger (lock and unlock, midnight reset, clock changes, grants), and the downtime window across midnight.
