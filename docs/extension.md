# Browser extension

Neo's browser extension (`apps/extension`, package `@neo/extension`) is one [WXT](https://wxt.dev) codebase, built as
Manifest V3 for both Chrome and Firefox. It detects tech-support-scam pages, lookalike logins and remote-access-tool
downloads entirely on the device, using the shared detection lists and rules from `@neo/tools` and `@neo/verdict`.
See `_specs/browser-extension.md` for the full functional spec and `docs/contracts.md` ("HTTP contract: devices",
"HTTP contract: signals", and the browser-extension sections at the end) for the wire contracts it talks to.

## Development against MOCK_MODE

The extension talks to a running Neo server; for development that's the local web app in mock mode, with no
database, API keys or Vercel project needed.

1. Start the server (repo root):
   ```bash
   MOCK_MODE=true DEV_AUTH_BYPASS=true pnpm --filter @neo/web dev
   ```
   This signs you in as the dev user (`dev@neo.local`) in a dev household at `http://localhost:3000`.
2. Generate an enrollment code: open `http://localhost:3000/settings/household`, add a member if needed, and create
   a device enrollment code for them (or for yourself, as the owner).
3. Run the extension against that server:
   ```bash
   pnpm --filter @neo/extension dev          # Chrome/Edge, http://localhost:3000
   pnpm --filter @neo/extension dev:firefox  # Firefox
   ```
   `wxt` opens a dedicated browser profile with the unpacked extension loaded and hot-reloads on save. The dev
   build's default server is `http://localhost:3000` (see [Build-time configuration](#build-time-configuration)); no
   extra setup is needed to point it there in dev mode.
4. Open the extension's options page (its toolbar icon, or `chrome://extensions` / `about:debugging` → *Inspect*)
   and paste in the code from step 2. Confirm the consent screen and you're enrolled.
5. Everything else — heartbeats, detection-lists fetch, signal ingest, the on-demand link check, and uninstall —
   works against the web app's in-memory (MOCK_MODE) stores, no Postgres or Inngest required. Restarting the dev
   server resets that state.

