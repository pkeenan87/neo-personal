# Spec for desktop-agent (Windows)

branch: claude/feature/desktop-agent
plan: `_plans/phase-3-household-devices.md` (delivery step 6)

## Summary

The people most exposed to remote-access scams are on Windows. A scammer calls, has the victim install AnyDesk or
open Quick Assist, then connects. This step ships a Windows agent that notices that and tells two people:

- the person at the keyboard, at once and in plain words;
- the household owner, by email, within a minute.

The agent is one installable app in `apps/desktop`, built with **Tauri v2 (Rust)**. It has two processes:

- **`neo-agent`**, a Windows service running as LocalSystem. It holds the device token and runs detection,
  heartbeat, the event queue and updates. It runs whether or not anyone is signed in.
- **Neo** (the Tauri app), a per-user tray app. It handles enrollment, status, notifications, the critical warning
  window and "Check a link". It never holds the token.

It detects three things and reports them as step 4 events:
- remote-access tools appearing (installed **or** run portable);
- incoming remote sessions;
- unwanted software.

It sends only those events, never an inventory. The server side (rules, alerts, expected tools, lists) already
exists. This step adds a little list data, a `discovery` flag and a download link.

macOS is step 7 and reuses the Tauri app and the pure detection crate. Screen Recording and Accessibility grant
(TCC) detection belongs there.

### Why Rust and Tauri, not Go

Go is a reasonable language for a Windows service: `golang.org/x/sys/windows/svc` is mature, and Go builds fast.
It loses here for these reasons:

- **False positives.** Go binaries draw more heuristic antivirus flags than most: they are statically linked and
  large, and a lot of commodity malware is now written in Go. The plan names "our own agent flagged as malware" as
  a top risk.
- **App plumbing.** Tauri brings the tray, notifications, a webview UI (shared React with the extension), the
  MSI/NSIS bundler, a signed updater format and the macOS notarization path for step 7. Go brings none of these.
  We would add a systray library, a separate UI, a self-updater and hand-written WiX.
- **One stack.** A Go service next to a Tauri tray would mean two toolchains, two signed binaries, two update
  paths and twice the antivirus surface.

Rust has Microsoft's official `windows` crate (WinTrust, Event Log, registry, ToolHelp) and `windows-service`
(0.8, maintained by Mullvad) for the service itself. The cost is slower iteration and Rust's learning curve.

## Functional requirements

### Repo layout and CI

- **`apps/desktop/`**: a Tauri v2 app.
  - The React frontend is a pnpm workspace package, `@neo/desktop`, with `typecheck`, `lint`, `test` and `build`
    scripts for the UI only. The existing Ubuntu `checks` job keeps passing with no Rust or Windows toolchain.
  - `src-tauri/` is the tray app crate.
- **`apps/desktop/crates/agent-core`**: a pure Rust crate that builds and tests on Linux. It covers:
  - list parsing;
  - matching (processes, uninstall entries, services, session evidence);
  - the event builder;
  - the "seen" state;
  - the queue, dedupe and backoff;
  - the API client against the HTTP contracts.

  It works from snapshot inputs: process lists, registry dumps, log excerpts and service lists as JSON fixtures
  under `crates/agent-core/tests/fixtures/`.
- **`apps/desktop/crates/agent-service`**: the Windows service (`windows-service`, `windows` crate). The
  Windows-only code sits behind `cfg(windows)`. It turns the OS into snapshots for `agent-core`, and handles the
  named pipe, DPAPI and updates.
- **CI:**
  - Job `desktop-core` (ubuntu) runs `cargo fmt --check`, `clippy -D warnings` and `cargo test` for `agent-core`.
  - Job `desktop-windows` (`windows-2025`) builds the unsigned MSI, installs it, checks that the service runs and
    answers on the pipe, then uninstalls it and checks the service is gone.
  - `desktop-windows` also runs the **service-driven update path**: it installs build N, has the service apply a
    locally served, test-key-signed build N+1, and checks that the service restarts on the new version with its
    enrollment kept. The service spawning `msiexec`, which then stops the service that spawned it, is the riskiest
    step.
  - Both jobs **always run** and exit early with success when nothing under `apps/desktop/**`,
    `packages/tools/src/data/**` or the workflow changed (`git diff` against the merge base). The `All checks
    passed` aggregator requires `success` and treats `skipped` as failure, so it gains both jobs.
  - Actions are SHA-pinned with version comments.
