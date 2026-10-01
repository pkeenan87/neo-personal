# Spec for desktop-agent-macos

branch: claude/feature/desktop-agent-macos
plan: `_plans/phase-3-household-devices.md` (delivery step 7)

## Summary

The Windows agent (step 6) ships for macOS. Most of it is shared:
- the pure detection crate (`agent-core`);
- the service's agent loop, pipe protocol, queue, updates and state;
- the Tauri tray app and its React UI;
- the server side.

This step adds:
- a `macos` platform module behind the same traits as `windows/`;
- a signed, notarized `.pkg` installer;
- one new detector: **an app newly granted Screen Recording, Accessibility or Full Disk Access** (`tcc_grant`). A scammer needs one of these on a Mac before remote control works. AnyDesk and TeamViewer both make the person click through exactly these grants while the scammer talks them through it.

**Full Disk Access is required for the new detector, not optional.**
- The plan said "Full Disk Access prompt only if needed". Research says every route to permission grants needs it:
  - reading the TCC database needs Full Disk Access even as root;
  - Endpoint Security needs it as well as an Apple-approved entitlement;
  - the unified log is undocumented and redacts the fields.
- The agent therefore runs in two modes:

  | Mode | Detects |
  |---|---|
  | **Without Full Disk Access** | Remote-access tools appearing (installed or run), verified incoming sessions, unwanted software: the Windows feature set |
  | **With Full Disk Access** | All of the above, plus `tcc_grant` |

- Granting it is a manual step in System Settings. The first-run window guides it, and the tray keeps offering it until it is done.

**Signing is a hard gate on macOS.**
- Gatekeeper blocks an unsigned or unnotarized app by default, with no "run anyway" path a relative will find.
- The Apple Developer Program is a prerequisite for anyone to run this at all, not only for releases.

## Decisions

- **Installer: a signed, notarized `.pkg`** (`pkgbuild` + `productbuild`), not `SMAppService`.
  - `SMAppService` ties the daemon to the app bundle, so dragging `Neo.app` to the Trash would orphan or kill it.
  - The pkg installs the daemon outside `/Applications` with a fixed path. It needs a **Developer ID Installer** certificate as well as **Developer ID Application**.
  - Tauri's macOS bundler makes `.app` and `.dmg` only. The release builds the `.app` with Tauri and wraps it.
- **The daemon is its own signed bundle:** `/Library/Application Support/Neo/Neo Protection.app`. The executable is `Contents/MacOS/neo-agent`, with a LaunchDaemon `/Library/LaunchDaemons/dev.neoshield.agent.plist`, running as root.
  - A named, signed bundle is what the person selects in the Full Disk Access list, and what macOS shows under Login Items as "Neo Protection".
  - Whether the grant attaches to the bundle's code identity is on the verify list below.
- **The tray app** is `/Applications/Neo.app`, the same Tauri app as Windows. It starts at login for every user through `/Library/LaunchAgents/dev.neoshield.tray.plist`. It is a menu-bar-only app (`ActivationPolicy::Accessory`).
- **Moving `Neo.app` to the Trash counts as an uninstall.**
  - macOS has no "Settings → Apps → Uninstall". The common way to remove an app is dragging it to the Trash, which would leave a daemon running with no visible UI.
  - The daemon checks every 60 seconds that `/Applications/Neo.app` exists with the expected signer. If it has been gone for 10 minutes, it:
    1. sends `DELETE /api/devices/self`, which raises the existing `high` `device_removed` alert;
    2. writes a removal note to its log;
    3. boots itself out (`launchctl bootout`) and removes its files.
  - The 10-minute grace covers an app update in progress or a move between folders.
  - The tray also has **Uninstall Neo…**. It asks for an administrator password, tells the owner, and removes everything. An `uninstall.sh` in the daemon bundle does the same from Terminal.
- **Permission grants present at enrollment are never sent.** Zoom, Teams and browsers commonly already hold Screen Recording. Only grants that appear **after** enrollment become events. A remote-access tool that already holds a grant is still reported, as a baseline `remote_access_tool` (step 6).
- **Endpoint Security is not used in v1.** Its TCC event (`ES_EVENT_TYPE_NOTIFY_TCC_MODIFY`, macOS 15.4+) would give the same signal. But the entitlement is reviewed by Apple and meant for security vendors, so it might be refused, and it still needs Full Disk Access. Polling the database gets the same transitions.
- **Minimum macOS 13 (Ventura)**, universal binary (arm64 and x86_64).
- **Token storage:** `/Library/Application Support/Neo/device.json`, owner root, mode `0600`, in a `0700` directory created and locked down **before** anything is written into it (the step 6 permissions lesson). The System keychain is an open question. There is no DPAPI equivalent for a root daemon that would add protection beyond file permissions, and anyone with root can read either.

