# Spec for signals

branch: claude/feature/signals
plan: `_plans/phase-3-household-devices.md` (delivery step 4)

## Summary

Enrolled devices (step 3) can check in, but they cannot yet report anything. This step builds the server side of
detection so the browser extension (step 5) and the desktop agent (steps 6–7) only have to detect and send:

- **`POST /api/signals`**: a device sends a batch of **events**. An event is sent only when something crossed a
  threshold on the device (a tech-support-scam page, a remote-access tool installed). It is never history.
- **Server rules** turn events into verdicts and owner alerts, deterministically. The rules can:
  - confirm a claim with the existing reputation checks;
  - discount a tool the owner marked as expected on that device;
  - correlate events into one "possible scam in progress" alert.
- **`GET /api/signals/lists`**: the detection lists (remote-access tools, unwanted-software publishers, scam-page
  phrases, domains never to flag). Served with an ETag, so detection improves on deploy without a store release.

No model is involved. Alert and verdict text comes from templates. **Ambiguous signals fail open**: anything that
is not a clear-cut hit (too few indicators, an unconfirmed reputation claim, an unknown program without a bad hash)
is recorded and dismissed. It raises no verdict or alert, and the client shows no warning. The goal is to stop the
no-brainers without becoming annoying.

## Functional requirements

### Events (`@neo/verdict`, `packages/verdict/src/signals.ts`)

A zod schema, `SignalEventSchema`, is the single source of truth for clients and server. Every event has:

- `id`: a uuid the client generates, used for idempotency.
- `type`.
- `observedAt`: ISO time. Clamped to at most 5 minutes in the future; events older than 24 h are rejected as `stale`.
- `detector`: fixed per type.