- **Release:** `.github/workflows/desktop-release.yml` runs on tags `desktop-v*`. It builds and signs (see Signing)
  the MSI and the update manifest and attaches them to a GitHub release.
- **Nobody can run this locally.** Development happens on Linux. The `desktop-windows` job is the only real Windows
  execution until the owner sets up a Windows VM. That is why the detection logic lives in the pure crate with
  fixtures.

### Installation

- **Format:**
  - A per-machine **MSI** (WiX via the Tauri bundler, `installMode: perMachine`).
  - A WiX fragment (`bundle.windows.wix.fragmentPaths`) declares `ServiceInstall` / `ServiceControl` for
    `neo-agent.exe`, shipped as a Tauri `externalBin`: automatic start, LocalSystem, restart on failure.
  - MSI was chosen over NSIS hooks because Windows Installer already stops, replaces and starts services correctly
    on upgrade and uninstall.
- **Paths:**
  - Programs: `C:\Program Files\Neo\`.
  - Data: `C:\ProgramData\Neo\`, ACL SYSTEM + Administrators full; Users have no access.
  - Logs: `C:\ProgramData\Neo\logs\` (rotated, 7 days). Logs record event types and tool ids, never paths from
    user folders.
- **Tray start:** the tray app starts at login for every user (HKLM `Run`).
- **Signing:** every shipped binary and the MSI are Authenticode-signed (see Signing).

### Enrollment

- **First-run window** (the tray app opens it after install while the device is not enrolled):
  - **"I have a code from my family"**: preview, then consent, then enroll.
    - The pipe passes the code to the service, which calls `POST /api/devices/enroll/preview` and then
      `/api/devices/enroll` with `kind: "desktop_agent"`, `platform: "windows"`, `name` (default
      "<Windows computer name>", editable) and `clientVersion`.
    - Consent copy: "This computer will warn you about remote-access scams and tell **<owner>** (household
      **<household>**) when it finds one. Neo never sends the list of your programs, your files or your browsing."
  - **"Sign in with my Neo account"**: the device flow with `device: { kind, platform, name, clientVersion }`,
    started by the service. The verification URL opens in the user's default browser.
- **Advanced server URL:** for self-hosters, before enrollment only. The default comes from the build
  (`https://www.neoshield.dev`).
- **Token storage:** `C:\ProgramData\Neo\device.bin`, encrypted with DPAPI at machine scope, ACL SYSTEM +
  Administrators.
  - The tray app never sees the token.
  - An administrator can read it. It only carries the monitoring scopes, so it can only report about this device's
    member.
- **Installing at a distance.** "Download this and install it" is the scam script itself. `docs/desktop-agent.md`
  and the Add-a-device instructions tell the owner to install in person, or over a remote-access tool already
  marked expected. They should never ask a relative over the phone to download it.

### IPC (named pipe `\\.\pipe\neo-agent`)

- **Access:** the DACL gives SYSTEM full access and INTERACTIVE read/write. Remote clients are refused
  (`PIPE_REJECT_REMOTE_CLIENTS`).
- **Protocol:**
  - Newline-delimited JSON, with each request at most 16 KB.
  - The service validates every request as if it were attacker-controlled: any local process can connect.
- **Requests:** `status`, `enroll_preview { code }`, `enroll { code, name }`, `self_enroll_start { name }`,
  `self_enroll_poll`, `check_url { url }` (calls `POST /api/devices/check-url`), `unenroll` and `subscribe`.
- **Pushes to subscribers:** `warning { eventId, kind, toolName, peerId?, severity, ownerName, ownerTold }` and
  `status_changed`.
- **Unenroll** is allowed to any interactive user, matching "Stop protecting" in the extension. The tray asks for
  confirmation ("<owner> will be told"). The service calls `DELETE /api/devices/self`, which raises the existing
  `high` `device_removed` alert.

### Detection (agent-core matching on service snapshots)

The service polls the system and hands snapshots to `agent-core`, which compares them with `seen.json` (below) and
returns events. Events go out only when a list matches something new.

