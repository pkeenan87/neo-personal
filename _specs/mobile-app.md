# Spec for mobile-app

branch: `hermes/feature/mobile-app`
plan: [`_plans/mobile-app.md`](../_plans/mobile-app.md)
status: owner-approved decisions recorded; docs-only checkpoint

## Summary

Build an Expo (React Native) iOS and Android client in `apps/mobile`. It authenticates by reusing Neo's existing browser device-authorization flow, uses the existing authenticated APIs for chat and security history, accepts user-selected messages/links/screenshots through native sharing, decodes QR codes locally before explicit URL analysis, and delivers opt-in push notifications for asynchronously produced verdicts and eligible household alerts.

The first release is an account client, not a monitored device. It does not enroll into `devices`, use monitoring-token scopes, inspect messages or notifications automatically, or run in the background to scan user activity. The mobile plan/spec do not authorize an app scaffold, OAuth changes, API implementation, migration, privacy-policy change or store submission.

## Decisions and approvals

| Topic | Decision | Follow-up |
|---|---|---|
| Mobile access token | Dedicated `mobile` token scope/kind is in scope now; `full` is an interim fallback only. Mobile tokens have their own Settings row label/section and independent cap. | No open decision. |
| API client | First implementation uses a small typed client in `apps/mobile/lib/api.ts`, patterned after `apps/extension/lib/api.ts`; do not create `@neo/api-client` until a separate package contract is approved. | Whether a future shared package should be a follow-up. |
| Auth.js providers | Add Apple Sign In alongside existing Google and Resend to the web sign-in/approval page. Keep the native app's approval in the system browser; do not put an OAuth secret in the app. | Apple team/domain setup and acceptance that browser-mediated approval is the app's sign-in UX. |
| Passkeys | Defer experimental Auth.js Passkeys; the provider is not recommended for production.[13] | Revisit when production-supported. |
| Incoming share | Paste/photo fallback before any iOS share extension; incoming extension is deferred. | Revisit after fallback is shipped and support is validated.[3][4] |
| Push provider and policy | Expo Push Service is approved with privacy disclosure; optional permission, generic payload, current email/feed authoritative. | Disclose Expo Push processing on privacy page; delivery remains best-effort. |
| Account deletion | Mobile Settings must expose a clear in-app deletion path before store submission. An owner with members transfers ownership first; an owner alone may delete the household. | Specify and test cascade and Apple token revocation in the implementation contract.[8] |
| Store accounts | Owner-controlled Expo, Apple Developer/App Store Connect and Google Play Console accounts; internal testing only until separate release approval. | Owner decides app IDs/accounts, name and store listing. |

These owner-approved decisions define the v1 scope where stated; the owner still decides app IDs/accounts and Apple credentials. A new `full` token is not least privilege and is only an interim fallback. Experimental Passkeys and iOS share intake are deferred.

## Functional requirements

### Workspace and build integration

- Add `apps/mobile` as the Expo project and `@neo/mobile` as its private workspace package. The existing `pnpm-workspace.yaml` glob already includes `apps/*`; use the root pnpm version and Node engine rather than adding a second package manager.
- Use Expo's `expo/metro-config`; do not manually customize Metro unless a reproducible workspace resolution failure proves it necessary. Keep React, React Native, Expo SDK packages and native modules deduplicated across the workspace.[16]
- Provide `dev`, `typecheck`, `lint`, `test` and `build` scripts so Turbo discovers the app. The local `build` task should run Expo export to `dist/`, matching the current default `dist/**` Turbo output. EAS cloud builds/submissions are separate release jobs, not a replacement for ordinary Turbo checks.
- Keep `eas.json` and any app-specific EAS configuration in `apps/mobile`; run EAS CLI commands from `apps/mobile`. Expo's monorepo instructions say each Expo app owns its EAS config root.[21]
- Add the app's dependencies to its own `package.json`, use Expo-compatible versions selected at implementation time, and let the root pnpm lockfile resolve a single compatible native dependency graph. Do not edit root scripts or workspace globs unless implementation verification requires it.
- Default server origin is the hosted Neo API over HTTPS; self-hosted server URLs must use a public host in v1. Treat a public build-time server URL as configuration, not a secret. Support `http` only for localhost development.

### Authentication and token lifecycle