## Functional requirements

### Reuse and layout

- **`agent-core`** (pure, tested on Linux) gains:
  - **`TccRow`:** `{ db: "system" | "user:<uid>", service, client, client_type, auth_value }`. A snapshot is a `Vec<TccRow>`.
  - **`detect_tcc(prev, current, lists, now)`** returns `tcc_grant` events for transitions from absent or not-allowed to allowed (`auth_value` 2) for `kTCCServiceScreenCapture` → `screen_recording`, `kTCCServiceAccessibility` → `accessibility` and `kTCCServiceSystemPolicyAllFiles` → `full_disk_access`. On the first snapshot after enrollment, nothing is sent; that snapshot becomes the baseline.
    - It ignores `last_modified`. Sequoia's periodic screen-recording re-approvals touch rows that were already allowed. It dedupes on `(client, service)`.
    - The event's `app` is the bundle's display name when known, otherwise the bundle id or the last path component. `bundleId` is set when `client_type` is a bundle id.
    - Grants to Neo's own bundles are ignored.
  - **macOS signature matching:**
    - `remoteAccessTools[].macos.bundleIds` and `teamIds` are matched against running processes and installed bundles.
    - Team ID is the signer check (the macOS equivalent of the Authenticode publisher).
    - A renamed copy of a tool is caught by Team ID, as on Windows.
  - **Path tokens:** `%Home%` (one path per local user) for macOS session evidence.
- **`agent-service`:** a `macos/` module mirroring `windows/`:

  | File | What it does |
  |---|---|
  | `probe.rs` | Processes (`libproc`: pid and executable path), installed apps (`.app` bundles under `/Applications` and `/Users/*/Applications`, plus running processes from `~/Downloads` and `/Volumes`), launchd plists in `/Library/LaunchAgents`, `/Library/LaunchDaemons` and `/Users/*/Library/LaunchAgents` |
  | `codesign.rs` | Team id and signing identifier through the Security framework (`SecStaticCodeCreateWithPath`, `SecCodeCopySigningInformation`), cached by path, size and mtime |
  | `tcc.rs` | Reads the system TCC database and each user's TCC database |
  | `socket.rs` | IPC (below) |
  | `notify.rs` | Warning fallback (below) |
  | `installer.rs` | Applying updates |
  | `daemon.rs` | launchd entry and SIGTERM handling |
  | `perms.rs` | The `0700` / `0600` data directory |

- **Tray app:** the same Tauri app, built for `universal-apple-darwin`. The macOS-only parts are:
  - the activation policy;
  - the Full Disk Access step;
  - **Uninstall Neo…**;
  - the pipe client becoming a Unix socket client.

### TCC reading

- **What is read:** the system database `/Library/Application Support/com.apple.TCC/TCC.db`, and each user's `~/Library/Application Support/com.apple.TCC/TCC.db`, every **30 seconds**.
- **How it is opened:** read-only with SQLite's `immutable=1` URI, because `tccd` holds the database open.
  - If that fails, the agent copies the file and its `-wal` to the data directory and reads the copy, then deletes it.
  - SQLite is bundled (`rusqlite` with `bundled`), so the system's libsqlite version does not matter.
- **Defensive parsing:**
  - The schema is private and changes between macOS versions. The query selects only `service`, `client`, `client_type` and `auth_value` from `access`.
  - An unknown shape (a missing table or column) disables TCC detection for this run, logs the macOS version once, and fails open.
  - Parser fixtures carry the macOS version they came from.
- **No Full Disk Access:** opening fails with `EPERM`. The agent reports `fullDiskAccess: false` in `status`, and TCC detection stays off. It re-probes every 5 minutes, and immediately when the tray asks after showing the settings link.

### Full Disk Access step

- **First-run window**, after enrollment:
  - A step titled "Let Neo check app permissions". It says plainly why: scammers make you allow screen recording or control of your Mac.
  - The person is guided:
    1. **Open System Settings** opens the Full Disk Access pane through its deep link (see "Verified before implementation").
    2. Turn on **Neo Protection**. If it is not listed, press **+** and choose `Neo Protection` (a Finder window opened by the tray shows it).
    3. The window checks for success by asking the daemon to probe, and shows "Done" when it can read the database.
  - **Skip for now** is allowed.
