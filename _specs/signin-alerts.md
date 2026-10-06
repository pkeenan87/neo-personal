# Spec: sign-in alerts and “review my sign-ins”

Branch: `hermes/feature/signin-alerts`
Roadmap: `_plans/deferred-roadmap-items.md`, step 4. Implemented in migration `0015_signin_alerts`; see `docs/contracts.md` for the shipped interfaces.

## Summary and scope

Extend the existing email-analysis and verdict pipeline with deterministic sign-in-alert evidence, event history, a known-device confirmation flow, and a member chat tool. This is not provider sign-in-log access: Neo only analyzes alert emails supplied by a user or the step-5 Outlook connector. A template match means “matches a known alert format,” not proof of sender identity or a confirmed sign-in. Scope is English-language alerts for Google, Microsoft consumer accounts, Apple, Meta, Amazon, and PayPal; banks and other providers are out of scope. Geolocation is mock-only for now.

The parser is in `packages/tools/src/signin/`. Reuse the existing parsed email and `analyzeEmail` result; do not introduce `analyzeSigninAlertEmail`, a second parsing pass, or a second guidance string. Unknown/ambiguous templates leave the ordinary email path unchanged.

## Functional requirements

### Analysis and deterministic verdict precedence

- Add an optional `signin_alert` field to `EmailAnalysis` in `packages/tools/src/email/types.ts`. Populate it from the already-parsed message, including content extracted from HTML by `html.ts`; preserve normal authentication, URL, and phone analysis on the same message.
- The parser uses a reviewed, versioned registry of deterministic templates for all six in-scope providers. Each template has `verified: false` by default; keep it false until the owner forwards a real provider alert and confirms that the parser matches it. A match requires stable provider-specific subject/body markers and a consistent event marker. An unverified template may be recognized for analysis, but can never authorize `likely_safe`.
- Add a deterministic post-triage hook between `runTriage` and `saveVerdict` in `apps/web/lib/server/inbound/email-received-job.ts`; apply the same hook in `apps/web/lib/server/agent-run.ts` after `extractVerdict` and before `saveChatVerdict`. The chat hook takes `EmailAnalysis` from the `analyze_email` tool result in that turn's messages. If the override changes the verdict, persist the overridden verdict and add one line to the assistant message saying a deterministic rule decided the verdict. Rules override the model verdict. The hook sets `subject_type: "signin_alert"`; `triage.ts` stays unchanged.
- A fake-alert rule firing becomes `malicious`. All safe gates must pass—including a template marked `verified: true`, `dkim=pass`, DKIM signing domain on that provider's allowlist, and every link on provider domains—to become `likely_safe`. Absent authentication or forwarded mail becomes `insufficient_evidence`. Otherwise retain the triage verdict, capped at `suspicious` so an unverified template can never be `likely_safe`.
- The four explicit fake-alert rules are: (1) visible provider/sender mismatch, evaluated using DKIM and DMARC alignment; (2) any link outside that provider's known domains; (3) a callback phone number; or (4) a request to reply with codes. Reuse `auth.ts` fields `dkim_domains`, `dkim`, and `dmarc`, `EmailAnalysis.phone_numbers`, and the existing `credential_request` signal. Any rule matching deterministically overrides to `malicious`.
- A genuine-looking forwarded wrapper-only message whose original authentication results are absent (for example `selectTarget` → `forwarded_wrapper_only`) is `insufficient_evidence`, never `likely_safe`. Do not infer authentication from wrapper headers or display names.
- Safe-gate hardening (security review): `likely_safe` also needs (a) authentication from the receiver's own `Authentication-Results` (`source === "authentication_results"`; ARC-only, Received-SPF or DKIM-Signature-only counts as absent), (b) `auth.dkim_pass_domains` (passing signatures only; additive field, `dkim_domains` still lists every signature) to contain an allowlisted provider domain, and a passing d= equal to the From registrable domain (or `aligned` with `dmarc=pass`), (c) a From address that exactly matches a `SIGNIN_ALERT_SENDERS` address, and (d) every link host in `SIGNIN_ALERT_LINK_HOSTS` (exact, no userinfo/port/mailto:; user-content hosts of the provider fail the gate but are not a fake signal). Rule 4 reads the full text (first 200k chars) and mailto: links, not the excerpt. The host lists must be verified against real alerts before any template is flipped to `verified`. The gates read `authentication.strict` only: the single selected Authentication-Results header, untrusted unless it is the topmost one and its authserv-id matches the topmost Received `by` registrable domain (a lower same-domain header is never merged in). Link checks run over every candidate host (`link_summary`), not the 50 listed urls; more candidates than listed fails `link_hosts_exact`. Owner privacy: household `topIndicators`/`topDomains` and the verdict detail's chat title exclude/replace a member's sign-in alert text for anyone but that member. Fail closed: a throwing hook caps `likely_safe` to `suspicious` (chat and inbound).
- Live card consistency: the model's verdict streams as text, so when a rule changes the verdict the server sends `verdict_override { verdict }` after `done`; the client rewrites the last verdict block of the message with it. The stored text and the verdict row come from the same fence scan.
- Model-written `signin_check` is always stripped (chat: inside `extractVerdict`; inbound: `finalizeSigninVerdict`); only the server may set it. When one chat turn analyzed several emails the override uses the analysis the verdict quotes; if that is ambiguous and any is a sign-in alert, `likely_safe` is capped to `suspicious` and no `signin_check` or event is produced.
- Include parser output as structured email-analysis evidence and pass it through the existing `wrapToolResult` boundary. Do not suppress the standard email analysis or its IOCs/authentication evidence.