- Reuse the existing device-authorization contract:
  1. `POST /api/desktop/device` with a descriptive `clientName` and **without** the `device` field.
  2. Show the short `userCode`; open `verificationUriComplete` in `ASWebAuthenticationSession` (iOS) or Android Custom Tabs, returning to the app via supported browser-session handoff. The approval page displays Neo's client name and the user code for confirmation.
  3. Poll `POST /api/desktop/device/token` at or above the server-provided `interval`, stop at expiry/deny, and accept the one-time approved response.
  4. Verify that the response is for the expected account and scope before unlocking app content. Request the dedicated `mobile` token scope/kind. `full` is an interim fallback only; never request monitoring scopes for chat.
- Never collect Google/Apple passwords or provider tokens in the native app. Auth.js sign-in and user-code approval stay on Neo's first-party web pages. Keep the web account visible on approval and show the account identity after redemption.
- Store `neo_dt_` token and token id in `expo-secure-store`, not AsyncStorage, SQLite, logs, analytics, crash reports or source-controlled configuration. SecureStore stores values encrypted with Android Keystore-backed storage on Android and Keychain on iOS; Keychain items can persist across reinstall with the same bundle id, so sign-out/account-switch cleanup must be explicit.[7]
- Attach the token in an HTTP Authorization header using the Bearer scheme for authenticated API requests; never place it in a URL, share payload, notification, deep link or crash report. Do not store or replay Auth.js browser cookies.
- Mobile tokens have their own identifiable Settings row/section and cap; `full` remains only an interim fallback. Sign-out attempts `DELETE /api/settings/desktop-tokens?id=<tokenId>` with the token (the existing route permits a token to revoke itself), then clears local credentials regardless. If revocation cannot be confirmed offline, tell the user to revoke the entry under Settings → Mobile; do not keep the plaintext token solely to retry later.
- Map existing server errors: 401 clears local auth and returns to sign-in; 403 `insufficient_scope` stops retries and reports a client/scope mismatch; 429 honors `Retry-After`; network/5xx errors are retryable with bounded backoff. Do not treat 403 as a sign-in loop.
- Add Apple Sign In to the Auth.js web provider configuration and sign-in UI only after the owner supplies Apple credentials and registers the required identifier/domain. Apple's web setup requires a Services ID associated with a primary App ID enabled for Sign in with Apple and registered website domains/return URLs.[14] Apple's Sign in with Apple environment guide also requires a private key for web-service authentication; keep the Services ID, team/key identifiers and private key in server-side secret storage, never in the mobile bundle.[15]
- Experimental Auth.js Passkeys are deferred; do not add the provider in v1.[13]

### API adapter and chat

- Use the existing API origin and current Bearer authentication. Do not implement a parallel login service, session cookie store, tenant selector, database client or model call in the app.
- Reuse documented endpoints where available:
  - `GET /api/conversations` for the signed-in user's conversation summaries; `DELETE /api/conversations?id=` for delete.
  - `POST /api/agent` for turns and attachments; parse its NDJSON `AgentEvent` stream incrementally, including text, tool, route, usage, completion, error and confirmation events.
  - `POST /api/agent/confirm` for explicit approval/decline when the agent emits `confirmation_required`. Never auto-approve.
  - `POST /api/artifacts` then `POST /api/agent` with artifact ids for uploads; existing server validation, encryption, tenant scoping and retention remain authoritative.
  - `GET /api/verdicts`, `GET /api/verdicts/[id]`, `GET /api/usage` and `GET /api/alerts` for history and dashboard data.
- A functional conversation-history screen needs full message history after selecting a summary. Today `GET /api/conversations` returns summaries only; the web loads details directly from a server-side helper and there is no mobile-readable detail API. Propose `GET /api/conversations/[id]` with the same Bearer auth and current-user/tenant scoping as the chat UI, returning `{ conversation: { id, title, updatedAt, messages: [{ id, role: "user" | "assistant", parts: [{ kind: "text", text } | { kind: "attachment", attachment: { id, kind, filename, mimeType, sizeBytes } } | { kind: "tool", trace: { id, name, status, resultSummary? } }] }] }, pendingConfirmation: { id, name, input, description } | null }`. Do not include raw artifact bytes, hidden server context or unbounded tool payloads. Return 404 for unknown, foreign-tenant or foreign-user conversations. Add this wire contract to `docs/contracts.md` before implementing the route; it is not changed in this plan-only checkpoint.
- Convert the server's stored conversation content into a mobile-safe representation: preserve user/assistant text, attachment references, tool progress/result summaries and pending confirmation; omit hidden server context and never return raw artifact bytes in chat history. For image references, use the existing tenant-authorized artifact endpoint only when the user opens the attachment.
- The React Native client must prove incremental NDJSON reading on physical Android and iOS builds before committing to a streaming UI. If the current React Native fetch implementation cannot consume the stream reliably, stop and obtain owner approval for a mobile-compatible transport or a new server response contract; do not silently buffer a long model turn or fork the agent behavior.
- Preserve usage caps and errors from the server. Display `Retry-After`, storage/model unavailability, and usage-cap reset information; do not retry a non-idempotent agent POST automatically after an ambiguous timeout.
- Render content defensively. Tool output, verdict text, attachment metadata and every shared message remain attacker-controlled. No Markdown link from submitted content may auto-open; links use the existing safe confirmation boundary.

