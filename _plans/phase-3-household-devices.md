# Phase 3 (part 2): household members, monitored devices, owner alerts

## Context

Neo protects the person who opens it. The people a household owner worries about most (an elderly parent, a
child) will not open it, least of all in the middle of a tech-support scam. This plan protects them passively:
a browser extension and a desktop agent run on the member's devices, detect a short list of unambiguous scam
signals, warn the member, and alert the owner.

Three things this needs are not built:

- **Household invites.** `memberships` has `owner` / `member` roles, but no one can join a household (a Phase 2
  roadmap item that was never done).
- **Owner alerts.** Nothing notifies anyone. A scam call runs for minutes, so a dashboard row read tomorrow is too late.
- **Device-scoped credentials.** A `neo_dt_` token (`_specs/desktop-auth.md`) resolves to a full session: it can
  read the household's conversations and verdicts. That is right for the owner's own Omarchy bar, and wrong for an
  agent on a relative's PC.

The roadmap (`phase-0-and-roadmap.md`, Phase 3) planned the extension as an on-demand checker and the Tauri app
as a web wrapper. This plan keeps both and adds monitoring to each.

## Decisions

- **Signals, not surveillance.** Clients send *events that crossed a threshold*, never history. The server stores
  alerts, not visited URLs or installed-software inventories. The owner sees alerts and device health; never
  browsing history.
- **Monitoring is visible and consented.** The member sees that a device is monitored (extension badge and
  options page, agent tray icon) and which household it reports to. The member is notified when a device is enrolled.
  This is both the ethical line and what Chrome Web Store and AMO review require for `<all_urls>`.
- **Warn the person at the keyboard first; alert the owner on high severity.** The member gets a warning page or a
  native notification immediately. The owner gets `high` and `critical` alerts, plus device-offline alerts.
- **Detection is deterministic and fails open.** Lists, hashes, publishers, heuristics and reputation lookups
  decide; alert text comes from templates. Ambiguous signals raise nothing (decided 2026-09-29: stop the
  no-brainers without becoming annoying), so no model judges pages. Every client-supplied string is
  attacker-controlled; if a model is ever added, that text enters it only through `wrapToolResult`.
- **Local first in the browser.** No per-page server call. The extension checks locally (Safe Browsing hash
  prefixes, top-domain skip list, punycode/lookalike checks) and sends only the **registrable domain** of pages
  that trip a heuristic; never paths or query strings, which carry session tokens. Server verdicts are cached by
  domain across tenants (the 24h cache already planned in the roadmap), so usage caps are not spent on browsing.