### Parsed event and known-device history

- Use event names exactly: `new_signin`, `new_device`, `password_changed`, `mfa_or_recovery_changed`, `suspicious_activity`. Do not merge them into `security_change`.
- Persist per-user parsed events with provider, event, device label, coarse location, event time, source (`forwarded` | `outlook`) and `authenticated` boolean; include the source verdict/reference needed for the interaction. Use a tenant-scoped table with tenant RLS, registration in `tenantTables`, explicit `app_user` grant (or document default privileges), and indexes/foreign keys appropriate to the ownership and retention rules. Migration number is the **next free number at implementation time**.
- Ask “Was this you?” on the verdict only for a first-seen provider/device pair: it is first-seen when `(tenant_id, user_id, provider, device_label)` has no `known_signin_devices` row. Store optional verdict data `signin_check: { provider, event, device_label, first_seen: boolean }`. `POST /api/verdicts/[id]/signin-response` accepts `{ response: "yes" | "no" }`; only the verdict's own user may call it (others receive 404), it is idempotent and last-answer-wins, and it returns 409 if the verdict has no `signin_check`. Yes remembers the pair. No returns the `account_takeover` playbook id and opens the playbook; add it to `PLAYBOOK_IDS` in `apps/web/lib/playbooks.ts`, add `apps/web/lib/server/playbooks/account_takeover.md`, and regenerate `generated.ts`.
- Owners see only the resulting alert, never the event list or another member’s event details. For a member's `signin_alert` verdict the owner view (API, RSC props, chat context, alert text) has label, severity, confidence and static text only: model-written headline, explanations, evidence and recommended actions are replaced, IOC IPs are dropped, URLs are reduced to origins. `device_label` and `coarse_location` are bounded to 80 characters (the parser's bounds) in `SigninCheckSchema`. Members can review only their own events. Owner decision (2026-10-05): owners keep access to download a member's original forwarded message (`GET /api/artifacts/[id]`, unchanged), which may contain device, IP and location details; the redaction above applies to Neo's own derived views only. Follow existing verdict/alert retention and household deletion behavior; do not create a separate owner event feed.
- Define a `GeoLocator` interface and deterministic mock implementation only. IP-derived location is advisory and the UI must label it “advisory”; no hosted or local geolocation adapter is in scope.

### Chat, fixtures, and rendering safety

