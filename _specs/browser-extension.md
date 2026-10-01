# Spec for browser-extension

branch: claude/feature/browser-extension
plan: `_plans/phase-3-household-devices.md` (delivery step 5)

## Summary

The first Neo client that runs on a member's device. It is one WXT (Manifest V3) codebase, built for Chrome and
Firefox, in `apps/extension`. It does four things:

1. **Enrolls** the browser into a household, with the owner's enrollment code or the member's own sign-in (step 3).
2. **Detects** the plan's browser signals locally: tech-support-scam pages, lookalike logins and remote-access-tool
   downloads. It sends only the events defined in step 4, never history.
3. **Warns the person at the keyboard.** Clear-cut hits show a full-page warning straight away. Escalated hits show
   it once the server confirms them. Everything ambiguous fails open: no warning, no alert.
4. **Stays visibly present.** It has a toolbar icon and a popup that say who it reports to. It sends a heartbeat and
   reports its own removal, so an owner learns when a scammer says "uninstall that".

It also carries the roadmap's on-demand check: right-click a link or open the popup, and Neo checks it. Like the
passive detection, this check is deterministic and uses no model.

The server gains a small amount in this step:
- a status endpoint for pending escalations;
- the on-demand URL check route;
- an uninstall endpoint;
- `brands` in the detection lists;
- a tightened tech-support rule.

The server side of detection is otherwise done (step 4).

## Functional requirements

### Package and build (`apps/extension`)

- **Stack:** WXT with React for the popup, options and warning pages. It is a pnpm workspace package `@neo/extension`
  with `typecheck`, `lint`, `test` and `build` scripts, so CI and Turbo pick it up unchanged.
  - `build` produces `chrome-mv3` and `firefox-mv3` outputs.
  - `zip` produces store uploads, plus the source zip that AMO requires for bundled code.
- **Server URL:** set at build time by `WXT_NEO_BASE_URL`, defaulting to `https://www.neoshield.dev`.
  - The setup page has an "Advanced: server" field (before enrollment only) for self-hosters.
  - `pnpm --filter @neo/extension dev` runs against `http://localhost:3000` in MOCK_MODE.
- **Shared code:** a new browser-safe entry point, `@neo/tools/browser`, with no Node built-ins. It exports:
  - `registrableDomain`;
  - `detectLookalike` and `skeleton`;
  - `extractPhoneNumbers`;
  - `normalizeForMatch`;
  - the list types.

  Today `lookalike.ts` imports `node:url` and `node:net`. Those move behind small browser-safe helpers (a userland
  `punycode` and an IP-literal regex), and the Node entry re-exports the same functions.
- **Shared rule:** `@neo/verdict` exports `isTechSupportScamHit(indicators)`. The server rules and the extension
  both call it, so a local warning and a server alert can never disagree.
- **Platform:** `platform` is `chrome`, `edge` or `firefox`, taken from `navigator.userAgentData.brands` or the
  Firefox build target. Edge installs the Chrome build from the Chrome Web Store; an Edge Add-ons listing is out of
  scope.

### Permissions (manifest)

| Permission | Why |
|---|---|
| `<all_urls>` host permission, static content scripts (top frame, `document_start`) | Detect scam pages and lookalike logins on any site |
| `storage` | Token, device, cached lists, event queue (`storage.local` only, never `sync`) |
| `alarms` | Heartbeat, list refresh, queue retry |
| `downloads` | Notice remote-access-tool installer downloads (`downloads.onCreated`; the extension never cancels or opens files) |
| `contextMenus` | "Check this link with Neo" |
| `notifications` | Download warning |

- **Not requested:** `tabs`, `webNavigation`, `webRequest`, `scripting`, `history`, `cookies`, `activeTab`.
  - The plan's `new_tab_from_email` indicator needs `webNavigation`, so it is **not emitted** in this step.
- **Firefox:**
  - `browser_specific_settings.gecko` sets a fixed id and `strict_min_version` 128 (MAIN-world content scripts).
  - It also declares the data-collection categories that match the privacy statement. Check the exact keys against
    the AMO docs at implementation.
  - Onboarding checks `permissions.contains({ origins: ["<all_urls>"] })`, because Firefox lets the user withhold
    host access. It asks with `permissions.request` when access is missing.