- **Tray when the grant is missing:**
  - The menu shows "App permission checks are off: turn on…".
  - It never nags with notifications. The tray icon itself does not change, because the person is still protected by the other detectors.
- **Copy:** says this is the only setting Neo asks for, and that the person can turn it off any time. "Open System Settings and allow this program" is also a scam script, so the window says that Neo will never ask for it on a phone call.

### IPC

- **Socket:** a Unix socket at `/var/run/neo-agent.sock`, mode `0666`, owned by root. On every connection the daemon checks the peer with `getpeereid`:
  - any local user is allowed, like INTERACTIVE on Windows;
  - there is no network exposure.
- **Protocol:** the step 6 pipe protocol, unchanged: newline JSON, ≤ 16 KB requests, push-only `subscribe` connections.
- **`status` gains:** `fullDiskAccess: boolean | null` (null on Windows) and `platform`.
- **New operation `probe_permissions`:** re-checks Full Disk Access now.

### Warnings

- **Normal path:** the tray shows toasts and the critical session window, exactly as on Windows.
- **No tray running, or nobody logged in at the console:** the daemon finds the console user (`SCDynamicStoreCopyConsoleUser`). It runs `launchctl asuser <uid> osascript -e 'display alert …'` with the same text and a single **OK** button. All text is passed as arguments, never interpolated into the script.
- **`tcc_grant` warnings:**
  - **To a listed remote-access tool:** the critical window: "**AnyDesk can now see and control this Mac.** If someone on the phone asked you to allow this, it is a scam. Hang up, then open System Settings → Privacy & Security and turn it off."
  - **To another app:** no local warning, and the event is sent. The server rule (step 4) gives `medium` for Screen Recording or Accessibility, which is feed-only at the default email threshold. Full Disk Access to an app that is not a remote-access tool is only recorded.
  - The server identifies a remote-access tool by `bundleId`, so the agent always sends `bundleId` when it knows it.
  - **To an expected tool on the device:** no window (heartbeat expected tools, as in step 6).

### Detection (macOS)

| What | How | Interval |
|---|---|---|
| Processes | `proc_listallpids` and `proc_pidpath`; for a new path, Team ID and signing id from the bundle on disk. App Translocation paths (`/private/var/folders/.../AppTranslocation/...`) are resolved to the bundle they run from | 5 s |
| Installed apps | `.app` bundles in `/Applications`, `/Users/*/Applications` (`Info.plist` `CFBundleIdentifier`, `CFBundleName`, `CFBundleShortVersionString`, Team ID) | 60 s |
| Launchd items | plists in `/Library/LaunchAgents`, `/Library/LaunchDaemons`, `/Users/*/Library/LaunchAgents` (label, program path) | 60 s |
| Session evidence | Per tool, from `macos.sessionEvidence`: log tails (shared cursor code), and `unifiedlog` entries read with `log show --last 1m --predicate <list predicate> --style ndjson` | 5 s (logs), 30 s (unified log) |
| TCC | as above | 30 s |

- **`remote_access_tool`:** a bundle or process matches by `bundleIds`, or by `teamIds` when the list has them. Install and run both count, and baseline follows step 6.
- **`unwanted_software`:** the Team ID or the bundle's signer name is on the PUP list (`publisher_list`).
  - `unsigned_unknown` applies to a **new** app bundle without a valid Developer ID signature. Its main executable's SHA-256 is sent; the server checks it with VirusTotal and fails open.
  - Apps from the App Store (signed by Apple) are never `unsigned_unknown`.
- **`remote_access_session`:** verified evidence only, with the peer ID when the evidence carries one.

### Lists (`@neo/tools` data and contract change)

- **New `macos` fields:** `remoteAccessTools[].macos` gains `sessionEvidence: SessionEvidence[]`. `SessionEvidence` gains a kind `{ kind: "unifiedlog", predicate, pattern, verified, checked? }`.
  - `predicate` is limited to the form `process == "<name>"` or `subsystem == "<name>"`, so a list update cannot inject an arbitrary `log` predicate.
  - `pattern` follows the shared regex subset.