To exercise a specific detector without waiting for a real scam site, open the fixtures under
`apps/extension/test/fixtures/` in the dev browser (see [Manual test fixtures](#manual-test-fixtures) below).

### Build-time configuration

The server base URL is set at build time by `WXT_NEO_BASE_URL`, defaulting to `https://www.neoshield.dev`:

```bash
WXT_NEO_BASE_URL=http://localhost:3000 pnpm --filter @neo/extension build
```

Unset, the code still works — it falls back to the production default. A self-hoster (or anyone testing against a
non-default server) can also set the server from the options page's "Advanced: server" field, shown only before
enrollment; that choice is then stored with the device and used for every later call.

## Building and loading unpacked

```bash
pnpm --filter @neo/extension build   # writes .output/chrome-mv3 and .output/firefox-mv3
```

This first regenerates `lib/data/lists-snapshot.json` (the bundled first-run/offline fallback of
`detectionLists()`; see `scripts/build-lists-snapshot.mjs`), then runs `wxt build` for both targets.

**Chrome / Edge:**

1. `chrome://extensions` (or the Edge equivalent) → enable **Developer mode**.
2. **Load unpacked** → select `apps/extension/.output/chrome-mv3`.
3. Pin the icon (Neo asks for this after enrollment too — Chrome hides new extension icons by default, and the
   icon is the visible sign that a browser is being watched).

**Firefox:**

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select any file inside
   `apps/extension/.output/firefox-mv3` (e.g. `manifest.json`). A temporary add-on is removed when Firefox restarts;
   for a longer-lived install use `pnpm --filter @neo/extension dev:firefox` or sign the built package.
2. If content detection doesn't seem to run, check **Allow this extension to run in Private Windows** / host
   permissions: `about:addons` → Neo → **Permissions**. Firefox lets a person withhold the `<all_urls>` host
   permission at install; the options page and popup show "Neo can't check pages. Allow access to all sites." with
   a button that requests it, when that happens.

## Release steps

1. Bump `apps/extension/package.json`'s `version` (semver; this becomes the manifest `version` for both targets).
2. From the repo root: `pnpm install` (updates the lockfile if needed), then
   `pnpm --filter @neo/extension... typecheck lint test build`.
3. `pnpm --filter @neo/extension zip` — writes, under `apps/extension/.output/`:
   - `neo-extension-<version>-chrome.zip` (Chrome Web Store upload);
   - `neo-extension-<version>-firefox.zip` (AMO upload);
   - `neo-extension-<version>-sources.zip` (AMO's required source archive for reviewable bundled code — see
     [AMO submission](#amo-firefox-add-ons) below).
4. Tag the release: `git tag extension-v<version> && git push origin extension-v<version>`. The
   `extension-release.yml` workflow builds both targets fresh from that tag and attaches all three zips to a GitHub
   release (`extension-v<version>`), so the store-upload files are reproducible and don't depend on a local build.
5. **Store submission is manual** (`_specs/browser-extension.md` "Open Questions": the developer accounts are the
   project owner's to create). Download the release's zips and upload them by hand — see the two sections below.

## Chrome Web Store

**Developer account:** one-time registration fee, at <https://chrome.google.com/webstore/devconsole>.

**Single-purpose description** (Chrome requires a one- or two-sentence statement of the extension's single
purpose):

> Neo warns a household member, on their own device, when a page shows the classic signs of a tech-support scam or a
> fake login, and lets the household's owner know when it does.

**Permission justifications** (for the "Permissions" tab of the listing):

| Permission | Justification |
|---|---|
| Host permission `<all_urls>` (+ content scripts) | Neo detects scam pages and fake logins by reading page text and behaviour locally, on every site; a per-site allowlist would defeat the point (the whole web is where scams happen) and there is no API-only alternative to reading the page. |
| `storage` | Stores the device's own monitoring token, the cached detection lists and the outgoing event queue locally (`storage.local` only). Never synced to a Google/Mozilla account. |
| `alarms` | Schedules the periodic heartbeat, detection-list refresh and event-queue retry without keeping the background page alive continuously. |
| `downloads` | Reads completed downloads' filename and referring page to notice a remote-access-tool installer downloaded from an unexpected site; Neo never opens, cancels or modifies a download. |
| `contextMenus` | Adds "Check this link/page with Neo" to the right-click menu, for the on-demand check. |
| `notifications` | Shows a local warning when a remote-access-tool installer download is detected. |

**Privacy practices tab (data disclosure):** the extension collects and transmits, to Neo's own servers only:

- **Website content**: the registrable domain of a page that matched a scam-page or fake-login pattern (never the
  full URL, page text, or form contents); a remote-access tool's name and installer filename when downloaded from
  an unexpected site; a link the person explicitly pastes or right-clicks to check.
- **Personally identifiable information**: none beyond what identifies the household's own device (a random device
  id and a bearer token minted at enrollment). No browsing history, no page content, no passwords are ever
  collected.
- **Purpose**: this data is used to protect the person's own household (showing a warning, or telling the
  household's owner about a scam in progress) and is not used for advertising, and not sold.
- Certify: **Does not sell or transfer user data to third parties** (true — Neo's own server is the household's own
  data controller, run by the household owner in a self-hosted deployment, or by the hosted service under
  `SECURITY.md`'s threat model) and **Does not use or transfer user data for purposes unrelated to the extension's
  single purpose**.

Screenshots: capture the popup (enrolled state), the options page (enrolled view), and the warning page (use the
`support-page.html` fixture) at 1280×800.

## AMO (Firefox Add-ons)

**Developer account:** free, at <https://addons.mozilla.org/developers/>.

**Data collection declaration:** AMO's submission form asks which categories of data the add-on collects, from a
fixed list (`browsingActivity`, `websiteContent`, `technicalAndInteraction`, …; see
[Firefox add-on data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)).
The manifest already declares this (`browser_specific_settings.gecko.data_collection_permissions`, `wxt.config.ts`):
required `browsingActivity` (the domains and page-behaviour signals described above). **Re-verify the exact key
names against AMO's current documentation before submitting** — they were current as of this writing but are a
Mozilla-controlled, occasionally-revised list; a mismatch between the manifest and what's selected in the AMO form
is a common rejection reason.

**Source code submission:** because the build step (`wxt build` via Vite/Rollup, plus TypeScript) transforms the
source, AMO requires the original source and a way to reproduce the exact reviewed build. Upload
`neo-extension-<version>-sources.zip` (produced by `pnpm --filter @neo/extension zip`, see [Release
steps](#release-steps)) alongside the `firefox.zip`, and in the reviewer notes include:

```
Build: Node 22, pnpm (see repo root package.json "packageManager").
From the repository root:
  pnpm install --frozen-lockfile
  pnpm --filter @neo/extension build -- -b firefox
Output: apps/extension/.output/firefox-mv3/
```

**Listing** reuses the same single-purpose description and screenshots as the Chrome listing.

## Draft listing copy

For review before either store listing goes live:

> **Neo — scam and lookalike-login protection**
>
> Neo warns you, right in your browser, about the fake tech-support pages that try to get you to call a number or
> install remote-access software, and about login pages pretending to be a bank, an email provider or another
> well-known site. It also tells your household if it finds one — the whole point is that the people you look after
> don't have to notice a scam themselves for someone to find out.
>
> Neo never reads your browsing history, page content, form contents or passwords. It only ever sends the domain of
> a page that looked like a scam, the name of a remote-access tool if one is installed from an unexpected site, and
> a link you explicitly ask it to check.
>
> Free and open source. Learn more at neoshield.dev.

## Manual test fixtures

`apps/extension/test/fixtures/` holds pages for checking a detector by hand with the unpacked extension loaded
(automated coverage is in `apps/extension/test/*.test.ts`, against the same underlying logic):

- `support-page.html` — a fake tech-support page (scam phrases, a fictional `555` phone number, fullscreen and
  history-trap behaviour). Should show the warning immediately.
- `game-page.html` — fullscreen and pointer-lock like a real browser game, no scam text. Should never warn.
- `support-article.html` — a legitimate help article mentioning a phone number. One text indicator alone; should
  never warn.
- `punycode-login.html` — a password-field page styled like a real login. The lookalike check itself needs an
  actual `xn--` host to serve it from (see the comment in the file); the automated test
  (`test/lookalike.test.ts`) covers the host-matching logic directly.
- `installer-link.html` — a download link named like a remote-access-tool installer, for checking the downloads
  notification (serve it over `http(s)`, not `file://`, so the referrer is a real page).

All phone numbers in fixtures are fictional `555` numbers, never a real number.