- **Incognito:** the extension does not run in incognito unless the user allows it (the browser default).

### Enrollment and setup (options page, opened on install)

- **Not enrolled:** two choices.
  - **"I have a code from my family"** (enrollment code):
    1. The member types the code; it is case-insensitive, and dashes and spaces are optional.
    2. `POST /api/devices/enroll/preview` returns the preview.
    3. A consent screen reads: "This browser will warn you about scam pages and tell **<owner>** (household
       **<household>**) when it finds one. It never sends your browsing history."
    4. **Turn on protection** calls `POST /api/devices/enroll` with `kind: "browser_extension"`, the platform, a
       default name ("Chrome on Windows", editable) and the manifest version.
  - **"Sign in with my Neo account"** (self-enrollment):
    - `POST /api/desktop/device` is sent with `device: { kind, platform, name, clientVersion }`.
    - Verification opens in a new tab. The extension polls `POST /api/desktop/device/token` at the given interval until
      the member approves or the request expires.
- **Storage:** the token (`neo_dt_…`), `deviceId`, household, member and owner names go in `storage.local`. Page
  scripts cannot read it; the content scripts never receive the token.
- **Enrolled view:** "Protecting **<member>**'s browser for **<household>**". It shows the last check-in, what Neo
  watches for and what it never sends, and **Stop protecting this browser**.
  - That button asks for confirmation ("<owner> will be told"), then calls `DELETE /api/devices/self`, clears the
    stored state and returns to setup.
  - For an owner's own device the confirmation says nothing about telling anyone.
- **Pin the icon:** after enrollment, the page asks the member to pin the icon. Chrome hides extension icons by
  default, and the icon is the visible sign of monitoring.

### Background (service worker on Chrome, event page on Firefox)

- **Heartbeat:**
  - `POST /api/devices/heartbeat { clientVersion }` runs on install, on browser startup, and on an alarm every
    `heartbeatSeconds` (3600).
  - The response now also carries `uninstallUrl` (below), which is passed to `runtime.setUninstallURL`.
  - When `listsVersion` changed, the extension refetches the lists.
- **401 on any call:** the device was removed, or the member left. The extension clears the token and shows "This
  browser is no longer connected to a household" in the popup, with a grey icon.
- **403 `insufficient_scope`:** logged, never retried in a loop.
- **Lists:**
  - `GET /api/signals/lists` is fetched with `If-None-Match` and cached in `storage.local`.
  - A snapshot of `detectionLists()` is written into the build as a first-run and offline fallback.
  - Server-supplied regexes (`installerPatterns`) are compiled once. They only ever run on a filename of at most 128
    characters.
- **Event queue:**
  - Events go out in batches of at most 50 through `POST /api/signals`.
  - When the network or the server fails, they are kept in a `storage.local` queue: at most 100 events, dropped
    after 23 hours, since the server rejects them as `stale` at 24. They are retried on the next alarm, with
    exponential backoff honouring `Retry-After`.
- **Local dedupe:** at most one event per `(detector, domain)` per hour. Reloading a scam page 50 times sends one
  event.
- **Pending results:**
  - For an accepted event with `pending: true`, the extension polls `GET /api/signals/status` at 2, 4, 8, 16 and
    30 seconds, then every 30 seconds up to 90 seconds in total.
  - A confirmed verdict shows the warning (below). A dismissed one does nothing.
- **Context menu:** "Check this link with Neo" on links, and "Check this page with Neo" on pages. Either opens the
  popup-sized result window, which runs the on-demand check.

### Detectors

All detection runs on the device. Page text, URLs and form contents never leave it, except in the fields of the
events below and in on-demand checks the user starts.

**Tech-support-scam page** (`page` / `tech_support_scam`):

- **Where it runs:** a MAIN-world content script at `document_start` wraps a few page APIs and reports when they are
  used, through a `CustomEvent` on `document`:
  - `Element.requestFullscreen`, `Element.requestPointerLock` and `navigator.keyboard.lock`;
  - `history.pushState` and `replaceState` (counted);
  - `addEventListener("beforeunload")`, `onbeforeunload` and `HTMLMediaElement.play` (with `loop`).

  The wrappers call through unchanged, so pages behave exactly as before. An isolated-world content script collects
  these reports and listens to `fullscreenchange` and `pointerlockchange` itself.