### Share-sheet intake and artifact handling

- Android can use the incoming share target only after v1 paste/photo intake works; iOS v1 uses in-app paste/photo, not an iOS share extension. Any later extension remains experimental and requires physical-device validation.[3][4]
- A shared text, URL or screenshot is only a draft. Show a preview, source type, editable prompt and attachment list; nothing is uploaded or analyzed until the user taps **Check with Neo**. Cancel/back sends no request. Never open the shared destination automatically.
- Use the existing artifact limits and server validation: at most four files per upload request and 4 MB total; `.eml` ≤ 2 MB; PNG/JPEG/WebP/GIF images ≤ 3 MB each; text ≤ 512 KB; each chat turn accepts at most five artifact ids. The server, not native MIME metadata, decides actual file type. Convert/downscale oversized images and convert HEIC to an accepted type locally when possible; otherwise explain the unsupported format and offer a camera-roll/paste alternative.
- Upload selected images/text/files to `POST /api/artifacts`, then send the returned ids to `/api/agent`. The existing artifact store encrypts evidence at rest and expires raw artifacts after 30 days; the app must not create a second durable copy.
- Handle stale/expired artifact ids, denied photo access, revoked temporary content-URI permission, duplicate shares, oversized payloads, interrupted upload, offline retry and a user switching accounts between share and send. A failed turn must not lose the draft; allow resending without re-upload when the artifact is still valid.
- Keep the OS share extension thin: no Neo token in the extension process, no model call/network in the extension, no background upload. Bring the main app foreground to complete the explicit review/submit action.

### QR scan (decode-only)

- A dedicated camera screen requests camera permission only after the user chooses **Scan QR**. Configure `expo-camera` to scan QR codes only; its callback returns the encoded data for the app to inspect.[6]
- Decode locally. Do not open the encoded URL, perform a fetch, upload the QR image automatically, or run tracking/analytics on the code. Show the decoded value with a defanged display and an explicit **Analyze URL** action.
- Only `http` and `https` URI schemes are eligible for analysis, and the URL is submitted through `POST /api/agent` so the request counts against quota and creates a verdict. Do not use `/api/devices/check-url`: it requires `url:check` plus a device id and returns 403 for the mobile account token. Other QR payloads (plain text, contact cards, Wi-Fi configuration, `intent:`, `javascript:`, `data:`, `file:`) are displayed as untrusted text with no side effect.
- Handle camera permission denial with an in-app explanation and a manual URL/paste or screenshot option. No microphone permission, persistent camera access, or background scanning.

### Verdicts, household alerts and push