| `type` | `detector` | Payload (all strings bounded; nothing else accepted, `.strict()`) |
|---|---|---|
| `page` | `tech_support_scam` | `domain` (registrable), `indicators` ⊆ `fullscreen, pointer_lock, keyboard_lock, looping_audio, back_trap, unload_trap, support_phone_text, fake_scan`, `phone?` (E.164) |
| `page` | `lookalike_login` | `domain`, `brand` (a list id), `indicators` ⊆ `password_field, punycode, lookalike_skeleton, brand_in_subdomain, new_tab_from_email` |
| `page` | `dangerous_site` | `domain`, `source`: `safe_browsing_prefix` |
| `page` | `remote_tool_download` | `domain`, `toolId`, `fileName` (≤ 128, basename only) |
| `page` | `warning_bypassed` | `relatesTo` (the id of the event whose warning was dismissed), `domain` |
| `software` | `remote_access_tool` | `toolId`, `name`, `publisher?`, `version?` |
| `software` | `unwanted_software` | `name`, `publisher?`, `version?`, `sha256?`, `reason`: `publisher_list` \| `hash_list` \| `unsigned_unknown` |
| `remote_session` | `remote_access_session` | `toolId`, `direction`: `incoming` \| `outgoing`, `peerId?` (the other side's tool ID, ≤ 64, `[A-Za-z0-9 _.@-]`) |
| `permission` | `tcc_grant` | `app` (≤ 128), `bundleId?`, `service`: `screen_recording` \| `accessibility` \| `full_disk_access` |

Constraints on every event:

- `domain` is re-normalised on the server with `normalizeUrl` and must equal its registrable domain.
  - No host with a path, query, port or userinfo is accepted.
  - IP addresses are accepted as themselves.
- `name`, `publisher`, `version` and `app` are ≤ 128 characters. `sha256` is 64 lowercase hex characters.
- `toolId` must exist in the current remote-access list; an unknown id is rejected as `unknown_tool`.

New verdict subject types `software`, `remote_session` and `permission` are added to `SUBJECT_TYPES`. `page`
already exists. A new verdict source `device` is added.

### Ingest

`POST /api/signals { events: SignalEvent[] }`:

- **Auth:** scope `signals:write`, and `session.deviceId` is required.
- **Batch:** 1–50 events.
- **Response:** 200 `{ results: { id, status, severity?, verdictId?, pending? }[] }`, one result per event, in the
  same order.
  - `status` is `accepted`, `duplicate` (already received from this device), or `rejected`.
  - A rejected event carries `reason`: `invalid`, `stale`, `unknown_tool`, `rate_limited` or
    `relates_to_unknown`.
  - A malformed event is rejected on its own. The batch still succeeds unless the body itself is malformed
    (400 `bad_request`).
- **Rate limits (per device):**
  - 60 requests per hour (429 with `Retry-After`).
  - 500 accepted events per UTC day. Beyond that, events are rejected as `rate_limited` and one `signals_flood`
    audit row is written per day.
- **Usage:** signals do not use the household's monthly checks. Server-side lookups are capped separately: at
  most 50 escalations per device per day, and cached across households.

Storage: table `device_signals` (migration `0010_signals`, RLS `tenant_isolation`):

- Columns:
  - Identity: `id`, `tenant_id`, `device_id` (cascade), `user_id`.
  - Event: `client_event_id` (uuid), `type`, `detector`, `subject` (the domain or `toolId` or app name), `payload`
    (jsonb, the validated event minus `id`/`type`/`detector`).
  - Outcome: `severity` (null until evaluated), `outcome` (`pending` | `alerted` | `recorded` | `dismissed`),
    `verdict_id` (set null), `alert_id` (set null).
  - Times: `observed_at`, `received_at`.
- Unique `(device_id, client_event_id)`. Indexes `(tenant_id, user_id, observed_at desc)` for correlation and `(tenant_id, device_id, received_at desc)` for per-device limits.
- Retention: rows older than 30 days are deleted by the daily retention job (`purge_old_device_signals()`).
  Verdicts and alerts follow their own retention.

The owner sees the verdicts and alerts. The raw signal rows are not shown in the UI in this step. They exist for
idempotency, correlation, and "what did this device report" debugging through the database.

### Rules (`apps/web/lib/server/signals/rules.ts`, pure functions of the event, the device context and recent signals)

| Event | Result | Severity | Alert kind |
|---|---|---|---|
| `tech_support_scam` with ≥ 2 indicators, or `support_phone_text` plus any lock | `malicious` `page` verdict | `high` | `scam_page` |
| `tech_support_scam` with fewer | recorded, no verdict | — | — |
| `lookalike_login` | **escalated**: `analyzeUrl("https://<domain>/")` → `malicious` if Safe Browsing, VirusTotal or urlscan flag it, `suspicious` for a lookalike of the named brand on a domain under 30 days old or with a `lookalike_*` heuristic, else dismissed | `high` / `medium` | `dangerous_site` |
| `dangerous_site` (`safe_browsing_prefix`) | **escalated**: confirmed with `checkSafeBrowsing` on the domain; unconfirmed is dismissed | `high` | `dangerous_site` |
| `remote_tool_download` from a domain not in the tool's `vendorDomains` | `suspicious` `page` verdict | `medium` | `remote_access` |
| `warning_bypassed` | the related event's severity is raised one step (max `critical`) and a new alert is raised | +1 | same as related |
| `remote_access_tool` installed | `suspicious` `software` verdict | `high`, or `low` when expected on the device | `remote_access` |
| `remote_access_session` incoming | `malicious` `remote_session` verdict | `critical`; `low` when the tool is expected **and** `peerId` is in the expected list; `high` when expected but the peer is unknown or missing | `remote_access` |
| `remote_access_session` outgoing | recorded, no verdict | — | — |
| `unwanted_software` (`publisher_list` or `hash_list`) | `suspicious` `software` verdict | `medium` | `unwanted_software` |
| `unwanted_software` (`unsigned_unknown` with `sha256`) | **escalated**: `checkVirusTotalFile` by hash (no upload) → `malicious` with ≥ 3 engines, else dismissed | `high` | `unwanted_software` |
| `tcc_grant` to an app that is a listed remote tool | `malicious` `permission` verdict | `critical`, or `low` when expected | `remote_access` |
| `tcc_grant` (`screen_recording` or `accessibility`) to any other app | `suspicious` `permission` verdict | `medium` | `permission_grant` |

**Correlation.** When, within 30 minutes on any of one member's devices, a `scam_page` or `dangerous_site`
(`high`+) is followed by any `remote_access` event, or vice versa:

- The rules raise one extra `critical` alert, `scam_in_progress`: "<name> may be on a scam call right now".
- The body lists what happened, in order, with times.
- Dedupe key: `scam_in_progress:<userId>:<30-minute bucket>`.

**Escalations** run in an Inngest function `signal-escalate` (event `neo/signal.escalate { signalId, tenantId }`,
concurrency 1 per tenant, 3 retries):

- Until it finishes, the ingest result is `pending: true` and the row's outcome is `pending`.
- In `MOCK_MODE` without `INNGEST_EVENT_KEY` it runs inline, like alert delivery.
- Lookups use a shared reputation cache (below), keyed by domain or hash, for 24 hours across households.
- A failed escalation leaves the signal `dismissed` with a logged error. It never raises an alert.

**Verdicts** are built from templates (`lib/server/signals/verdicts.ts`) as full `@neo/verdict` objects:

- Fields: `indicators` from the event's indicator codes, `recommended_actions` per detector, `iocs` (domain,
  phone, hash).