| Source | How | Interval |
|---|---|---|
| Processes | ToolHelp32 snapshot of image name and path. For a new image path, the Authenticode signer subject, cached by path, size and modified time (see "Signature checks") | 5 s |
| Installed programs | Uninstall keys: HKLM 64- and 32-bit views, and HKU for each loaded profile (`DisplayName`, `Publisher`, `DisplayVersion`, `InstallLocation`, `DisplayIcon`) | 60 s |
| Services | SCM enumeration (name, display name, binary path) | 60 s |
| Session evidence | Per tool, from `sessionEvidence` (below): tail log files from the last offset, read event-log channels with `EvtQuery` since a bookmark, and check processes from the process snapshot | 5 s (logs and processes), 30 s (event logs) |

**Signature checks.**
- `WinVerifyTrust` runs with no online revocation check (`WTD_REVOCATION_CHECK_NONE`, cache-only URL retrieval). It
  runs on every new image path seen by a 5-second poll, so it must not make a network call per binary.
- The signer subject comes from the WinTrust provider data (`WTHelperProvDataFromStateData` →
  `WTHelperGetProvSignerFromChain` → `CertGetNameStringW`).
- If the `windows` crate does not expose those helpers, the fallback is `CryptQueryObject` + `CryptMsgGetParam` +
  `CertFindCertificateInStore` on the embedded signature.

**`remote_access_tool`** (`software`):

- **Match:** a tool from `remoteAccessTools` appears through any of:
  - an uninstall entry: `displayNamePatterns`, confirmed by `publishers` when the list has publishers;
  - a service: `serviceNames`;
  - a **running process**: `processNames`, confirmed by the Authenticode signer matching `publishers` when the
    list has publishers.
- **Why processes matter:** portable AnyDesk run from Downloads never writes an uninstall key, and that is the
  common scam path.
- **Sending:** one event per tool. It is sent again only after the tool has been absent for 7 days. The event
  carries `toolId`, `name`, `publisher?` and `version?`.

**`remote_access_session`** (`remote_session`, `direction: "incoming"`):

- **When:** only when the tool's verified `sessionEvidence` fires. "AnyDesk.exe is running" alone is **not** a
  session (fail open).
- **Peer ID:** `peerId` is set when the evidence carries one, after cleaning to the step 4 charset. Without it,
  the expected-tools rule gives `high`, not `low`.
- **Dedupe:** one event per (tool, peer) per 30 minutes.
- **Outgoing sessions** are not reported (the server only records them).

**`unwanted_software`** (`software`):

- **`publisher_list`:** a new uninstall entry whose `Publisher` matches `pupPublishers`.
- **`hash_list`:** the program's main executable, from `DisplayIcon` (else the first `.exe` in `InstallLocation`),
  has a SHA-256 on the list.
- **`unsigned_unknown`:** that executable is unsigned or has an untrusted signature. The event carries its
  SHA-256; the server checks VirusTotal by hash, with no upload, and fails open.
- **Local cap:** 20 `unsigned_unknown` events per day.
- **Never examined:** files are never hashed outside a new program's own install location, and user documents are
  never touched.