- Provide a read-only mobile verdict list/detail and alert feed using current API role behavior: owner may view household verdicts/alerts; member sees only their own. Mobile alert acknowledgements remain read-only in v1. The server is the authorization source; do not filter roles only on-device.
- Existing alert delivery is email-only. `GET /api/alerts` is available for the feed, but owner acknowledge endpoints require a browser session and reject desktop tokens. Therefore the first mobile alert feed is read-only; do not claim that an owner can mark an alert as seen until a new explicitly authorized contract exists.
- Push is optional and requires permission. Obtain an Expo push token through `expo-notifications` in a development/release build, then register it with a new authenticated mobile API. Proposed future interface: a user-scoped `POST /api/mobile/push-tokens` upsert `{ token, platform, appVersion }` and `DELETE /api/mobile/push-tokens/[id]` revoke; the server derives user/tenant from the Bearer token and never accepts caller-supplied tenant/user ids. This route/table and the server push delivery payload are new interfaces and must be reviewed, added to `docs/contracts.md`, privacy page and tests before implementation.
- Use normal visible notification messages with a minimal data payload for tap-to-open; do not rely on headless/data-only background work to fetch protected content. Expo notes that even delivered headless background notifications are not guaranteed to reach the app's JavaScript task.[18]
- Push dispatch should be added to the existing durable `neo/alert.created` delivery path and to the asynchronous inbound-verdict path; it must be idempotent per recipient/event. Mirror existing owner alert audience and threshold by default; keep the existing email delivery untouched. Define the exact member-versus-owner recipients and any separate push threshold with the owner before implementation.
- Store push tokens as sensitive device identifiers, tenant/user scoped and encrypted under a distinct HKDF info label; never reuse `neo-artifact-v1:<tenant>`. The new table has tenant RLS, is registered in `tenantTables`, and explicitly grants `app_user` access. Migration number is the next free number at implementation time. Do not log or expose tokens. A hash-only record is insufficient because the sender needs the token to deliver. Provide an app-level disable/revoke control, remove invalid/unregistered tokens on delivery receipts, rate-limit registration, and expire/revoke records on sign-out/account deletion. Expo documents that a successful push ticket means Expo received a payload, not that the person/device received it; receipts should be checked and delivery is best-effort without an SLA.[17]
- Payload contains only an opaque `alertId` or `verdictId`, a fixed category, and a generic title/body (for example, “Neo has an update”). Never include message text, URL/domain, verdict headline, member name, account email, evidence, passphrase or attacker-controlled string on the lock screen. After a tap, authenticate and fetch the exact record through existing role-scoped APIs; an expired/revoked session routes to sign-in, not to a public detail URL.
- Local notification permission denial or push-provider failure does not block chat, verdict history, alerts or existing owner email. Foreground handling, notification tap, cold launch, token rotation, duplicate delivery and invalid token receipt are tested.

### Account creation and deletion

- New users continue to be created through existing Auth.js providers during browser device authorization; the native app never creates its own identity or accepts an email address as a tenant id.
- Apple App Review Guideline 5.1.1(v) states that apps supporting account creation must offer account deletion within the app.[8] The current privacy page offers an email contact for account deletion, and this repository has no mobile-accessible deletion route. Add an in-app deletion entry and reviewed server-side deletion contract before App Store submission. On deletion, revoke/delete the user's mobile and desktop tokens, Apple refresh/access token, push registrations, Auth.js sessions/accounts, membership and hardening answers; delete user-owned conversations and artifacts. The contract must define disposition of linked verdicts/alerts and all other household-shared records. An owner with members must transfer ownership first; an owner alone may delete the household. Rotate the Apple client-secret JWT as required. Require deliberate confirmation and explain irreversible consequences.
- App Review must receive an active reviewer account or fully featured demo mode and any sample hardware/data needed (including a sample QR code); keep backend services available during review.[8]
- Store submission checklist: set `ITSAppUsesNonExemptEncryption`; declare Android target API and complete the Google Play Data safety form; set the age rating; provide AI-content disclosure.
- Mobile alert acknowledgements are read-only in v1.

### Explicitly unsupported in v1

- Automatic SMS/iMessage reading/filtering, default-SMS-app role, Android notification listener, call/SMS inbox permissions, clipboard monitoring, browsing history or passive page monitoring.
- Auto-opening/analyzing URLs or QR destinations, background camera, full gallery access, automatic share submission, automatic actions/remediation, or remote app control.
- Local malware scanning, jailbreak/root/device-posture checks, background location, model execution on-device, offline guarantee of a safe verdict, and sending raw content/URLs in push.
- Replacing owner email alerts, a `@neo/api-client` package, a public app-store launch, or public EAS Update/OTA policy without owner review.

## Contract gaps (documented now; no contract file edited at this checkpoint)

1. `GET /api/conversations` returns summaries, not message history; native chat needs a user/tenant-scoped detail contract.
2. Expo push registration/revocation, token persistence, push delivery and invalid-token cleanup do not exist; new API/storage/delivery contracts are required.
3. Account deletion does not exist as an in-app API flow; Apple store submission is blocked until server semantics and a route are specified.
4. Mobile alert acknowledgement cannot reuse the current owner acknowledge routes because they require a browser session. Acknowledgements are read-only and unavailable in v1.
5. A dedicated `mobile` token scope/kind is part of this work; `full` is permitted only as an interim fallback.