- **Reuse device authorization; add scopes.** The RFC 8628 flow from `desktop-auth` is unchanged. Tokens gain
  `scopes` and a `device_id`. Existing tokens get `full` (the owner's bar keeps working); monitoring clients get
  `signals:write url:check`. `getSession()` exposes scopes and every route declares what it needs, defaulting to
  `full`, so a monitoring token reaches nothing new by accident.
- **The owner can enroll a device on a member's behalf.** An enrollment code, generated in the owner's console
  and bound to a member, is redeemed by the client in place of a device code. Nobody signs in on grandma's PC.
  Self-enrollment by the member through the normal flow also works.
- **Devices are first-class.** A `devices` table (member, kind, name, version, last heartbeat, revoked). A device
  that stops sending heartbeats for 24h raises a `device_offline` alert: uninstalling the extension is one click,
  and the owner should know.
- **Windows first on the desktop.** The people most exposed to remote-access scams are on Windows and macOS, not
  Omarchy. The agent is a background service inside the planned Tauri app (tray icon, native notifications), not
  a separate product. The Omarchy plugin gains monitoring later, if at all.
- **Alert delivery: email now, push with mobile.** Resend is already wired for magic links. Push waits for the
  Expo app; the channel interface is shaped for it.

## What is detected

Browser extension (content script + background):

- Tech-support-scam pages: forced fullscreen, pointer lock or keyboard lock, looping audio, blocked back
  navigation, `beforeunload` traps, text like "call Microsoft/Apple support" with a phone number.
- Lookalike login: a password field on a punycode or brand-lookalike domain not on the skip list.
- Safe Browsing hit (local hash-prefix match, confirmed server-side).
- Download of a remote-access tool installer (filename and URL pattern) from a page that is not the vendor's.

Desktop agent:

- Remote-access tools installed: AnyDesk, TeamViewer, ScreenConnect / ConnectWise Control, UltraViewer, RustDesk,
  Quick Assist, Splashtop, LogMeIn, Atera, NetSupport, Supremo, AeroAdmin, and others on a versioned list shipped
  from the server. A *first session* of one is `critical`.
- macOS: a new Screen Recording or Accessibility (TCC) grant to an app not seen before.
- Potentially unwanted programs: code-signing publisher and SHA-256 against a server-maintained list;
  unknown unsigned binaries in install locations go to VirusTotal (existing key, existing cache).
- Windows sources: uninstall registry keys, `MsiInstaller` events, new services. macOS: `/Applications`,
  LaunchAgents and LaunchDaemons.

Lists (remote-access tools, PUP publishers, scam-page phrases, skip list) live on the server and are fetched by
clients with an ETag, so detection updates without a store release.

## Delivery

Each step is its own spec (`_specs/template.md`) and PR. `docs/contracts.md` changes before the interface does.

1. **Household invites and roles.** Owner invites by email (Resend, 7-day single-use link) or generates an invite
   code; accepting creates a `member` membership. Owner can remove members; a user belongs to one household
   (moving means leaving). Settings → Household lists members and devices. Spec `household-invites.md`.
2. **Alerts and delivery.** `alerts` table (tenant, member, device, kind, severity, verdict id, acknowledged by/at),
   owner dashboard feed, member sees their own. Email to the owner for `high`/`critical`, deduplicated per
   (device, kind, subject) per hour and capped per day. Per-owner quiet settings. Inngest job for delivery.
   Spec `owner-alerts.md`.
3. **Devices and scoped tokens.** `devices` table; `scopes` and `device_id` on `desktop_tokens` (migration backfills
   `full`); route-level scope checks; owner-generated enrollment codes bound to a member; heartbeat endpoint and the
   offline-device job. Settings → Household → Devices can revoke. Spec `device-enrollment.md`.
4. **Signals API.** `POST /api/signals` (scope `signals:write`): batched, schema-validated events in
   `@neo/verdict`, rate-limited per device, idempotency key per event. Server-side rules turn events into verdicts
   (new subject types `software`, `remote_session`, `page`) and alerts. `GET /api/signals/lists` serves detection
   lists with ETags. MOCK_MODE twin. Spec `signals.md`.
5. **Browser extension (WXT, MV3), Chrome and Firefox.** Device sign-in and enrollment, the on-demand checks from
   the roadmap, the detectors above, a warning interstitial, heartbeat. Escalated domains go to the existing URL
   pipeline. Store listings, privacy policy update, permission justifications. Spec `browser-extension.md`.
6. **Windows agent in the Tauri app.** Background service, tray icon, native notifications, enrollment, detectors,
   heartbeat, auto-update. Code signing in CI (Authenticode). Submit builds to Microsoft and major AV vendors for
   false-positive review before release. Spec `desktop-agent.md`.
7. **macOS agent.** Same app; notarization, TCC monitoring, Full Disk Access prompt only if needed.

Exit: an owner can invite a parent, enroll the parent's browser and PC from the console, and receive an email
within a minute of a remote-access tool being installed or a tech-support-scam page opening.

## Risks

- **Store review of `<all_urls>`.** Mitigation: minimal permissions, local-first design, a written data-use
  statement that matches the code, no page content leaves the device without an escalation.
- **Our own agent flagged as malware.** It watches installs and reports to a server, which is what spyware does.
  Signing, vendor submissions and a plain-English tray presence are part of step 6, not afterthoughts.
- **False positives on legitimate remote-access use** (the owner helping a parent through AnyDesk). The owner can
  mark a tool as expected per device; alerts then drop to `low` unless a session starts from an unknown ID.
- **Alert fatigue.** Only the listed high-confidence signals alert the owner; everything else is a member-side
  warning or a dashboard row.
- **Abuse between adults** (monitoring a partner). Visible monitoring, member notification on enrollment, and the
  member's ability to see and revoke devices enrolled for them.

## Out of scope

Blocking or killing processes and ending remote sessions (destructive; revisit once alerts prove accurate),
browsing history or reports for owners, parental content filtering, Safari (Phase 4 with iOS), push notifications
(with mobile), a Linux agent, mobile device monitoring.

## Resolved questions

- A member can remove a device enrolled for them; the owner is notified (a `device_removed` alert).
- Email is the owner alert channel until push ships with mobile; no SMS.
- Usage caps stay per household: members share the tenant's caps by default.