**Not in this step:**
- `tcc_grant` (macOS, step 7);
- MsiInstaller event-log parsing (uninstall-key polling covers it);
- ETW or WMI process tracing (5-second polling is enough for a human-speed scam);
- browser detection (the extension's job).

### Session evidence in the lists (`@neo/tools` data and contract change)

- **New field:** `remote-access-tools.json` gains `windows.sessionEvidence: SessionEvidence[]`:
  - `{ kind: "log", path, pattern, verified }`:
    - `path` may contain `%ProgramData%`, `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%AppData%`. The service
      expands `%AppData%` for every profile.
    - `pattern` is a regex with a named group `peer` for the peer ID when there is one.
  - `{ kind: "eventlog", channel, eventIds, verified }`.
  - `{ kind: "process", name, verified }`: a process that exists only during a session.
- **What ships:** only `verified: true` entries. Unverified candidates stay in the file so the verification task
  can work through them.
- **Candidates from public forensic write-ups** (all `verified: false` until checked on a VM with the current
  vendor build):
  - **AnyDesk:** `connection_trace.txt` in `%ProgramData%\AnyDesk\` and `%AppData%\AnyDesk\` (portable). Each
    incoming line carries the peer ID.
  - **TeamViewer:** `Connections_incoming.txt` in the program folder. It is tab-separated and starts with the peer
    ID.
  - **UltraViewer:** `%AppData%\UltraViewer\Connection_IN_Log.txt`, which carries the partner ID.
  - **Splashtop:** the event-log channel `Splashtop-Splashtop Streamer-Remote Session/Operational`; no numeric
    peer ID is confirmed.
  - **ScreenConnect:** the process `ScreenConnect.WindowsClient.exe` during a session; no peer ID.
  - **Supremo:** `%ProgramData%\SupremoRemoteDesktop\Log\Supremo.00.Incoming.log`; format unconfirmed.
  - **Quick Assist:** no reliable session log is known. A `QuickAssist.exe` process on the sharing side is a
    candidate, to be checked on the VM against "opened but not connected".
  - **RustDesk, LogMeIn, NetSupport, AeroAdmin, Atera:** none known. They ship with install and run detection
    only.
- **Regex subset:** `installerPatterns`, `displayNamePatterns` and `pattern` are JavaScript regex strings that the
  extension (JS) and the agent (Rust `regex`) both compile. A new `@neo/tools` test pins them to the shared subset:
  no lookaround, no backreferences, named groups only in the `(?<name>…)` form, no flags.
- **The data is a prerequisite.** Several tools still lack data:
  - UltraViewer, RustDesk and AeroAdmin have no Windows publishers.
  - ScreenConnect has no service or process names.
  - Every session candidate is unverified.

  **A list-verification task on a Windows VM** fills these in from real installs before the detectors are
  trusted. It is separate from writing the agent, and every value comes from a real install, not from memory. The
  checklist and method are in `docs/desktop-agent.md`. Each record notes the vendor version and date it was
  checked.

### Baseline at enrollment (server change)

Tools already present when the device enrolls **are** reported, so the owner learns that grandma already has
TeamViewer and can mark it expected. Reporting them as new would send "TeamViewer was installed" (`high`) minutes
after enrollment, which is wrong and alarming.

- **Schema:** `remote_access_tool` and `unwanted_software` gain an optional `discovery: "baseline" | "new"`
  (default `"new"`) in `SignalEventSchema`. The schema stays strict.
- **Rules:**
  - A baseline `remote_access_tool` is `medium`, or `low` when the tool is expected on the device.
  - A baseline `unwanted_software` is sent only for `publisher_list` and `hash_list` matches. `unsigned_unknown` is
    never baseline: the agent hashes only programs that appear **after** enrollment, so the first scan does not
    send a batch of fingerprints.
  - Baseline events are excluded from `scam_in_progress` correlation (`apply.ts` / `findScamInProgress`). A tool
    that was already installed is not evidence of a call happening now.
- **Template:** a baseline `remote_access_tool` reads "<device>: <tool> is installed".
- **Agent:** the first full scan after enrollment marks everything it finds as baseline and records it in
  `seen.json`. Later appearances are `new`.

### Local state (`C:\ProgramData\Neo\`, never sent)

- **`seen.json`:** the tool ids and program entries already reported, with first-seen and last-seen times, used to
  tell new from known. It holds names only, never other programs' paths. It is pruned after 30 days of absence.
- **`queue.json`:** at most 200 events. Events are dropped after 23 hours (the server rejects them as `stale` at
  24) and retried with exponential backoff, honouring `Retry-After`.
- **`cursors.json`:** log offsets and event-log bookmarks.
- **`lists.json`:** cached lists and the ETag.

This is local working state, not an inventory leaving the device. The privacy page says so.

### Warning the member

- **Toasts** (`tauri-plugin-notification`; Windows shows them only for installed apps):
  - **Tool appeared:** "AnyDesk is on this computer. If someone on the phone asked you to install it, it is a
    scam. Hang up."
  - **Unwanted software:** "Neo found <name>, which is known unwanted software."
- **Critical incoming session:** a **topmost Neo window** that does not steal keyboard focus. It is plain and in
  large type:
  > "**Someone is connected to this computer with AnyDesk.** If someone called you and asked for this, it is a scam.
  > Hang up the phone and restart your computer. Do not log in to your bank."
  - It adds "Neo let **<owner>** know" when `ownerTold` is true.
  - It has one button, **I understand**. No action is taken on the session; ending sessions is out of scope in the
    plan.
- **No tray running** (nobody signed in, or the tray app was closed): the service falls back to `WTSSendMessageW`,
  which shows a message box in the active console session with the same text.
- **When to warn:**
  - On the local evidence itself, without waiting for the server. Install and session evidence are deterministic
    and the rules are the same.
  - **Expected tools come from the heartbeat.** The heartbeat's `device.expectedTools` (server change below) is
    cached locally. The service refreshes it on every heartbeat and right after any ingest result with
    `severity: "low"`.
  - **No session window** for a tool expected on the device with the event's peer in its expected peers. A server
    hiccup while the owner is helping therefore never shows grandma "this is a scam".
  - **No tool-appeared toast** for a `baseline` event, or for a tool expected on the device.

### Heartbeat, lists, update, uninstall

- **Heartbeat:** the service sends `POST /api/devices/heartbeat` on start and hourly, and refetches lists when
  `listsVersion` changes. A 401 means the device was removed or the member left. The service stops detecting,
  clears the token, and the tray shows "This computer is no longer connected to a household".
- **Lists:** `GET /api/signals/lists` with `If-None-Match`. A snapshot is built into the binary as the first-run
  and offline fallback.
- **Updates (service-driven, so no UAC prompt for the member):**
  - The service checks a Tauri-format update manifest daily: `latest.json` on the GitHub release (`version`,
    `platforms.windows-x86_64.{url, signature}`).
  - It verifies the minisign signature against the public key compiled into the binary (crate `minisign-verify`)
    **and** the MSI's Authenticode signer. It then runs `msiexec /i <msi> /qn` as SYSTEM.
  - Windows Installer stops, replaces and starts the service.
  - The update URL is overridable at build time (`NEO_DESKTOP_UPDATE_URL`) for self-hosters.
- **Uninstall (Settings → Apps):**
  - The MSI runs `neo-agent.exe --unenroll` as a deferred custom action, condition `REMOVE="ALL" AND NOT
    UPGRADINGPRODUCTCODE`. It calls `DELETE /api/devices/self`, which raises the `high` `device_removed` alert
    ("… was uninstalled"). Upgrades never unenroll.
  - The `/uninstalled` page is a browser-extension mechanism and is not used here.
- **Tampering:**
  - A local administrator (or a scammer with admin through a remote session) can stop or disable the service. Neo
    does not try to prevent that.
  - The owner learns through the 48-hour offline alert. A clean uninstall alerts at once.
  - Blocking, self-protection and killing processes are out of scope in the plan.

### Tray app

- **Menu:**
  - Status: "Protecting **<member>**'s computer for **<household>**" and the last check-in.
  - **Check a link…** (a small window that calls `check_url`, showing the same ratings as the extension popup).
  - **Open Neo** (the web app).
  - **About and privacy**.
  - **Stop protecting this computer**.
- **Icon states:** shield; grey (not enrolled or disconnected); red dot (a warning in the last hour).
- **UI code:** React, sharing components and copy with the extension where practical.

### Signing and antivirus

- **Authenticode:** every release binary and the MSI are signed in the release workflow. There are two candidate
  services:
  - **Azure Artifact Signing** (formerly Trusted Signing). The Basic tier is about $9.99 a month. Individual
    developers in the US and Canada are eligible; identity validation takes a few business days. It is used through
    `Azure/artifact-signing-action` on a Windows runner.
  - **SignPath Foundation**: free code signing for open-source projects, subject to their approval.
- **SmartScreen:** neither service gives instant SmartScreen reputation. EV certificates no longer do either (since
  2024). Reputation builds with a consistent publisher identity, so early users will see a SmartScreen prompt.
  `docs/desktop-agent.md` says so.
- **Antivirus submissions before each public release:**
  - Microsoft Security Intelligence (`https://aka.ms/wdsi`, as a software developer);
  - then the Avast/AVG whitelisting program, ESET, Kaspersky and Malwarebytes. URLs are re-checked at release
    time.
  - Each submission is logged in `docs/desktop-agent.md`.
- **Plain presence:** the service display name is "Neo Protection" with a description, and the tray icon is always
  present while enrolled. The installer has a "What Neo does" page. Hidden or obfuscated behaviour is avoided, since
  that is what heuristics punish.

### Server and web changes (contracts first)

- **`@neo/verdict`:** `discovery` on `remote_access_tool` and `unwanted_software`.
- **`@neo/tools`:**
  - `windows.sessionEvidence` in the type, the JSON and `detectionLists()`;
  - the regex-subset test;
  - list data filled in by the verification task.
- **`apps/web`:**
  - the baseline rule and template, and baseline events left out of correlation;
  - **alert dedupe for device signals** becomes `<kind>:<deviceId>:<detector>:<subject>:<UTC hour>`. Today a
    `remote_access_tool` install and a `remote_access_session` for the same tool share
    `remote_access:<deviceId>:<toolId>:<hour>`. In the headline scenario (install AnyDesk, connect three minutes
    later) the `critical` session alert would be dropped as a duplicate of the `high` install alert. The change
    is amended in `_specs/signals.md` and `docs/contracts.md`;
  - **the heartbeat's `device`** carries the device's real `expectedTools`. It currently returns an empty list;
  - the expected-tools hint in `DevicesSection` adds: "Quick Assist never shows who connected, so Neo still alerts
    you about every Quick Assist session."
  - **Add a device** gains a Windows download link from `NEXT_PUBLIC_WINDOWS_AGENT_URL` (optional, in
    `.env.example`; unset shows "coming soon"), with the install-in-person advice;
  - the privacy page: "The Windows app checks programs and remote-access tools on the computer. It sends Neo only
    the name of a remote-access tool or flagged program when one appears, a remote peer ID during an incoming
    session, and the fingerprint (SHA-256) of an unsigned new program so it can be checked. It never sends your
    list of programs, files or browsing."
- **`docs/desktop-agent.md`:**
  - architecture;
  - development on Linux (`agent-core` against the MOCK_MODE server with a `simulate` binary that replays fixture
    snapshots);
  - the Windows VM setup;
  - the list-verification checklist;
  - release, signing and antivirus submissions;
  - the troubleshooting log locations.

### Mock mode and development

- `agent-core` has a `simulate` example that reads a fixture scenario (snapshots over time), drives detection and
  posts real events to a local `pnpm --filter @neo/web dev` (MOCK_MODE, DEV_AUTH_BYPASS) with an enrolled code.
  The full server path (alerts, emails in mock, expected tools) can be exercised from Linux.
- Scenarios:
  - portable AnyDesk run and then, three minutes later, an incoming session (two alerts: `high`, then
    `critical`);
  - TeamViewer present at enrollment (baseline);
  - an expected tool with a known peer;
  - an unsigned new program.

## Possible Edge Cases

- **Portable AnyDesk from Downloads.** It is caught by the process match and the signer check. Its session log is
  under `%AppData%`, which the service reads for every profile.
- **A renamed binary** (`support.exe`). The process name does not match, but the signer still says "AnyDesk
  Software GmbH". The signer check runs on every new image path whose signer is in any tool's `publishers`, not
  only on name matches.
- **An unsigned or modified tool binary.** No signer match. It is caught by the name, or fails open.
- **The owner helps grandma with AnyDesk.** Marked expected with the owner's ID, so the session is `low`: no window
  and no email.
- **Quick Assist used by the owner.** There is no peer ID, so even an expected session is `high`. This is accepted
  for v1, and noted in the owner's expected-tools UI hint.
- **Several Windows users on one PC.** The device protects one member (the device-enrollment decision). Events from
  any user on that PC are attributed to that member. "One device, several members" stays deferred.
- **The scammer is connected when Neo warns.** The warning window is visible to them too. It is topmost and does
  not take focus, but they can close it. The owner's email still goes out.
- **The scammer stops the service through the session.** The owner gets the session alert first if Neo saw it,
  then the offline alert. The plan accepts this; it does not prevent tampering.
- **A clock skew or a long sleep.** Queued events older than 23 hours are dropped. The heartbeat resumes on wake.
- **A malicious local process talks to the pipe.** It can ask for status, check a URL, enroll (only with a valid
  code) or unenroll (which alerts the owner). It cannot read the token or post events.
- **A list update adds a regex that Rust cannot compile.** The subset test rejects it in CI. At runtime, an
  uncompilable pattern is skipped and logged, never fatal.
- **A huge or rotated log file.** The service reads from the last offset, at most 64 KB per poll. It resets on
  truncation and ignores lines longer than 4 KB.
- **The machine has no network for days.** Detection and local warnings still work. Events are dropped after 23
  hours in the queue, and the owner gets the offline alert after 48.

## Acceptance Criteria

- [ ] `agent-core` tests pass on Ubuntu for every detector, baseline versus new, dedupe, the queue and the API
      client. The fixture scenarios cover portable AnyDesk, a verified session with a peer, a renamed signed
      binary, a PUP publisher and an unsigned new program.
- [ ] The `desktop-windows` CI job installs the MSI, finds the service running and answering on the pipe, and
      uninstalls it cleanly. An upgrade from the previous build keeps the enrollment.
- [ ] Enrollment by code and by device flow work through the tray. The token exists only in the DPAPI file.
- [ ] `simulate` against the MOCK_MODE server raises:
  - [ ] `high` `remote_access` for a new tool, followed three minutes later by a separate `critical` alert for an
        incoming session with the same tool;
  - [ ] `medium` "is installed" for a baseline tool;
  - [ ] `critical` for an unexpected session;
  - [ ] `low` for an expected tool and peer;
  - [ ] `scam_in_progress` when paired with an extension `scam_page`.
- [ ] Uninstalling raises `device_removed`; an upgrade does not.
- [ ] The service-driven update refuses a manifest with a bad minisign signature or an MSI with the wrong signer.
- [ ] Every `sessionEvidence` entry that ships is `verified: true`, with the vendor version and date recorded. List
      regexes pass the subset test.
- [ ] Contracts, privacy page, `.env.example`, the Add-a-device link and `docs/desktop-agent.md` are updated.

## Open Questions

- **Signing service.** Azure Artifact Signing (paid, identity validation as an individual) or SignPath Foundation
  (free for open source, needs approval). This is the owner's decision and account; nothing ships unsigned.
- **Windows VM for verification.** Which VM (Hyper-V, VirtualBox, or a cloud Windows box) and whose vendor
  accounts are used for test sessions. This is needed before session detection ships for any tool.
- **Quick Assist session evidence.** If nothing reliable is found on the VM, Quick Assist ships with "opened"
  detection only, as a `remote_access_tool` event, since it is built into Windows. The alternative is to treat
  `QuickAssist.exe` running as a session. The VM result decides.
- **ARM64 Windows.** Out of scope for v1 (x86_64 only); revisit after the first release.

## Testing Guidelines

Create test files in the `./test` folders (Rust: `tests/` and unit tests) for the new feature, with meaningful
tests for the following cases, without going too heavy:

- `apps/desktop/crates/agent-core/tests/`:
  - list parsing (including the regex subset);
  - process, uninstall and service matching with signer confirmation;
  - session log parsing per verified tool from fixture excerpts, including peer extraction, truncation and
    rotation;
  - baseline then new;
  - dedupe windows;
  - queue stale drop and backoff;
  - the API client against recorded HTTP fixtures.
- `apps/desktop/crates/agent-service`: unit tests for the pipe protocol validation (oversize, unknown request,
  malformed JSON). Windows-only integration runs in the `desktop-windows` job.
- `apps/desktop` (Vitest): the enrollment window states, the warning window copy (owner told or not), and the
  check-link window.
- `packages/verdict/test/signals.test.ts`: `discovery` accepted on the two detectors and rejected elsewhere.
- `packages/tools/test/lists.test.ts`: the `sessionEvidence` shape, `verified` flags, and the regex subset across
  all patterns.
- `apps/web/test/signal-rules.test.ts`: baseline severities, the expected-tool override, and baseline events
  excluded from correlation.
- `apps/web/test/signals.test.ts`: an install alert and a session alert for the same tool within the hour are two
  alerts; the heartbeat returns the device's expected tools.
- `apps/web/test/household-settings.test.tsx`: the Windows download link versus "coming soon".