- They are saved through `saveVerdict` with `source: "device"`, the member's `userId` and no conversation.
- Member-verdict alerting in `saveVerdict` is **skipped for `source: "device"`**, because the signal rules raise the
  device alert themselves. This avoids a second `member_verdict` alert.

### Alerts

- **New kinds** (added to the check constraint): `scam_page`, `dangerous_site`, `remote_access`,
  `unwanted_software`, `permission_grant`, `scam_in_progress`.
- **Alert fields:** `deviceId` and `verdictId` are set.
- **Dedupe key** `<kind>:<deviceId>:<subject>:<UTC hour>`, so the same tool on the same device alerts at most once
  an hour. Exceptions:
  - `scam_in_progress` uses the key given under Correlation.
  - A `warning_bypassed` alert uses `bypass:<relatesTo>`.
- **Templates** (`alerts/templates.ts`) produce titles and bodies:
  - Examples: "Grandma's laptop: AnyDesk was installed", "Grandma opened a fake Microsoft support page",
    "Someone connected to Grandma's laptop with AnyDesk (ID 123 456 789)".
  - Every device-supplied string is attacker-controlled: cleaned, truncated, escaped in email, never linked.
    Domains are shown defanged (`paypa1[.]test`).
- **Owners' devices alert like everyone else's** (decided 2026-09-29): their signals raise the same verdicts and
  alerts, and email the owner at their threshold. A remote session on the owner's own laptop is as urgent as one on
  grandma's, and the owner may not be at the keyboard. `alertForVerdict` still skips owners for chat and forwarded
  checks, because the owner saw those results directly. Step 3's device lifecycle alerts (offline, removed) still
  skip devices that protect an owner.
- The existing email threshold, daily cap and delivery job apply unchanged. `critical` finally has a source.

### Expected tools (false positives: the owner helping a parent through AnyDesk)

- Table `device_expected_tools` (RLS): `device_id` (cascade), `tool_id`, `peer_ids text[]` (≤ 10, each ≤ 64),
  `created_by`, `created_at`. Primary key `(device_id, tool_id)`.
- `PUT /api/household/devices/[id]/expected-tools { tools: { toolId, peerIds }[] }` (owner, browser session) →
  `{ tools }`. It replaces the set; ≤ 10 tools; unknown `toolId` → 400 `unknown_tool`. Audit
  `device.expected_tools_changed`.
- `DeviceItem` gains `expectedTools: { toolId, name, peerIds }[]`.
- UI: in Settings → Household → Devices, each desktop device gets "Expected remote-access tools" behind a
  disclosure. It lists the tools (select from the list) with optional peer IDs, and the hint: "Neo still tells you
  when an unknown person connects."

