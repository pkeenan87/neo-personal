# Expo mobile app — plan

Status: **plan/spec only** (2026-10-04); a docs-only draft PR is part of the spec checkpoint. No app scaffold, code, OAuth changes, migration, privacy-policy edit, or store submission is part of this step.

Parent: `_plans/deferred-roadmap-items.md`, step 6. Product roadmap: `_plans/phase-0-and-roadmap.md`, Phase 2. Spec: [`_specs/mobile-app.md`](../_specs/mobile-app.md).

## Goal

Add an Expo React Native app in `apps/mobile` for iOS and Android. It gives a household member the existing Neo chat and verdict experience, accepts suspicious messages, links and screenshots through the native share affordance, decodes QR codes locally before the user submits a URL for analysis, and delivers opt-in verdict/owner-alert notifications. Release candidates go through EAS Build, TestFlight and Google Play internal testing.

The mobile app is a user-facing account client, **not** a monitoring agent. It must not read SMS, notification history, browsing history, photos or clipboard in the background; enroll itself as a monitored `devices` row; or run a local malware scanner.

## Repository findings and reuse

- The repository is pnpm 12.6.0 + Turborepo on Node 22+. `pnpm-workspace.yaml` already includes `apps/*`; `turbo.json` discovers package scripts and the default build outputs include `dist/**`. Expo documents first-class pnpm workspace support and built-in Metro monorepo support, with duplicate React/React Native/native module versions called out as a build/runtime hazard.[16]
- Vercel serves `apps/web`; it is not a mobile build host. `apps/mobile` should be a separate Expo workspace, use the existing web API host, and never contain provider or server secrets.
- The web app already exposes documented Bearer-capable routes for device authorization, chat/NDJSON, conversations, artifact upload, verdicts, usage and alerts. `_specs/desktop-auth.md` and `_specs/device-enrollment.md` are the auth references. `apps/extension/lib/api.ts`, `apps/desktop/crates/agent-core/src/api.rs`, `apps/web/lib/agent-client.ts` and `apps/web/lib/ndjson.ts` are implementation references, not mobile dependencies.
- The existing token scopes are `full`, `device`, `signals:write` and `url:check`. Monitoring tokens do **not** authorize chat, artifacts, verdicts or alerts. Mobile gets a dedicated `mobile` scope/kind with its own cap and Settings identity; `full` is an interim fallback only. The device request omits the `device` field.
- There is no implemented `@neo/api-client` package, conversation-detail route, push-token route/store/delivery channel, or in-app account-deletion route. The parent household plan says the alert channel interface is shaped for push, but the checked `apps/web/lib/server/alerts/index.ts` and `apps/web/inngest/functions/alert-created.ts` implement email only; treat push as new work, not reusable code. Keep the first mobile API adapter local to `apps/mobile`; do not create a shared package during this plan-only step. New conversation, push and account-deletion server contracts must be reviewed and added to `docs/contracts.md` before any related interface code.

## Approved decisions and remaining owner inputs

| Topic | Decision | Remaining owner inputs |
|---|---|---|
| Workspace | `apps/mobile`, package `@neo/mobile`; Expo managed/CNG project; local typed API adapter. Use existing workspace globs and Turbo tasks, not a new monorepo layout. | Use a public-host-only self-hosted server URL in v1; owner decides app IDs/accounts and app display name. |
| Auth | Start and redeem the existing browser device-authorization flow. Use the dedicated `mobile` token scope/kind, store it in OS-backed secure storage, and allow self-revocation. `full` is an interim fallback only; mobile tokens have their own Settings label/section and independent cap. Do not reuse monitoring tokens. |
| Sign-in providers | Add Apple Sign In to the existing Auth.js web sign-in page alongside Google and Resend. Apple’s current App Review rule calls for an equivalent qualifying sign-in option when a third-party/social provider such as Google authenticates the primary account; plan for Sign in with Apple.[8] | Approve Apple developer configuration and confirm the browser approval flow presents Apple sign-in acceptably to App Review. |
| Passkeys | Defer experimental Auth.js Passkeys; revisit when production-supported.[13] |
| Share intake | Paste/photo fallback before any iOS share extension; defer extension until support is validated.[3][4] |
| Push | Expo Push Service is approved; disclose its processing in the privacy page. Keep opt-in, generic payload and existing email/feed fallback. Push registration/delivery is a new server contract. |
| Account deletion | Put a clear delete-account action in mobile Settings and complete deletion on the server. An owner with members transfers ownership first; an owner alone may delete the household. Sign in with Apple deletion revokes Apple's token and rotates the Apple client-secret JWT as required.[8] | No store submission until deletion cascade and revocation are implemented and tested. |
| Release | EAS cloud builds, TestFlight and Play internal track; no automatic public release. Store checklist: `ITSAppUsesNonExemptEncryption`, Android target API and Data safety form, age rating, AI-content disclosure. | Owner decides app IDs/accounts, credentials and store listing. |