- **New tool:** `apple_screen_sharing` ("Apple Screen Sharing / Remote Management").
  - It has no `vendorDomains` and no installer patterns. Its only `macos` signal is session evidence, a unified-log candidate on `screensharingd` "Authentication: SUCCEEDED".
  - It never produces `remote_access_tool`, because the tool is built in.
- **Candidates**, all `verified: false` until checked on a real Mac:
  - AnyDesk: logs `%Home%/.anydesk/connection_trace.txt` and `/Library/Application Support/AnyDesk/connection_trace.txt`.
  - TeamViewer: `%Home%/Library/Logs/TeamViewer/` and `/Library/Logs/TeamViewer/` connection logs.
  - RustDesk: `%Home%/Library/Logs/RustDesk/`.
  - `apple_screen_sharing`: as above.
- **Bundle IDs and Team IDs:**

  | Tool | Value | Status |
  |---|---|---|
  | TeamViewer | Team ID `H7UGFBUGV6` | confirmed by a secondary source |
  | TeamViewer | bundle id `com.teamviewer.TeamViewer` | confirmed by a secondary source |
  | AnyDesk | bundle id `com.philandro.anydesk` | unconfirmed |
  | RustDesk | bundle id `com.carriez.rustdesk` | unconfirmed |
  | ScreenConnect | bundle id `com.screenconnect.client` | unconfirmed |

  Every other Team ID is filled in by the verification task from `codesign -dv --verbose=4` on a real install. An unconfirmed value ships only when the verification task confirms it.

### Installer, updates, uninstall

- **What `Neo.pkg` installs:**
  - `/Applications/Neo.app`;
  - `/Library/Application Support/Neo/Neo Protection.app`;
  - the two launchd plists.
- **Package scripts:**
  - `preinstall` boots out a running daemon (`launchctl bootout system/dev.neoshield.agent`), so an upgrade can replace the binary.
  - `postinstall`:
    1. creates and locks down the data directory before anything else;
    2. bootstraps the daemon (`launchctl bootstrap system …`);
    3. bootstraps the tray agent for the logged-in console user;
    4. opens `Neo.app`.
- **Enrollment** happens in the tray's first-run window after install, exactly as on Windows (code or sign-in), then the Full Disk Access step.
- **Updates:**
  - The daemon reads the Tauri-format `latest.json` with platform key `darwin-universal`.
  - It verifies the minisign signature, then checks `pkgutil --check-signature <pkg>`: it must be signed by Developer ID Installer with the **same Team ID** as the running daemon's own signature. It then runs `installer -pkg <pkg> -target /`.
  - The staging directory is inside the root-only data directory.
  - CI builds accept an unsigned pkg only with the compile-time `NEO_ALLOW_UNSIGNED_UPDATE`, as on Windows.
- **Uninstall:**
  - The tray's **Uninstall Neo…** runs `uninstall.sh` with administrator rights (`osascript … with administrator privileges`).
  - `uninstall.sh` (also usable from Terminal) runs `neo-agent --unenroll` (`DELETE /api/devices/self`), boots out and removes both launchd items, removes both bundles and the data directory, and runs `pkgutil --forget dev.neoshield.pkg`.
  - Moving the app to the Trash is detected as above.

### Signing, notarization, release

- **Release workflow** `desktop-release-macos.yml`, on the same `desktop-v*` tags:
  1. builds the universal `.app` (Tauri, `--target universal-apple-darwin`) and the daemon (`cargo build` for both architectures, then `lipo`);
  2. signs both with **Developer ID Application**, hardened runtime and timestamp;
  3. builds the pkg and signs it with **Developer ID Installer**;
  4. notarizes with `notarytool` (App Store Connect API key) and staples;
  5. writes the `darwin-universal` entry into `latest.json`.