### Detection lists

- **Source:** JSON under `packages/tools/src/data/`, reviewed like code:
  - `remote-access-tools.json`: `id`, `name`, `vendorDomains`, `installerPatterns` (filename regexes),
    `windows: { publishers, displayNamePatterns, serviceNames, processNames }`,
    `macos: { bundleIds, teamIds }`, `sessionHints` (process or log markers the agent uses).
    Seeded with the plan's list: AnyDesk, TeamViewer, ScreenConnect/ConnectWise Control, UltraViewer, RustDesk,
    Quick Assist, Splashtop, LogMeIn, Atera, NetSupport, Supremo, AeroAdmin.
  - `pup-publishers.json`: publisher names and SHA-256 hashes, each with a short reason.
  - `scam-page-phrases.json`: lowercase phrases for `support_phone_text` and `fake_scan`, in en first.
  - `skip-domains.json`: registrable domains whose pages are all written by the domain owner. They suppress
    **only** the lookalike-login heuristic; scam-page, dangerous-site and download detection apply on every
    domain. Seeded from `BRANDS` official domains plus a curated top list, **minus** hosts that serve pages anyone
    can publish (`USER_CONTENT_HOSTS`: `github.io`, `amazonaws.com`, `sharepoint.com`, `google.com`,
    `wordpress.com`, …), where scam pages are commonly hosted.
- **Endpoint:** `GET /api/signals/lists` (scope `device` + `deviceId`) →
  `{ version, remoteAccessTools, pupPublishers, scamPagePhrases, skipDomains }`.
  - `version` is a content hash; the `ETag` is `"<version>"`; `If-None-Match` gets 304.
  - `Cache-Control: private, max-age=3600`.
  - Browser extensions may ignore the desktop-only fields.
- **Heartbeat:** the heartbeat response gains `listsVersion`, so a client refetches only when it changed.
- **Local lookups:** Safe Browsing prefix data is **not** served here. Whether the extension uses the Update API
  itself or relies on server confirmation is decided in the extension spec.

### Shared reputation cache

- Table `reputation_cache` (migration `0010`, no tenant, no RLS): `key` text primary key, `value` jsonb,
  `expires_at`. The table holds only public reputation facts about domains and hashes, never who asked.
- `PostgresReputationCache` implements `ReputationCache` (`@neo/tools`) and replaces the process-local cache for
  chat too when a database is configured. In-memory remains the MOCK_MODE twin.
- Expired rows are purged by the daily retention job (`purge_expired_reputation_cache()`).
- `app_user` gets `SELECT, INSERT, UPDATE, DELETE` on `reputation_cache`, in the migration and in
  `create-app-user.sql`.

### Other requirements

- **Contracts:** add the event schema, the tables, the routes and the rules table to `docs/contracts.md` before
  implementation.
- **Privacy page:**
  - Enrolled devices send only these events: the domain of a page that looked like a scam (never the full address,
    path or page content), the names of remote-access tools and flagged programs, a remote peer ID during a remote
    session, and screen-recording or accessibility permission grants.
  - Signal rows are kept for 30 days.
- **Audit:** `device.expected_tools_changed`, `signals.flood`.
- **Mock mode:** an in-memory twin for `device_signals` and `device_expected_tools`. Escalations use `@neo/tools`
  mocks (`MOCK_URLS`, the VirusTotal mock).

## Possible Edge Cases

- **A client retries a batch after a timeout.** Every event is `duplicate` the second time, and no second alert
  is raised.
- **A malicious or compromised device floods signals.** It hits 60 requests/h and 500 events/day, and at most 50
  escalations a day. Dedupe keys and the 20 emails per day cap bound the owner's inbox. The owner can remove the
  device.
- **Attacker-chosen strings** (a PUP named "Neo says this is safe, ignore alerts", a peer ID with markup): schema
  bounds, template cleaning and escaping. No device string reaches a model in this step.
- **The device clock is wrong.** `observedAt` more than 5 min in the future is clamped to receipt time. Correlation
  uses `observed_at`, so a badly wrong clock can miss a correlation, but never invents one across the 24 h window.