- Add a member-facing “review my sign-ins” chat tool that lists that member’s stored events with known-device status. Tool input treats blank strings as absent; tool output is attacker-controlled and wrapped through the existing tool-result boundary. This completes the roadmap’s Phase 2 exit.
- Synthetic fixtures belong under `packages/tools/test/fixtures/signin/`; use only synthetic `.neo.test`/`example.com` values. Include positive and negative examples for each template and every fake-alert rule.
- Strip control characters, bidirectional-override characters, and zero-width characters from output values. Escape every interpolated value in the UI and in `renderVerdictEmail`; never render message HTML or trust extracted strings. Mask account hints and omit secrets, codes, URLs, and full email addresses.
- Export `SIGNIN_ALERT_SENDERS`, mapping each provider to exact sender addresses and/or sender domains, for step 5 prefetch filtering. Step 5 references this export and this spec; it does not reimplement parser or event semantics.
- Never log message text, subject, address, device, location, IP, account hint, code, or source excerpts.

## Deterministic parser policy

Templates are versioned, reviewed, and English-only. Matching normalizes Unicode and whitespace for comparison but retains separately bounded, sanitized evidence excerpts. Require at least two independent stable markers, including a provider-specific marker and an event/action marker. Conflicting provider markers, unsupported language, ambiguous event structure, or multiple competing matches return `null`. No fuzzy matching, model parsing, remote lookup, or network call.

Extract only facts present in the message: provider, event, device/app label, coarse source location, IP, and time. Extract IP literals only from template-defined event sections, deduplicate them, and do not geolocate them. Normalize time to UTC only when the source gives an unambiguous timezone/offset. Mask any account identifier; omit it if safe masking is uncertain. Bound all input, output, evidence and collection sizes. Templates carry provenance and a checked date; synthetic fixtures are author-reviewed. Template semantic changes require a new version.

## Privacy and threat model

Mail content, headers, authentication results, links, provider claims, and parsed values are untrusted. Authentication evidence is evaluated only by existing email analysis. A matching template is not sender verification. Never follow message links. Recommend independently opening the official provider app/site, and never ask for passwords, verification codes, recovery keys, or passkeys. IP/location/device values may be attacker-supplied; location is advisory. Data is visible to the event’s member; household owners receive resulting alerts only. Retain event/verdict data under existing retention and delete it when the user leaves or is removed from the household.

## Acceptance criteria

- Each template has `verified: false` by default; an unverified template can never lead to `likely_safe`.
- All six provider scopes and English-only/banks-out-of-scope are explicit.
- Every input follows `analyzeEmail`; the structured signal feeds a deterministic hook between `runTriage` and `saveVerdict` for inbound and chat paths.
- Fake alerts become `malicious`; only verified template + DKIM pass + allowlisted DKIM domain + all links on provider domains can become `likely_safe`.
- Forwarded wrapper-only alerts without authentication are `insufficient_evidence` and never safe.
- The four fake-alert rules use the named existing auth, phone, and credential-request signals.
- Known-device records, Yes/No actions, `account_takeover`, owner visibility limits, exact event enum, mock `GeoLocator`, and “review my sign-ins” tool are specified.
- Output sanitization and HTML escaping cover every UI and verdict-email value.
- `SIGNIN_ALERT_SENDERS` is exported for step 5; fixtures are synthetic and under the specified directory.
- Contracts are appended at EOF, concise signatures/routes only, and contain no executor-specific model routing.
- No implementation, migration files, or secret values are added by this docs-only change.

## Owner decisions adopted

All owner decisions in `/home/pkeenan/Work/hermes-spec-review.md` are adopted: deterministic override; unauthenticated forwarded mail is `insufficient_evidence`; “No” opens `account_takeover`; Google, Microsoft consumer accounts, Apple, Meta, Amazon, and PayPal only; English only; banks out of scope; mock geolocation only. The parser remains part of normal email analysis and does not add another analysis path.

## Testing plan for implementation

Use synthetic fixtures only. Test each provider/template and exact deterministic fields; unknown/altered/unsupported/ambiguous templates; all four fake-alert rules; verified/unverified safe gating; missing-auth forwarded mail; inbound and chat hook ordering; event storage isolation and retention; known-device Yes/No; chat tool wrapping; sanitization/escaping; and no network/model/geolocation calls.