Changes to `docs/contracts.md` are intentionally deferred until implementation. This docs-only checkpoint does not invent mobile interfaces there; implementation must add approved contracts before interface code.

## Possible Edge Cases

- User approves the device request with another account, declines it, lets it expire or has the approval-page session signed out; show identity and restart with a fresh code, never reuse a redeemed code.
- Poll receives 202 pending, slow network, 429, expired/denied, token limit, malformed success payload, or a token whose scope is not exactly the approved mode.
- Secure storage is unavailable, OS backup restores unusable data, the same iOS Keychain item remains after reinstall, sign-out occurs offline, user changes accounts, or token is revoked from web Settings.
- App is a household member versus owner; household move/removal invalidates a snapshotted token; owners have other members and request account deletion.
- NDJSON chunks split inside UTF-8 code points, JSON lines, CRLF boundaries or the final unterminated line; server emits unknown/malformed events; app backgrounds or network disconnects mid-turn; confirmation is pending when app restarts.
- A full-scope token receives 403 because a route is browser-session-only; mobile must show read-only/unsupported rather than repeatedly retrying.
- User shares empty text, multiple files, a large email, a HEIC screenshot, a hostile filename, temporary URI with expired permission, a URL with credentials/private IP/non-HTTP scheme, or a share into a signed-out app.
- Share extension cold-starts, app is already running, multiple items are shared, iOS/Android OS strips metadata, or the experimental iOS share extension fails after an OS upgrade.
- QR contains plain text, malformed/oversized string, non-HTTP scheme, redirector or URL with credentials; decoded strings never get fetched before confirmation.
- Camera permission is denied/revoked; camera is unavailable; same QR fires repeatedly while the preview remains open; app may not scan in simulator.
- Push permission is denied/provisional/revoked, token rotates, Expo tickets are accepted but receipts fail, token is unregistered, notification arrives twice/out of order, or user taps it after record deletion/account switch.
- App is foreground/background/terminated; tapping notification opens the correct authorized detail or returns to sign-in without leaking alert content.
- EAS has missing Apple signing/APNs or Android FCM credentials, a new Apple account has role restrictions, Play Console personal account testing requirements are unmet, or an upload lands on the wrong track.
- pnpm isolated workspace resolution exposes an Expo/native module incompatibility or duplicate package; verify Expo Metro/autolinking and deduplication before changing the workspace's linker strategy.[16]

## Acceptance Criteria

- [ ] Expo workspace package is discoverable as `@neo/mobile`; `pnpm --filter @neo/mobile ...` works from the repository root; Turbo runs mobile `typecheck`, `lint`, `test` and `build` with mock/test configuration and no store credentials. No app code is added in this plan/spec checkpoint.
- [ ] Sign-in starts the existing device flow, opens the first-party browser approval page, polls per server interval, verifies identity/scope, and stores only the redeemed token in secure storage. Monitoring scopes never authorize mobile chat. Sign-out clears local data and attempts to revoke the same token id.
- [ ] A signed-in user can list conversations, load a conversation's messages, stream a new assistant turn, upload a supported screenshot/text artifact, continue after interruption, and explicitly approve/decline a confirmation. Existing server usage caps, injection checks, encryption, retention and role scoping remain in force.
- [ ] The new conversation-detail route contract exists and has owner/member/foreign-tenant tests before mobile history UI is implemented. Until then, the mobile app does not claim cross-device conversation history is complete.
- [ ] Incoming text, link and screenshot is shown in an editable preview; only an explicit user action uploads it. Cancellation has no server side effect. iOS share behavior is verified on physical devices or the owner-approved fallback is used.
- [ ] QR scanning decodes QR only with no network activity, displays the encoded content, and runs URL analysis only after user confirmation and only for HTTP(S). Tests assert no automatic `Linking.openURL`, fetch or upload from decode alone.
- [ ] Verdict/alert screens respect existing owner/member permissions. Mobile alert acknowledgements are read-only/unavailable in v1.
- [ ] Push registration is opt-in, revocable, tenant-scoped, generic on lock screen, tap-to-fetch and idempotent; test receipts remove invalid tokens; existing email/feed remains functional if push is unavailable. No raw user submission appears in Expo payload/logs.
- [ ] A working in-app account deletion path and the owner/member household data semantics are approved, implemented and tested before App Store submission.
- [ ] Current Auth.js passkey production support, NDJSON streaming on both platforms, and iOS incoming-share behavior are each validated or their approved alternatives are recorded.
- [ ] EAS produces an owner-approved iOS TestFlight build and Android Play internal-track build. No public store release occurs without a separate owner decision.