- **Forged reports:** a page can forge these events. That only makes the page itself look worse, and the domain in
  the event comes from the isolated script's own `location`, never from the message.
- **Indicators:**

  | Indicator | Set when |
  |---|---|
  | `fullscreen` | The document enters fullscreen |
  | `pointer_lock` | The document enters pointer lock |
  | `keyboard_lock` | `navigator.keyboard.lock()` is called (Chrome only) |
  | `looping_audio` | A media element plays with `loop`, or restarts itself 3 or more times, without being visible as a video player |
  | `back_trap` | 3 or more history entries are pushed within 5 seconds of load without a user navigation, or a `popstate` handler pushes again |
  | `unload_trap` | A `beforeunload` handler is registered, and it calls `preventDefault` or sets `returnValue` |
  | `support_phone_text` | The visible text contains a `support` phrase from `scamPagePhrases` and a phone number (`extractPhoneNumbers`, with the page country from `navigator.language`) |
  | `fake_scan` | The visible text contains a `fake_scan` phrase |

- **Text:** the isolated script reads `document.body.innerText` (the first 100,000 characters, run through
  `normalizeForMatch`). It reads at `document_idle`, on each lock or fullscreen change, and after DOM changes
  (debounced to 1 second, for the first 60 seconds of the page only).
- **Hit and tighter rule:**
  - A hit is `isTechSupportScamHit(indicators)`: **at least one text indicator** (`support_phone_text` or
    `fake_scan`) **and at least 2 indicators in total**.
  - This amends step 4's server rule, "≥ 2 indicators, or `support_phone_text` plus any lock". Under that rule, a
    browser game using fullscreen plus pointer lock would be flagged as a scam. Such a page is now `recorded`.
  - A hit sends the event, including `phone` when one was found, and shows the warning **immediately**, without
    waiting for the server.

**Lookalike login** (`page` / `lookalike_login`):

- **When it runs:** a password field is present or appears, watched by a `MutationObserver`, and the page's
  registrable domain is not in `skipDomains`.
- **Indicators:** `password_field`, plus any of:
  - `punycode`: the host has an `xn--` label;
  - `lookalike_skeleton`: `detectLookalike` finds a brand with a skeleton or edit-distance technique;
  - `brand_in_subdomain`: a brand domain appears in the subdomain of an unrelated registrable domain.

  `brand` is the brand id from the lists.
- **Sending:** a password field alone is never sent. The event is sent at most once per domain per hour.
- **Waiting for the server:** the server escalates it (`pending`). The extension shows the warning only if the
  escalation returns a verdict. Form submission is never blocked while waiting (fail open).

**Remote-access-tool download** (`page` / `remote_tool_download`):

- **Trigger:** `downloads.onCreated` runs. The basename of `filename` (or of the URL path) matches a tool's
  `installerPatterns`, and the page domain is not in that tool's `vendorDomains`.
  - The page domain is the registrable domain of `referrer`, or of the download URL when there is no referrer.
- **Response:** the extension sends the event with `domain`, `toolId` and `fileName`, and shows a notification: "You
  are downloading **AnyDesk**. If someone on the phone asked you to install this, it is a scam. Hang up, and don't
  open it."
- **Not interfering:** the download is not cancelled or paused.

**Not in this step:**
- `dangerous_site`: see "Safe Browsing" below.
- `new_tab_from_email`: it needs `webNavigation`.

**Safe Browsing:** the extension does **not** do local Safe Browsing prefix matching.
- Chrome and Firefox already block Safe Browsing hits natively, and Neo's API key cannot be shipped in a client.
- A local hash-prefix database would also add megabytes and a sync job that duplicates what the browser does.
- The server's `dangerous_site` rule stays in place for a future client.

### Warning page (`warning.html`, an extension page)