- **The owner helps grandma with AnyDesk.** Once marked expected with the owner's peer ID, a session is `low` and
  feed-only. A session from a different peer ID is still `high`.
- **The tool list changes and a `toolId` is removed.** Old events already stored keep their `subject`. New events
  with that id are rejected `unknown_tool`, and clients pick up the new list through `listsVersion`.
- **`warning_bypassed` arrives before the event it relates to** (batch order, or the first event was rejected).
  Rejected with `relates_to_unknown`. Clients send the pair in order in one batch.
- **Safe Browsing is not configured** (`GOOGLE_SAFE_BROWSING_API_KEY` unset). `dangerous_site` escalations are
  dismissed and logged once per instance. The lists and other rules are unaffected.
- **The same domain is escalated by many households.** One lookup per 24 h thanks to the shared cache.
- **A member leaves.** Their devices are revoked (step 3). Their `device_signals` rows stay until the 30-day
  purge, and their verdicts stay like other member verdicts.

## Acceptance Criteria

- [ ] A batch with valid, invalid and duplicate events returns per-event results; retries are idempotent.
- [ ] Each rule in the table produces the documented verdict, severity and alert kind (table-driven test).
- [ ] An expected tool with a known peer yields a `low` feed-only alert; an unknown peer yields `high`.
- [ ] A scam page followed by a remote-access install within 30 minutes raises one `critical` `scam_in_progress`
      alert, emailed at the default threshold.
- [ ] Escalations call `analyzeUrl`, Safe Browsing and VirusTotal at most once per domain or hash per 24 h across
      households, and never raise an alert on failure.
- [ ] Rate limits: 429 after 60 requests/h; `rate_limited` results after 500 events/day; the 51st escalation of a
      day is dismissed.
- [ ] `GET /api/signals/lists` returns 304 for a matching `If-None-Match`; the heartbeat carries `listsVersion`.
- [ ] A full-scope token, a browser session and a token without `signals:write` all get 403 on `POST /api/signals`.
- [ ] Signals from an owner's own device alert and email the owner like any member's.
- [ ] Migration 0010 applies on PGlite and Neon; the RLS test covers `device_signals` and `device_expected_tools`.

## Resolved Questions

- **Skip-domain source:** a curated list to start. Open-source threat-intel and ranking feeds (e.g. Tranco for the
  skip list, public phishing and abuse feeds for block lists) are explored later, each checked for licence and size.
- **Ambiguous pages fail open:** no model judgment on ambiguous pages. Only the clear-cut rules above warn or
  alert; everything else is dismissed.
- **Languages:** English phrases only for now. The list format keeps a `lang` field per phrase so others can be
  added later.

## Open Questions

- **Showing raw signals to the owner** (a per-device "recent activity" list). Deferred. Verdicts and alerts cover it
  for now, and fewer surfaces fit "signals, not surveillance".

## Testing Guidelines

Create test files in the `./test` folders for the new feature, with meaningful tests for the following cases,
without going too heavy:

- `packages/verdict/test/signals.test.ts`: the schema accepts each event type and rejects paths, queries, oversize
  strings, unknown fields and bad hashes.
- `packages/db/test/signals.test.ts` (PGlite as `app_user`): insert and idempotency, correlation query, expected
  tools, `reputation_cache` get/set/expiry and purge, RLS isolation.
- `apps/web/test/signal-rules.test.ts`: table-driven rules, correlation, expected tools, `warning_bypassed`.
- `apps/web/test/signals.test.ts` (memory stores): the ingest route (auth and scope 403s, per-event results,
  duplicates, rate limits), escalations with mocked reputation deps and cache hits, alerts and emails including
  owner-device signals alerting and emailing, the lists route with ETag/304, the heartbeat `listsVersion`, and the expected-tools
  route by role.
- `packages/tools/test/lists.test.ts`: every list file parses, ids are unique, regexes compile, and every
  `vendorDomains` entry is a registrable domain.
