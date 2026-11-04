# Beta household checklist

For onboarding a household onto the v2 features (protection modes, signed policies, the eve agent) and for the operator's gates before inviting anyone outside the maintainer's own family. Spec: `_specs/v2-m4-hardening.md` section 6. This is a checklist only; it adds no behaviour.

## Operator gates (before the first outside household)

- [ ] **COPPA.** Verifiable parental consent is not built (`SECURITY.md`, "Owner actions"). Do not protect anyone else's children until it is. For the maintainer's own household the owner's consent screen is the only control.
- [ ] **Policy key pinned in client builds.** Build the extension and desktop agent with `NEO_POLICY_PUBKEYS` set to the production KMS key (or rely on the committed default `3bfde89a-dfd5-41e2-875f-0c86ebe4c3ad`). Confirm `GET /api/devices/policy/keys` on production lists the same `kid`. Steps: `docs/deployment.md` ("Policy signing") and `docs/extension.md`.
- [ ] **Hardware verification.** Run the "Verify on real hardware" list in `_specs/v2-m2-child.md` (section 7, slice 5): Windows lock (`WTSDisconnectSession`) and lock tracking, Windows process termination and exclusions, macOS lock, macOS idle and console state, macOS termination, clock behaviour across sleep, and a real browser, VPN client and Store app on Windows. Also the macOS desktop-agent items in `_specs/desktop-agent-macos.md` and the signals items in `_specs/signals.md`. Record the result of each in the spec.
- [ ] **`end_session` on real hardware.** On Windows and macOS: the confirmation window appears and a Decline or timeout closes nothing, the remote-access program closes after Confirm, and a command older than 10 minutes does nothing (`_specs/v2-m3-cutover.md`, section 4).
- [ ] **Store releases.** Chrome Web Store and Firefox AMO extension builds (`docs/extension.md`, "Release steps"); check the Chrome permission warnings for `declarativeNetRequestWithHostAccess` before submitting (`_specs/v2-m2-child.md`). Signed Windows MSI and macOS pkg for the desktop agent (signing provider and an Apple Developer Program account are still undecided; `docs/desktop-agent.md`).
- [ ] **Category-list licences.** Confirm the UT1 licence version on the primary site and the Block List Project upstream rights (`_specs/v2-m2-child.md`, open items).
- [ ] **Cron routes.** Probe the deployment's eve schedule routes without Vercel's cron token and confirm they refuse the request (`SECURITY.md` lists this as unverified).
- [ ] **Migrations** for the release are applied to production by the owner, from the repo root.
- [ ] **Flags.** `NEO_EVE_CHAT=true` for households using the agent. `NEO_TWILIO_ENABLED` stays unset (SMS is mock-only). `NEO_EVE_SCHEDULES` stays unset until the shadow runs match Inngest's (`compareScheduleRuns`, `docs/deployment.md`).
- [ ] **Privacy page and `SECURITY.md`** are current for what you are about to enable (the CI guard `apps/web/test/privacy-tenant-tables.test.tsx` fails when a new tenant table has no privacy entry).

## Onboarding one household

1. **Create the household.** The owner signs in at neoshield.dev. Other adults join through an invitation (Settings -> Household); joining deletes the joiner's own empty household after they confirm.
2. **Add members.**
   - Adults with accounts: invite by email or link.
   - People without accounts (a child, a parent): the owner adds them from Settings -> Household (at most 20 per household). They never sign in; their devices act on the owner's settings.
3. **Choose a mode per member.** Standard, Elder or Child. Child needs a birth year and the household time zone.
4. **Consent screens.** Turning on Child mode records a `monitoring_notice` consent with the age band, granted by the owner. Enabling Child or Elder mode shows a plain-language notice the owner must confirm; Elder also needs the owner's in-person attestation. Read each member's "what is shared" page (Settings -> Household -> the member) with them. The elder confirming on their own device is not built, and the page's retention lines still say owner-set limits are planned, which is out of date.
5. **Enroll devices.** Create a device enrollment code on the member's page, then enroll in person (never ask someone to "download and install" over the phone: that is the scam script).
   - Browser (Chrome, Edge, Firefox): install the extension, paste the code on the options page, confirm the notice, pin the icon (`docs/extension.md`).
   - Windows: install the MSI, enroll from the tray window (`docs/desktop-agent.md`).
   - macOS: install the pkg, enroll, and grant Full Disk Access for the permission checks (`_specs/desktop-agent-macos.md`).
   - Chromebook: the extension can only be relied on for a child if the child cannot remove it, which needs a managed or supervised account that force-installs it (Google Workspace or managed Chrome policy, `ExtensionInstallForcelist`). Whether Family Link can force-install a Web Store extension is **unverified**; without it, removal is only detected through the uninstall beacon (`docs/extension.md`, "Chromebooks").
   - Phones are not covered yet.
6. **Modes and policies.** Review the age-band defaults for web categories, apps, screen time and downtime; edit sections only where the family wants something different ("Reset to age defaults" undoes it). Confirm the device shows "Pending on device" and then applied, and that a test site in a blocked category shows the block page.
7. **Helpers.** Name the helpers for Elder and Child members and who receives requests (`childRequestsTo`). Check the alert reaches each helper (use a test device; there is no test-alert button).
8. **Notification checks.**
   - Each owner sets their email alert threshold (Settings).
   - Trigger a Child request from a test device: the owner gets the alert and the email with Approve and Deny, the link needs a signed-in owner and a confirmation click, and it stops working after 24 hours or once decided.
   - Check email lands in the inbox, not spam.
9. **The agent.** With `NEO_EVE_CHAT=true`, open "Ask Neo" from an alert and confirm: the owner can approve a proposed action, a non-owner cannot, and a second household member cannot open the first one's chat.
10. **Household memory.** Optional. Add a fact in Settings and in chat; confirm the approval prompt shows the exact words and that contact details, links and numbers are refused.
11. **Spend cap.** Set a monthly cap (Household settings, default off). Confirm the 80% and 100% alerts reach every owner and that chat pauses at 100% while security alerts keep working.
12. **Retention.** Owners can change signals, alerts, child requests and household memory in Settings -> Household. Defaults: signals 30 days, alerts 180 days (90 after acknowledgement), child requests 90 days, household memory 365 days; raw evidence 30 days, removed devices 90 days. Consents, usage, the audit trail, the notification queue, invitations, device commands and eve session records are not purged on a timer. Tell the household what is kept (the `/privacy` page) before enrolling anyone.
13. **Tell everyone.** Each protected person is told Neo is on their device (the extension and desktop agent show a "Neo is monitoring" notice) and can see their devices in Settings -> Household. For Elder, use the in-person confirmation, not a remote one.
14. **Not available yet.** SMS (off, mock-only), voice, and do not promise them. The `end_session` command (ask a computer to end a remote session, with on-screen confirmation, 10-minute expiry) is built but not yet verified on real hardware.

## During the beta

- [ ] Check usage and incidents weekly: the owner's dashboard, spend against the cap, device offline alerts.
- [ ] Ask the household for a short written note every two weeks: false blocks, requests that were awkward, alerts that were noise or missed.
- [ ] Watch for tamper alerts after each client release (`bad_policy_signature` on every device usually means a key mismatch, not an attack).

## Reporting problems

- Security issues: privately through GitHub Security Advisories (`SECURITY.md`); never in a public issue.
- Anything else: a public issue on GitHub, redacting personal data, or email the contact address on the privacy page.
- Wrong verdicts and false blocks: include the domain or app name and the mode; false blocks can be fixed immediately by an allow entry.