## Open Questions

1. Dedicated `mobile` scope is required now; `full` is only an interim fallback.
2. Passkeys are deferred until Auth.js offers production-supported functionality.
3. Paste/photo fallback is v1; defer iOS share extension until supported and validated.
4. Push is opt-in for eligible asynchronous verdicts and household alerts; preserve existing email/feed behavior.
5. Expo Push Service is approved with privacy disclosure and generic lock-screen content.
6. Mobile alert acknowledgements are read-only/unavailable in v1.
7. Owner with members transfers ownership first; an owner alone may delete the household. Account deletion semantics must define member-owned data retention and cascade before implementation.
8. Is a new conversation-detail API acceptable, and what UI-safe wire representation should it return?
9. Account deletion must be actionable within mobile Settings; other account management may use the first-party web page.
10. Who provisions/maintains Expo, Apple, App Store Connect, APNs and Google Play accounts and app identifiers? Is there an existing organization/personal Play account with any testing gates?
11. Is self-host server-origin selection needed in v1? What is the public app name, icon, bundle identifier and Android package name?
12. Should EAS Update be enabled at all, and if so what native/JS review, rollout and rollback policy applies?

## Testing Guidelines

- Use Vitest for pure helpers/state where it fits the existing workspace. Use a React Native-compatible component test setup only after checking the chosen Expo SDK's supported tooling; do not add a test-framework dependency as part of this docs-only change.
- API/client tests: device authorization start/poll/expiry/deny/one-shot, stored token never logged, Bearer header, base-URL validation, 401 logout, 403 non-retry, 429 `Retry-After`, NDJSON chunk boundaries/invalid events/final line, abort and no duplicate non-idempotent retry.
- Chat tests: history normalization hides server-only context, role/tenant isolation, empty conversations, stored attachment metadata, confirmation pending and explicit approval/decline, usage/storage errors.
- Share tests: text, URL, image and multiple items; preview/edit/cancel; cancellation makes no request; supported MIME/signature validation; size limits; HEIC conversion/error; expired content URI; account switch before send.
- QR tests: QR-only configuration, plain text, HTTP(S), malformed strings, `javascript:`/`data:`/`file:`/`intent:` rejected, no fetch/open/upload until explicit confirmation.
- Push tests: opt-in/deny/revoke, token update/dedupe, owner/member routing, generic payload allowlist, out-of-order/duplicate events, invalid provider receipt, no push if no token, no effect on email delivery.
- Account deletion tests: owner/member/owner-with-members semantics, confirmation, token/session/passkey/push-token revocation, tenant scoping, idempotency and data-retention/deletion rules.
- Manual device matrix: physical iOS and Android for browser approval, streaming, share cold/warm launch, screenshots, camera/QR, notification foreground/background/terminated, token revoke, and signed internal builds. Simulators/emulators alone do not verify push or share-extension behavior.
- Store-review readiness: active reviewer account or full demo mode, live backend, accurate privacy disclosures/permission strings, sample QR, completed store metadata, Apple Sign In, and account deletion tested end to end.

## Verified before implementation

Verified against current official sources on **2026-10-04**. The Expo `latest` SDK reference pages retrieved during this review identified SDK 57; that is a documentation snapshot, not an approved project version.[5][6][7] Re-check the SDK, provider status and store policies when implementation starts.