- **Certificates:** imported into a temporary keychain. Secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_INSTALLER_CERTIFICATE`, `APPLE_INSTALLER_CERTIFICATE_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`; variable `APPLE_TEAM_ID`.
- **Missing configuration fails the release.** Nothing ships unsigned.
- **`latest.json`:** one shared `desktop-latest` manifest carries both `windows-x86_64` and `darwin-universal`. Whichever release job runs second merges its entry in.

### CI

- **Job `desktop-macos`** (`macos-15`): always runs, and exits early when nothing relevant changed, the same as `desktop-windows`. It is added to the aggregator.
  - Note: GitHub's macOS minutes cost about 10 times Linux minutes, and the job still boots a Mac runner on every PR to decide whether to skip.
  - It runs clippy and tests for the workspace on macOS.
  - It builds an unsigned universal pkg and installs it with `sudo installer`, then checks:
    - `launchctl print system/dev.neoshield.agent` shows it running as root;
    - the socket answers `status`;
    - the data directory is `0700` root;
    - it enrolls against the fake server, and the token file is `0600` root;
    - the bad-signature update is refused, and the good update is applied with enrollment kept;
    - deleting `/Applications/Neo.app` is treated as an uninstall: one `DELETE /api/devices/self`, and the daemon is gone. The grace period is a build-time value, so a CI build can shorten it.
    - `uninstall.sh` removes everything when run on a fresh install.
  - **TCC:** a probe step tries `sudo sqlite3` on the system TCC database and records whether it is readable on the runner. If it is, CI saves its schema as a fixture.
  - The `tcc` parser is tested on fixtures in every case.
- **Linux job:** gains the `agent-core` TCC tests.

### Server and web

- **Already in place:** the `tcc_grant` rules (step 4) and expected tools.
- **Additions:**
  - the `macos.sessionEvidence` and `unifiedlog` list types, data, tests and contract;
  - the `apple_screen_sharing` tool;
  - **Add a device** gains a Mac link from `NEXT_PUBLIC_MAC_AGENT_URL` (optional; unset shows "coming soon");
  - the privacy page adds: "On a Mac, with your permission (Full Disk Access), Neo also checks which apps were newly allowed to record your screen, control your Mac or read all your files. It sends only the app's name and which permission changed."

### Docs

`docs/desktop-agent.md` gains a macOS section:
- architecture;
- the two modes;
- the Full Disk Access step;
- installing, uninstalling and the Trash rule;
- developing on Linux (`simulate` with TCC scenarios);
- the macOS verification checklist (Team IDs, bundle IDs, log paths, unified-log messages, the Full Disk Access deep link);
- release and notarization;
- the Apple Developer Program.

## Possible Edge Cases

- **The person never grants Full Disk Access.** Everything except `tcc_grant` still works, and the tray keeps a quiet menu item.
- **A scammer has the person grant Accessibility to AnyDesk while connected.**
  - If AnyDesk was already detected, the session is already `critical` (when its evidence is verified).
  - The grant is a second `critical` event for the same tool. Its dedupe key includes the detector, so both are sent.
- **Sequoia monthly re-approval.** Same `(client, service)` and already allowed, so no event.
- **A grant is revoked, then granted again.** The second grant is a transition, so an event is sent again (the dedupe window is the server's hour).
- **The TCC schema changes in a macOS update.** The query fails, detection turns off and the macOS version is logged. Other detectors are unaffected, and the verification task updates the fixture.
- **App Translocation.** A quarantined app runs from a random path. It is resolved to its original bundle for matching, and Team ID still matches.
- **A tool is run from a mounted DMG** (`/Volumes/AnyDesk/AnyDesk.app`). It is caught by the process match.
- **The app is dragged to the Trash, then put back within 10 minutes.** Nothing happens.
- **Two people use the Mac.** Each user's TCC database is read. Events are attributed to the device's member (step 6 decision).
- **Root or an administrator stops the daemon.** The offline alert follows after 48 hours, as on Windows.
- **Neo's own grants** (the daemon's Full Disk Access). Ignored by bundle id.

## Acceptance Criteria

- [ ] `agent-core` TCC diff tests pass on Linux:
  - a baseline is never sent;
  - a transition is sent;
  - re-approval is ignored;
  - revoke and re-grant sends again;
  - unknown services are ignored;
  - Neo's own grants are ignored.
- [ ] The TCC reader parses fixture databases for each recorded macOS version, and fails open on a fixture with a changed schema.
- [ ] The `desktop-macos` CI job passes:
  - the unsigned universal pkg installs;
  - the daemon runs as root and answers on the socket;
  - the data directory is `0700` and the token file `0600`;
  - enrollment works against the fake server;
  - a bad-signature update is refused and a good one applied with enrollment kept;
  - moving the app to the Trash unenrolls and removes the daemon;
  - `uninstall.sh` removes everything.
- [ ] `simulate` against MOCK_MODE raises:
  - [ ] `critical` for Accessibility granted to AnyDesk;
  - [ ] `medium` for Screen Recording granted to an unknown app;
  - [ ] nothing for a baseline grant.
- [ ] Only `verified: true` macOS session evidence ships, and `unifiedlog` predicates pass the restricted-form test.
- [ ] Contracts, privacy page, `.env.example`, the Add-a-device link and `docs/desktop-agent.md` are updated.

## Verified before implementation (2026-10-01)

- **Full Disk Access attaches to a signed `.app` bundle.**
  - The Full Disk Access UI refuses a bare daemon executable. Apple DTS's supported layout for an unmanaged Mac is a daemon inside its own app bundle, which the person adds with **+** (developer forums thread 804548).
  - `Neo Protection.app`, with its own `CFBundleIdentifier` (`dev.neoshield.agent`), is that layout. The grant is keyed by bundle id (`client_type` 0) and code requirement.
  - A grant becomes visible on the next process launch. After the tray's "Done" probe fails once, the daemon exits so that launchd relaunches it (`KeepAlive`), then probes again.
  - No API tells a daemon whether it has Full Disk Access. Probing `TCC.db` for `EPERM` is the method.
- **Deep link:** `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles` on macOS 13+, falling back to `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`. macOS 26 is unconfirmed until it is tried on a real Mac.
- **A GitHub `macos-15` runner (15.7.9) can read both TCC databases under `sudo`,** including `file:…?mode=ro&immutable=1`.
  - The `access` schema columns are: `service`, `client`, `client_type`, `auth_value`, `auth_reason`, `auth_version`, `csreq`, `policy_id`, `indirect_object_identifier_type`, `indirect_object_identifier`, `indirect_object_code_identity`, `flags`, `last_modified`, `pid`, `pid_version`, `boot_uuid`, `last_reminded`. Primary key: `(service, client, client_type, indirect_object_identifier)`.
  - The system and user databases have the same schema. Accessibility, ScreenCapture and SystemPolicyAllFiles rows are in the system database.
  - The CI job therefore runs the real reader against the runner's database. The fixture schema is recorded as `15.7.9`.
- **`pkgutil --check-signature`:**
  - A signed pkg prints `Status: signed by a developer certificate issued by Apple for distribution`, `Notarization: trusted by the Apple notary service`, and certificate 1 as `Developer ID Installer: <Name> (<TEAMID>)`. The Team ID is parsed from that line, and the notarization line is required.
  - An unsigned pkg prints `Status: no signature` and exits 1.
- **Signer format:** `codesign` reports `TeamIdentifier=<id>` and `Authority=Developer ID Application: <Name> (<TEAMID>)`. The Security framework returns the same Team ID.
- **Unified log:** `log show --style ndjson` works. With no entries it prints `{"count":0,"finished":1}`.
- **Rust:** the runner's toolchain has only `aarch64-apple-darwin`. The universal build adds `x86_64-apple-darwin` with `rustup target add`.

## Open Questions

- **Apple Developer Program** (about $99 a year; individuals can enrol, to confirm on Apple's page). It is required before anyone can install the Mac app. This is the owner's account and decision.
- **A real Mac for verification.** Neither the owner's machine nor the dev environment is a Mac. The options are a borrowed Mac, a cloud Mac (MacStadium, AWS EC2 Mac), or GitHub runners for what can be scripted. Session detection, Team IDs and the Full Disk Access flow all need it.
- **Endpoint Security entitlement.** Request it later as a more robust TCC signal (macOS 15.4+), or never.
- **System keychain for the token** instead of a root-only file.

## Testing Guidelines

Create test files in the `./test` folders (Rust: `tests/` and unit tests) for the new feature, with meaningful tests for the following cases, without going too heavy:

- `apps/desktop/crates/agent-core/tests/tcc.rs`: the diff cases in the acceptance criteria; event shape against the step 4 schema.
- `apps/desktop/crates/agent-service`:
  - the TCC reader against SQLite fixtures (built in the test with the recorded schemas), including a changed schema and `EPERM` mapped to "no Full Disk Access";
  - the Trash-detection timer;
  - `getpeereid` validation, behind a trait;
  - the update signer policy with Team IDs.
- `apps/desktop` (Vitest): the Full Disk Access step states; the Uninstall confirmation copy.
- `packages/tools/test/lists.test.ts`:
  - the `unifiedlog` predicate form;
  - `%Home%` tokens;
  - `apple_screen_sharing` has no installer patterns.
- `apps/web/test/household-settings.test.tsx`: the Mac download link versus "coming soon".