## Delivery stages and dependencies

1. **Owner review and prerequisites.** Resolve the gates above, confirm account ownership and bundle/package IDs, create the Expo project, and set the canonical hosted API origin. Apple Sign In for the web approval page requires an Apple Services ID associated with an enabled primary App ID and registered domain/return URLs.[14]
2. **Workspace and auth foundation.** Add `apps/mobile` with `dev`, `typecheck`, `lint`, `test` and `build` scripts; have the local `build` produce an Expo JS export under `dist/` for Turbo. Keep `eas build`/submission as explicit release commands, not part of the ordinary Turbo `build`. Implement device-code flow with `ASWebAuthenticationSession`/Custom Tabs return UX, client name and code on approval page, dedicated `mobile` Bearer scope (`full` interim fallback only), SecureStore persistence, self-revoke and 401/403/429 handling. Add Apple Sign In to Auth.js; experimental Passkeys remain deferred until production-supported.
3. **Chat and evidence intake.** Build conversation/history/chat screens against existing APIs. First prove on Android and iOS development builds that React Native can consume the existing NDJSON stream and multipart artifact uploads reliably. Normalize a user-initiated shared text, URL or screenshot into an editable preview; upload images using the existing type/size rules and attach them to `/api/agent`. Do not auto-fetch a shared URL or silently submit a share payload.
4. **Verdicts, household alerts and QR.** Add role-aware verdict/alert lists using current APIs: owners see household alerts; members see only their own. Decode QR data locally, show the decoded value and require a tap to analyze only `http`/`https` URLs through `/api/agent`, which counts against quota and creates a verdict; `/api/devices/check-url` is not for mobile (requires `url:check` and device id, otherwise 403). Do not open the QR destination, fetch it from the device, or treat decode as a verdict.
5. **Push and account lifecycle.** Add the approved token-registration/revocation, push-delivery and in-app deletion contracts; add tenant-safe persistence, retention, rate limits, mock behavior and tests; update `docs/contracts.md`, the privacy page (including Expo Push disclosure) and relevant tests in implementation. Push is opt-in for eligible asynchronous verdicts and household alerts; acknowledgements remain read-only. The existing `alert-created` worker sends email only; preserve email delivery and do not overload its `email_status` field with push state. Use durable/idempotent delivery and remove invalid Expo push tokens after provider receipts indicate they are unregistered.[17]
6. **Internal release validation.** Configure EAS development/preview/production profiles and credentials. EAS Build produces hosted Android/iOS binaries and can manage signing credentials; EAS Submit uploads Android builds to a selected Play track and iOS builds to App Store Connect/TestFlight. A TestFlight upload is not a public App Store release.[1][2] Test in TestFlight and the Play internal track, then stop for owner store-review approval.

## Workspace and release details

- Keep the Expo SDK, React and React Native versions singular across the monorepo. Use Expo's `expo/metro-config`; only add custom Metro settings if a real workspace-resolution failure requires them. Verify Turbo sees `@neo/mobile` scripts and the `dist/**` build output; do not change root scripts unless verification proves it necessary.
- Keep EAS-specific configuration (`eas.json`, credentials config) in `apps/mobile` and run EAS CLI commands from that app directory; Expo documents that each Expo app in a monorepo has its own EAS config root.[21]
- Use EAS development builds for native API work; Expo Go is not a release/test substitute. In particular, remote push notification functionality is unavailable in Expo Go on Android from SDK 53 onward and needs a development build.[5]
- An Expo account is needed to use EAS Build; Expo says the service is available on its free plan.[11]
- EAS iOS device signing needs an Apple account role that can create signing credentials.[12] Apple Developer Program membership provides TestFlight and App Store distribution.[9]
- Google Play internal testing requires a Play Console developer account; Google's current help page lists a one-time US$25 registration fee and verification/testing requirements for new personal accounts.[10]
- Treat app-store build credentials and APNs/FCM setup as owner-managed secrets; never commit them. Expo's current push setup requires Android FCM v1 credentials and a paid Apple Developer account to generate iOS push credentials; the EAS Apple credential guide identifies APNs push keys as a required credential for push.[19][20] Do not put `neo_dt_` tokens, Expo push tokens or OAuth credentials in the JS bundle, app config, analytics or crash logs.

## Privacy and security boundaries