- **Opening it:** the background navigates the tab with `tabs.update(tabId, { url })`. This also leaves fullscreen
  and escapes pointer or keyboard lock.
  - If the navigation fails, the tab is closed and the warning opens in a new tab.
  - The URL carries only the event id. The page reads the details (detector, domain, brand, owner name) from
    background state.
- **Content** (plain words, large type):
  - Tech support: "**This is a fake warning.** Microsoft and Apple never show phone numbers on web pages. Your
    computer is fine. Don't call the number, and don't let anyone connect to your computer."
  - Lookalike login: "**This page is pretending to be <Brand>.** Don't type your password here. Go to <brand
    official domain> yourself."
  - The domain is shown defanged. When the ingest result says an alert was raised for a member's device, the page
    adds "Neo let **<owner>** know."
- **Buttons:**
  - **Take me to safety** opens the browser's new-tab page.
  - **Go back to the page anyway** is a secondary link. It sends a `warning_bypassed` event (`relatesTo` the
    event's id) and returns to the original URL. It suppresses warnings for that domain for 1 hour, so the page
    cannot trap the member in a loop.
- **Content security policy:** the page has a strict CSP and renders no page-supplied text except the defanged
  domain and the brand name taken from the lists.

### Popup and toolbar icon

- **Icon states:**
  - A shield when enrolled.
  - A grey shield with a "!" badge when not enrolled or disconnected.
  - A red "!" badge while a warning from the last hour is open in any tab.
- **Popup:**
  - Who it protects and for which household, and the last check-in.
  - **Check this page** and a "Paste a link to check" field.
  - Links to the options page and to Neo on the web.
- **Check result:**
  - **Dangerous:** red, with the reasons.
  - **Suspicious:** amber, with the reasons.
  - **No known problems:** neutral: "Neo found no known problems. That doesn't guarantee it's safe."
  - **Couldn't check:** grey.

### Server changes (contracts first)

- **`isTechSupportScamHit`** is added to `@neo/verdict`. `apps/web/lib/server/signals/rules.ts` uses it, and the
  rules table in `_specs/signals.md` and `docs/contracts.md` is amended.
- **`GET /api/signals/status?ids=<id>,<id>`:**
  - Auth: scope `signals:write` and `deviceId`; 1–50 client event ids.
  - Returns 200 `{ results: { id, outcome, severity?, verdictId?, alerted: boolean }[] }`, for this device's events
    only. Unknown ids are omitted.
  - Rate limit: 120 per hour per device.
- **`POST /api/devices/check-url { url }`:**
  - Auth: scope `url:check` and `deviceId`. `url` is at most 2048 characters, `http` or `https` only.
  - It runs `analyzeUrl` with the shared reputation cache and maps the result deterministically. The mapping is
    extracted from `escalate.ts` into one `classifyUrlAnalysis` used by both:
    - `dangerous`: Safe Browsing or urlscan flags it, or VirusTotal has ≥ 3 malicious engines.
    - `suspicious`: a brand lookalike, a domain under 30 days old, or 1–2 VirusTotal engines.
    - `unknown`: every reputation source was skipped or errored.
    - `no_known_problems`: otherwise.
  - Response: 200 `{ rating, domain, reasons: string[], checkedAt }`. `reasons` are template sentences, never page
    text.
  - Not saved as a verdict and raises no alert: the person asked and saw the answer.
  - Not counted against the household's monthly checks, since no model runs. It is capped at 30 per hour and 200 per
    day per device (429 with `Retry-After`).
  - Logs the registrable domain only.
- **Lists:** `GET /api/signals/lists` gains `brands: { id, name, domains, keywords }[]` from `BRANDS`. The id is a
  stable slug, and the `version` hash covers it.
- **Uninstall signal:**
  - The heartbeat response gains `uninstallUrl`:
    `https://<host>/uninstalled?d=<deviceId>&s=<sig>`. `sig` is HMAC-SHA256 of the device id under a key derived
    from `AUTH_SECRET` (label `neo-uninstall-v1`), base64url, 22 characters. No new env var or column is needed.
  - `app/uninstalled/page.tsx` (public) POSTs `{ d, s }` to `POST /api/devices/uninstalled` on load, then says "Neo
    was removed from this browser. <owner> has been told." It links to reinstall.
  - The route (no auth) verifies the signature in constant time. It then revokes the device and its tokens and
    raises the existing `device_removed` alert ("… was uninstalled", with `by: "device"` in the audit).
  - It is idempotent, answers 204 for any well-formed request (so it reveals nothing), and is rate limited at 10 per
    hour per IP.
  - `vercel.json` sends `Referrer-Policy: no-referrer` on `/uninstalled`.
- **Settings → Household → Add a device:**
  - The browser instructions link to the store listings from `NEXT_PUBLIC_CHROME_EXTENSION_URL` and
    `NEXT_PUBLIC_FIREFOX_EXTENSION_URL`. Both are new, optional, and in `.env.example`.
  - When a URL is unset, that browser still shows "coming soon".
- **Privacy page:**
  - The browser extension checks pages on the device. It sends Neo only the domain of a page that looked like a
    scam or a fake login, and the name of a remote-access installer downloaded from an unexpected site.
  - When the person asks Neo to check a link, it sends that link.
  - It never sends browsing history, page content, form contents or passwords.

### Store and release

- **`docs/extension.md` covers:**
  - development against MOCK_MODE;
  - building and loading unpacked;
  - release steps;
  - the Chrome Web Store single-purpose statement, permission justifications (the table above) and privacy-practices
    answers;
  - the AMO data-collection declaration and source-code submission.
- **CI:**
  - `checks` builds both targets.
  - A workflow on tags `extension-v*` (SHA-pinned actions) attaches the Chrome zip, Firefox zip and source zip to a
    GitHub release.
  - Store submission stays manual; the developer accounts are the owner's to create.
- **No remote code:** detection lists are data. Server regexes are compiled as patterns, never evaluated as code.

### Mock mode and development

- With `pnpm --filter @neo/web dev` in MOCK_MODE and `DEV_AUTH_BYPASS`:
  - An owner generates a code in Settings → Household, and the dev extension enrolls with it.
  - Signals, status, lists, check-url and uninstall all work against the memory stores.
- Test pages for manual checks go under `apps/extension/test/fixtures/`:
  - a fake support page with a `555` number;
  - a punycode login;
  - an installer link.

## Possible Edge Cases

- **A browser game or video player** uses fullscreen, pointer lock and looping audio. There is no scam text, so it
  is not a hit on the device and is `recorded` on the server.
- **A real support article** mentions "call Microsoft support" and a number. That is one text indicator and no
  behaviour, so it is not a hit.
- **The scam page's `beforeunload` blocks navigation.** `tabs.update` from an extension is not a user unload; if it
  still fails, the tab is closed and the warning opens in a new one.
- **The scam page detects and removes Neo's wrappers.** Detection degrades to the isolated-world signals
  (`fullscreen`, `pointer_lock` and the text). It fails open; a determined page can evade a heuristic.
- **The member is offline.** Tech-support warnings still show, from local rules. Events are queued and sent later
  (within 23 hours). Lookalike warnings need the server, so they fail open.
- **The phone number is in an image.** No `support_phone_text`, so `fake_scan` plus behaviour is needed. Otherwise
  it fails open.
- **A scammer on the phone says "click Stop protecting".** It requires confirmation, and the owner gets a `high`
  `device_removed` alert.
- **The extension is uninstalled from the browser menu.** The uninstall URL opens and the owner is told within
  seconds. If the browser has no network at that moment, the offline alert follows after 48 hours.
- **The extension is only disabled.** No uninstall URL opens, so the offline alert follows after 48 hours.
- **Someone forges uninstall requests.** They need a signature for a real device id, which only that device's
  heartbeat response carries.
- **The uninstall URL is visible in the browser history.** It can only remove that already-uninstalled device.
- **A lookalike login on a user-content host** (for example `evil.github.io`). The skip list never contains those
  hosts (step 4), so the check runs.
- **The skip list is stale on first run.** The bundled snapshot is used until the first fetch.
- **Firefox with host access withheld.** Content scripts do not run. The popup and options page show "Neo can't
  check pages. Allow access to all sites," with a button that requests it.
- **Several warnings in a row on the same domain.** One event per hour per detector and domain. After a bypass, no
  warning on that domain for an hour.
- **A Chrome service worker restart mid-poll.** Pending ids are persisted with the queue, and polling resumes on
  wake until the 90-second window from the ingest time is over.
- **A self-hosted server** at a custom URL. The `<all_urls>` host permission already covers it, and it is set before
  enrollment only.

## Acceptance Criteria

- [ ] The extension builds for Chrome and Firefox in CI with the permissions above and nothing more. The build
      fails if a Node built-in reaches the extension bundle.
- [ ] Enrollment by code (preview, consent, enroll) and self-enrollment both yield a device and a monitoring token.
      Stop protecting revokes it; a 401 returns the extension to the disconnected state.
- [ ] A fixture fake-support page (text, number, fullscreen) shows the warning without a server round trip, and
      sends one `tech_support_scam` event. The owner gets a `high` `scam_page` alert.
- [ ] A fullscreen plus pointer-lock game page with no scam text neither warns nor alerts, on the device or the
      server.
- [ ] A punycode brand-lookalike login is escalated. The warning shows only if the status endpoint returns a
      verdict; otherwise nothing is shown.
- [ ] Downloading an installer that matches a tool's pattern from a non-vendor domain shows the notification and
      raises a `medium` `remote_access` alert; from the vendor's domain, nothing.
- [ ] **Go back to the page anyway** sends `warning_bypassed`, raises the owner alert one step, and suppresses
      re-warning on that domain for an hour.
- [ ] Right-click "Check this link" returns a rating from `POST /api/devices/check-url`. It is not saved, not
      alerted, and not counted against monthly checks; the 31st in an hour gets 429.
- [ ] Uninstalling opens `/uninstalled`, which revokes the device and raises `device_removed`. A bad signature
      changes nothing and still gets 204.
- [ ] The heartbeat keeps the device active, refetches lists when `listsVersion` changes, and sets the uninstall URL.
- [ ] The privacy page, contracts, signals spec rule table, `.env.example` and `docs/extension.md` are updated.

## Open Questions

- **Store accounts and listing copy.** The Chrome Web Store developer account (one-time fee) and the AMO account are
  the owner's to create. Listing screenshots and descriptions are drafted in `docs/extension.md` for review.
- **A per-device "pause" for the member.** It is left out: a pause is what a scammer would ask for, and Stop
  protecting already exists and tells the owner.
- **Page languages beyond English.** The lists already carry `lang` (step 4). The extension matches every phrase
  regardless of page language, so adding languages needs no client change.

## Testing Guidelines

Create test files in the `./test` folders for the new feature, with meaningful tests for the following cases,
without going too heavy:

- `apps/extension/test/tech-support.test.ts` (jsdom, fixtures):
  - the indicator collectors;
  - `isTechSupportScamHit` on the fixture page, a game page and a support article;
  - forged `CustomEvent`s cannot change the reported domain.
- `apps/extension/test/lookalike.test.ts`: punycode, skeleton and brand-in-subdomain indicators; skip-list
  suppression; no event for a password field alone.
- `apps/extension/test/downloads.test.ts`: installer pattern and vendor-domain matching, with referrer fallback.
- `apps/extension/test/background.test.ts` (WXT `fakeBrowser`, mocked `fetch`):
  - enrollment by code and by device flow;
  - the heartbeat sets the uninstall URL and refetches lists on a version change;
  - 401 disconnects;
  - queueing, backoff and stale drop;
  - local dedupe;
  - pending polling to a warning or to nothing.
- `packages/tools/test/browser-entry.test.ts`: the browser entry's functions match the Node entry's results on the
  lookalike and phone corpora.
- `packages/verdict/test/signals.test.ts`: `isTechSupportScamHit` cases.
- `apps/web/test/signals.test.ts` (extend):
  - the amended tech-support rule;
  - the status route (scope, own device only, omitted unknown ids, rate limit);
  - `brands` in the lists.
- `apps/web/test/device-check-url.test.ts`: scope and 403s, the rating mapping on `MOCK_URLS`, not saved or alerted,
  rate limits.
- `apps/web/test/device-uninstalled.test.ts`: a valid signature revokes and alerts once; bad or missing signatures
  return 204 with no change; the rate limit applies.