- **EAS Build:** Expo describes EAS Build as a hosted Expo service that builds installable app binaries for Expo/React Native; it offers Android/iOS cloud builds, signing-credential management, internal distribution, build profiles and EAS Submit integration.[1]
- **EAS Submit/release tracks:** EAS Submit uploads Android `.aab` files to a selected Google Play track including internal testing, and uploads iOS `.ipa` files to App Store Connect. A processed iOS submission appears in TestFlight; that does not automatically release the app publicly—store metadata and App Review submission are still required.[2]
- **Expo incoming sharing:** Current `expo-sharing` documentation describes receiving shared payloads, configures an iOS Share Extension/App Group and Android share intent filters, and exposes incoming-payload APIs. It expressly labels the receive-share feature experimental; on iOS it opens the main app target instead of a sharing view controller, which Expo says is not officially supported by Apple and may stop working in a future iOS version.[3]
- **EAS/iOS app extensions:** Expo's EAS app-extension page says CNG support is experimental and requires a config plugin/library that adds the extension target and declares the extension to EAS for credential handling.[4]
- **Push:** `expo-notifications` can obtain an Expo push token and handle incoming notifications/interactions; remote push is unavailable in Expo Go on Android from SDK 53 onward, so a development build is required.[5] Expo says a push ticket only confirms Expo accepted the payload; the server should check receipts and stop sending to a token marked `DeviceNotRegistered`; the service has no delivery SLA.[17]
- **Camera/QR:** `expo-camera` supports limiting `CameraView` barcode scanning to `qr`; `onBarcodeScanned` returns the decoded `data` value. Permission configuration can be done through the Expo config plugin.[6]
- **Credential storage:** `expo-secure-store` stores Android values encrypted using Android Keystore and iOS values in Keychain; iOS Keychain data may persist after uninstall/reinstall with the same bundle id.[7]
- **Apple Sign In review rule:** Guideline 4.8 does not name Apple as the only qualifying provider; it says an app using a third-party/social login such as Google Sign-In to set up/authenticate its primary account must also offer an equivalent option that limits collected data to name/email, supports a private email address and does not collect app interactions for advertising without consent. Sign in with Apple is the proposed equivalent for this product, per the roadmap; Apple lists exceptions, but this product does not assume it qualifies for one.[8]
- **Apple account/review prerequisites:** The Apple Developer Program includes TestFlight and App Store distribution benefits.[9] Expo says an authorized Apple Developer Program role is needed to create signing credentials for EAS iOS device builds.[12] Apple's current review checklist asks account-based apps to provide an active demo account/fully featured demo mode, keep backend services available, and Guideline 5.1.1(v) requires in-app account deletion if account creation is supported.[8]
- **Google Play account:** Google Play's current registration help page lists a one-time US$25 fee, identity verification, and additional test/device-verification requirements for new personal developer accounts before public distribution.[10]
- **Expo account:** Expo's EAS setup guide says an Expo account is required to use the service and that EAS Build is available on the free plan; paid plans add capacity/priority.[11]
- **Push credentials:** Expo's setup guide requires user permission and an Expo push token, Android FCM v1 credentials, and a paid Apple Developer account to generate iOS push credentials.[19] Expo's app-credentials reference identifies Apple Push Notification keys as the iOS push credential.[20]
- **Apple web Sign in with Apple setup:** Apple's current web configuration requires a Services ID associated with a primary Apple App ID enabled for Sign in with Apple, plus registered domain/subdomain and return URL.[14]
- **Auth.js passkeys:** Current Auth.js documentation calls its WebAuthn/Passkeys provider experimental and not recommended for production and requires a compatible DB adapter and authenticator table; Drizzle support is listed, but the current project pin still needs compatibility verification.[13]
- **pnpm monorepo:** Expo says it has first-class support for pnpm workspaces and built-in Metro monorepo support; it also warns duplicated React Native/React/native module versions can cause runtime/build failures.[16]

## Sources

[1] https://docs.expo.dev/build/introduction
[2] https://docs.expo.dev/submit/introduction
[3] https://docs.expo.dev/versions/latest/sdk/sharing
[4] https://docs.expo.dev/build-reference/app-extensions
[5] https://docs.expo.dev/versions/latest/sdk/notifications
[6] https://docs.expo.dev/versions/latest/sdk/camera
[7] https://docs.expo.dev/versions/latest/sdk/securestore
[8] https://developer.apple.com/app-store/review/guidelines
[9] https://developer.apple.com/programs
[10] https://support.google.com/googleplay/android-developer/answer/6112435
[11] https://docs.expo.dev/build/setup
[12] https://docs.expo.dev/app-signing/apple-developer-program-roles-and-permissions
[13] https://authjs.dev/getting-started/providers/passkey
[14] https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web
[15] https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple
[16] https://docs.expo.dev/guides/monorepos
[17] https://docs.expo.dev/push-notifications/sending-notifications
[18] https://docs.expo.dev/push-notifications/what-you-need-to-know
[19] https://docs.expo.dev/push-notifications/push-notifications-setup
[20] https://docs.expo.dev/app-signing/app-credentials
[21] https://docs.expo.dev/build-reference/build-with-monorepos