- The app uses the server as authority for user, role and tenant. Never accept a tenant id from the app payload. Use HTTPS except localhost development, send `neo_dt_` credentials in the HTTP Authorization header using Bearer authentication, set `Cache-Control: no-store` on sensitive responses, and use secure storage for the one-time token. Clear local credentials after sign-out, deletion, household-move invalidation or an unrecoverable 401.
- Existing chat/artifact security stays in force: user-submitted messages, screenshots, links, QR data and API responses are untrusted; artifacts use the existing encrypted store and 30-day raw-evidence retention. Don't write raw shared payloads to logs or durable local storage.
- Push permission is optional. The default notification text must not reveal message text, URL/domain, verdict headline, member name or alert body on the lock screen. Send an opaque entity id/type only; fetch the authorized detail after a tap. Keep the alerts feed and email as fallbacks. Expo’s delivery is best-effort; the Expo service documents tickets/receipts and no delivery SLA.[17][18]
- Request camera permission only when the user opens QR scan, explain decode-only use, and request no microphone permission. `expo-camera` can scan selected barcode types (including QR) and returns decoded data through its scan callback.[6]
- The privacy policy (including Expo Push disclosure), Apple privacy details, Google Play Data safety form and permission-purpose strings must match actual sharing, camera, push-token, retention and account-deletion behavior before any store submission.

## Risks

| Risk | Mitigation / gate |
|---|---|
| Mobile scope is dedicated; `full` is only an interim fallback. | Mobile tokens have their own cap and Settings identity. |
| React Native stream support or file-URI multipart behavior differs from browser fetch. | Spike both on physical Android/iOS dev builds before building the chat UI; do not silently buffer a long AI response. |
| iOS incoming share uses experimental Expo extension behavior and app-extension CNG support is experimental. | Physical-device/TestFlight verification plus manual intake fallback; owner approves risk.[3][4] |
| Auth.js passkeys are experimental. | Owner decision before wiring the provider into production Auth.js.[12] |
| pnpm's isolated workspace layout exposes a React Native package-resolution issue. | Verify Expo Metro/autolinking and deduplicate first; do not change the repository-wide linker strategy without a reproducible failure.[16] |
| Push permission denial, stale Expo token, or provider outage. | In-app feed/email remain the source of truth; check tickets/receipts, retry transient failures, deactivate unregistered tokens.[17] |
| Owner with members transfers ownership; owner alone may delete household. Test cascade and Apple token revocation before store submission.[8] |
| New personal-data processing by Expo Push Service. | Minimize lock-screen payload; disclose push-token processing and user controls in the updated privacy policy before release. |

## Acceptance criteria

- [ ] `apps/mobile` is an Expo app discovered by the existing pnpm workspace and Turbo scripts; no duplicate React/React Native/native module versions; normal CI runs typecheck, lint, tests and Expo export without store credentials.
- [ ] Device authorization uses the existing browser approval endpoints, shows the approving account, stores the one-time `neo_dt_` token only in OS-backed secure storage, supports self-revocation, and never persists a monitoring token as a chat credential.
- [ ] Chat, conversation history, attachments and streamed events work on physical iOS and Android devices against MOCK_MODE and the existing API contracts; server-side tenant/role scoping is unchanged.
- [ ] Sharing text, a link and a screenshot opens an editable preview; supported evidence is submitted only after user confirmation; cancellation sends nothing. iOS share-extension behavior is verified or the approved fallback is used.
- [ ] QR scan accepts only the QR symbology in the scanner, decodes without network access, and requires explicit confirmation before an `http`/`https` URL is analyzed. Non-URL payloads and unsafe schemes cause no network request.
- [ ] Owners and members see only the verdicts/alerts permitted by existing APIs. Push is opt-in, content-minimized, tap-to-fetch and has a tested disable/revoke path; the email/feed still work without push permission.
- [ ] An in-app account deletion flow and documented owner/member data semantics pass before App Store submission.
- [ ] Owner can install a signed iOS build in TestFlight and an Android build on the Play internal track; production store release remains a separate owner decision.

## Owner decisions recorded

1. Dedicated `mobile` scope is approved; `full` is interim fallback only.
2. Passkeys are deferred until production-supported.
3. Paste/photo fallback precedes any iOS share extension.
4. Push is opt-in for eligible asynchronous verdicts and household alerts; preserve existing email/feed behavior and disclose Expo Push processing.
5. Expo Push Service is approved with privacy disclosure.
6. Account deletion requires ownership transfer for an owner with members, or deletes the household if the owner is alone; revoke Apple tokens and rotate its client-secret JWT as required.
7. Who owns the Expo, Apple Developer/App Store Connect and Google Play Console accounts, and what bundle ID, Android package name, app name and production API host should be used?
8. Self-host server URL in v1 is public-host-only.

## Verified official sources

Reviewed 2026-10-04; details are in `_specs/mobile-app.md` under **Verified before implementation**. Recheck current versions/policies when implementation starts because Expo and store documentation is living documentation.

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
