# Windows desktop agent

Neo's Windows agent (`apps/desktop`) notices a remote-access scam while it happens and tells two people: the person at
the keyboard at once, and the household owner by email within a minute. The functional spec is
`_specs/desktop-agent.md`; the wire formats are in `docs/contracts.md` ("Desktop agent", "HTTP contract: devices",
"HTTP contract: signals"). This page is the working guide: how it is built, how to develop it on Linux, how to set up a
Windows VM, how to verify the detection lists, how to release it, and where to look when it misbehaves.

> **Install it in person.** "Download this and install it" is the scam script itself. Install Neo on a relative's
> computer when you are sitting at it, or over a remote-access tool that is already marked *expected* for that
> device. Never ask someone to download and run it over the phone. The Add-a-device page says the same.

## Architecture

Two processes, one installer.

```
                 Windows computer                                        Neo server
 ┌────────────────────────────────────────────┐
 │ neo-agent.exe  (service "NeoAgent",        │   HTTPS   POST /api/devices/heartbeat  (hourly)
 │   "Neo Protection", LocalSystem)           │ ────────► GET  /api/signals/lists      (ETag)
 │   holds the device token (DPAPI, machine)  │           POST /api/signals            (events only)
 │   detection · queue · heartbeat · updates  │           POST /api/devices/check-url
 │         ▲   named pipe \\.\pipe\neo-agent  │           DELETE /api/devices/self     (stop / uninstall)
 │         │   newline JSON, ≤ 16 KB          │
 │ neo.exe  (Tauri tray app, one per user)    │
 │   tray · enrollment window · warnings ·   │
 │   "Check a link" · never sees the token    │
 └────────────────────────────────────────────┘
```

| Part | Where | What it is |
|---|---|---|
| `neo-agent-core` | `apps/desktop/crates/agent-core` | Pure Rust, no OS calls, tested on Linux. List parsing, matching, the event builder, "seen" state, the queue, local warning decisions, the HTTP client. |
| `neo-agent` | `apps/desktop/crates/agent-service` | The service. The scanning loop, enrollment, pipe protocol, updates and logging are OS-independent and tested on Linux; the `windows` module (`cfg(windows)`) turns the OS into snapshots. |
| `neo-desktop` | `apps/desktop/src-tauri` | The tray app (Tauri v2, binary `neo.exe`). Talks to the service only through the pipe. |
| `@neo/desktop` | `apps/desktop/src` | The React UI for the tray app's windows (pnpm package, Vitest tests, no Rust needed). |
| WiX fragment | `apps/desktop/src-tauri/wix/neo-agent.wxs` | `ServiceInstall`/`ServiceControl`, the HKLM `Run` entry for the tray, the uninstall unenroll action. |
| CI helpers | `apps/desktop/ci/` | `changed.sh`, a fake Neo server, `pipe-request.ps1`, `make-latest-json.mjs`. |

### What the service does

- **Scans** (`agent.rs`): processes and session logs every 5 s, uninstall entries and services every 60 s, event-log
  channels every 30 s. A heartbeat on start and hourly; an update check on start and daily.
- **Detects** with `neo-agent-core::detect` on those snapshots and sends only events (a new remote-access tool, an
  incoming session, unwanted software). It never sends an inventory.
- **First scan after enrollment** is a *baseline*: everything already installed is reported with `discovery:
  "baseline"` and recorded in `seen.json`, so the owner learns what is there without a "TeamViewer was installed"
  alert. Later appearances are `new`.
- **Warns locally** from the evidence itself, before the server answers, using the `expectedTools` from the last
  heartbeat. With a tray app running the warning goes down the pipe; with none, the service shows a message box in the
  active console session (`WTSSendMessageW`).
- **Queues** events in `queue.json` (at most 200, dropped after 23 hours, exponential backoff, `Retry-After` honoured).
- **Disconnects** on a 401: clears the token, stops detecting, the tray shows "This computer is no longer connected to a
  household".
- **Updates itself** (see [Updates](#updates)).

Files in `C:\ProgramData\Neo\` (ACL: SYSTEM and Administrators only, inherited): `device.bin` (token and server URL,
DPAPI machine scope), `agent.json` (names for the tray, last check-in, expected tools, list ETag), `seen.json`,
`queue.json`, `cursors.json`, `lists.json`, `logs\`, `updates\` (a downloaded MSI while it is checked and installed).
These are local working state; none of it is sent.

### Pipe protocol details

`docs/contracts.md` has the request and push names. The service also does the following (to be folded into the
contract):

- **`status` reply**: `{ ok, state: "not_enrolled" | "enrolled" | "disconnected", version, serverUrl, computerName,
  deviceName, memberName, householdName, ownerName, lastCheckIn, lastWarningAt, updateAvailable }`.
- **`serverUrl`** is an optional argument of `enroll_preview`, `enroll` and `self_enroll_start`, for self-hosters. It must
  be `https://`, or `http://` on localhost, and is refused once enrolled.
- **`self_enroll_start`** returns `{ userCode, verificationUri, verificationUriComplete, expiresIn, interval }` and keeps
  the device code inside the service. **`self_enroll_poll`** returns `{ status: "pending" | "approved" | "denied" |
  "expired" }`.
- **`subscribe`** turns the connection into a push-only stream (a blocking read and a write on one synchronous pipe
  handle would deadlock), so a client that also wants to ask questions opens a second connection. Blank lines are
  keep-alives; ignore them.
- **A warning is pushed twice** when the owner is told: first at once with `ownerTold: false`, then again with the same
  `eventId` and `ownerTold: true` after the server accepted the event (severity `medium` or above). An open window
  updates in place; no second window or toast opens.
- **Error codes**: `request_too_large`, `invalid_json`, `invalid_request`, `unknown_op`, `not_enrolled`,
  `already_enrolled`, `invalid_code`, `invalid_server_url`, `server_unreachable`, `rate_limited`, `device_limit`,
  `disconnected`, `no_sign_in`, `storage_failed`, `server_error`. The tray adds `agent_unavailable` when the service is
  not running.
- An oversize request is answered once and the connection is closed. At most 32 connections are served at once.
- The pipe's DACL is SYSTEM full access and INTERACTIVE read/write (remote clients refused, first instance claimed with
  `FILE_FLAG_FIRST_PIPE_INSTANCE` so nothing can squat the name).

### Updates

The service reads a Tauri-format `latest.json` (default `https://github.com/pkeenan87/neo-personal/releases/download/desktop-latest/latest.json`), and when
`version` is newer than its own it downloads the MSI and checks, in this order:

1. the **minisign signature** (the manifest's `signature` is the base64 of the `.sig` file, exactly what `tauri signer
   sign` writes) against the public key compiled into the binary (`minisign-verify`);
2. the MSI's **Authenticode signer** equals the running agent's signer (identical subject, non-empty). An agent that is
   itself unsigned (a CI build) accepts an unsigned MSI only when it was built with `NEO_ALLOW_UNSIGNED_UPDATE`; a
   release build never sets that;

then runs `msiexec /i <msi> /qn /norestart` as SYSTEM, detached. Windows Installer stops the service, replaces the files
and starts the new one. The MSI is staged inside the protected data directory so a user cannot swap it between the
checks and the install. An update URL must be `https://` (or loopback `http://`, for CI).

### Build-time configuration

Set these when building; none is read at run time, so a local user cannot redirect the service. All are optional.

| Variable | Used by | Default |
|---|---|---|
| `NEO_BASE_URL` | `neo-agent` | `https://www.neoshield.dev` |
| `NEO_DESKTOP_UPDATE_URL` | `neo-agent` | the `desktop-latest` release's `latest.json` |
| `NEO_DESKTOP_UPDATE_PUBKEY` | `neo-agent` | unset: updates are off. The base64 of the `.pub` file (the same value as `plugins.updater.pubkey` in a Tauri config). |
| `NEO_ALLOW_UNSIGNED_UPDATE` | `neo-agent` | unset. CI only. |
| `TAURI_NEO_AGENT_EXE` | the WiX fragment | none; **required** to build the MSI: the absolute path of `neo-agent.exe`. |

## Developing on Linux

You do not need Windows to work on detection, the service logic, the pipe protocol or the UI.

```bash
# Rust: the pure crates, the service (its Windows code is cfg'd out) and the tray crate
cd apps/desktop
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# The UI (also run by the repo's `pnpm turbo run typecheck lint test build`)
pnpm --filter @neo/desktop typecheck lint test build
```

The tray crate needs WebKitGTK and the built UI folder (`pnpm --filter @neo/desktop build`, or any `dist/index.html`)
because `tauri::generate_context!()` reads the frontend at compile time. On Debian/Ubuntu:
`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev libxdo-dev`.

### Replay detection against the MOCK_MODE server

`agent-core` has a `simulate` example that replays a fixture scenario (snapshots over time) and posts the real events:

```bash
# 1. the server (repo root)
MOCK_MODE=true DEV_AUTH_BYPASS=true pnpm --filter @neo/web dev -- --port 3007
# 2. an enrollment code: Settings → Household → add a member → "Add a device", or
curl -s -X POST http://localhost:3007/api/household/members/<member id>/enrollment-codes
# 3. replay a scenario
cd apps/desktop/crates/agent-core
cargo run --example simulate -- tests/fixtures/scenarios/portable-anydesk-session.json \
  --post http://localhost:3007 --code <code>
```

Scenarios: `portable-anydesk-session` (a `high` alert, then a `critical` one three minutes later),
`teamviewer-baseline` (`medium`, "is installed"), `expected-tool-known-peer` (`low`), `unsigned-new-program`,
`renamed-signed-binary`, `pup-publisher`. Pair a session with an extension `scam_page` to see `scam_in_progress`.

### The whole service and the tray, on Linux

The service has a development mode that serves the same protocol on a unix socket, with the "machine" described by a
JSON snapshot file (the `Snapshot` type from `agent-core`; edit the file to "install" something):

```bash
cd apps/desktop
cargo run -p neo-agent -- --dev-pipe /tmp/neo-agent-dev.sock --data-dir /tmp/neo-agent-dev --snapshot my-snapshot.json
# the tray app and UI, talking to it (NEO_AGENT_SOCKET defaults to /tmp/neo-agent-dev.sock)
pnpm --filter @neo/desktop exec tauri dev
```

Enroll through the first-run window against the MOCK_MODE server: open "Advanced", set `http://localhost:3007`, paste a
code. Dev mode stores the token unencrypted, shows no message-box fallback and installs nothing.

### Type-checking the Windows code without Windows

CI is the real build, but you can type-check `cfg(windows)` code on Linux: take an official `rustc` and the
`rust-std-<version>-x86_64-pc-windows-msvc` tarball from `static.rust-lang.org/dist`, put both in one sysroot, and run
`RUSTC=<sysroot>/bin/rustc cargo check -p neo-agent --lib --no-default-features --target x86_64-pc-windows-msvc`
(`--no-default-features` leaves out the HTTP client, whose TLS library needs a C toolchain for Windows). A distro `rustc`
refuses the official standard library as "incompatible". This catches wrong signatures and missing `windows` crate
features; it cannot run anything.

## Windows VM setup

The detection lists must be verified on a real Windows install (next section), and the first full run of the installer
is easiest to watch on a VM.

1. **A VM** (Hyper-V, VirtualBox, or a cloud Windows 11 box). Use a clean Windows 11 install with Microsoft Defender on
   and take a snapshot before installing anything.
2. **Build the MSI** on the VM (it needs Rust, Node 22 + pnpm, and Git):
   ```powershell
   git clone https://github.com/pkeenan87/neo-personal; cd neo-personal
   pnpm install
   cd apps\desktop
   cargo build --release -p neo-agent
   $env:TAURI_NEO_AGENT_EXE = (Resolve-Path target\release\neo-agent.exe).Path
   pnpm exec tauri build --bundles msi
   ```
   The MSI is in `apps\desktop\target\release\bundle\msi\`. It is unsigned, so SmartScreen and Defender may warn: that is
   expected for a development build. Add `$env:NEO_BASE_URL` and the update settings above to point it at your own
   server.
3. **Reach your dev server from the VM.** The agent only talks to `https://` servers, or `http://` on *localhost*. Forward
   the VM's `localhost:3007` to the host: `netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=3007
   connectaddress=<host ip> connectport=3007`, or an SSH tunnel (`ssh -L 3007:localhost:3007 host`).
4. **Install and look**: double-click the MSI (or `msiexec /i Neo_0.1.0_x64_en-US.msi /l*v install.log`), then
   `Get-Service NeoAgent`, the tray icon, and `C:\ProgramData\Neo\logs`.
5. **Run it in the foreground** to watch it work: stop the service (`Stop-Service NeoAgent`), then, in an elevated
   prompt, `& "C:\Program Files\Neo\neo-agent.exe" --console` (logs also go to the console).
6. **Talk to the pipe by hand** (as SYSTEM or an interactive user):
   ```powershell
   $p = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'neo-agent', 'InOut'); $p.Connect(5000)
   $w = New-Object System.IO.StreamWriter($p); $w.AutoFlush = $true; $r = New-Object System.IO.StreamReader($p)
   $w.WriteLine('{"op":"status"}'); $r.ReadLine()
   ```

## Verifying the detection lists

`packages/tools/src/data/remote-access-tools.json` is the data the agent trusts. **Every value must come from a real
install, not from memory**, and every session-evidence entry ships only when it is `verified: true`. This is a separate
task from writing the agent; do it per tool on the VM, with the current vendor build.

For each tool, record the vendor version and the date in `checked` (`"<vendor version> <YYYY-MM-DD>"`), then flip
`verified` to `true`. Gather the facts with the snippets below, run as a normal user in a PowerShell window.

| Field | How to find it | Notes |
|---|---|---|
| `windows.publishers` | `(Get-AuthenticodeSignature "C:\path\Tool.exe").SignerCertificate.Subject` and the `Publisher` value of the uninstall key | The agent reads the certificate's *simple display name* (usually the CN) and matches it case-insensitively: the listed publisher must equal it, or appear in it as a whole name. Record what `(Get-AuthenticodeSignature …).SignerCertificate.GetNameInfo('SimpleName', $false)` prints. |
| `windows.displayNamePatterns` | `DisplayName` under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`, `HKLM\SOFTWARE\WOW6432Node\…\Uninstall\*` and `HKCU\…\Uninstall\*` | Anchored JavaScript regex, no lookaround, no backreferences, no flags. Check an install for all users and for one user. |
| `windows.serviceNames` | `Get-Service \| Where-Object DisplayName -match 'ToolName'` and `sc.exe query` | The service name, not the display name. Only for tools that install a service. |
| `windows.processNames` | Task Manager → Details; the portable download too (that is the common scam path) | Run the downloaded portable `.exe` from `Downloads` without installing and note the name. |
| `sessionEvidence` | Start a **real incoming session** from a second machine and see what appears on the first (below) | One entry per signal. Run a session, end it, run another. |

**Session evidence, per kind:**

- `log`: find the file the tool writes when someone connects (Process Monitor filtered to the tool's process, or look in
  `%ProgramData%\<Tool>`, `%AppData%\<Tool>`, the program folder). Copy a few lines of an incoming session, **replace
  real IDs with obviously fake ones**, and write the `pattern` so it matches only incoming lines and captures the peer
  ID as `(?<peer>…)`. Check that an outgoing session and an idle tool do not match. Check the path expands for a
  per-user install (`%AppData%`) and a machine install (`%ProgramData%`, `%ProgramFiles%`).
- `eventlog`: `Get-WinEvent -ListLog *<Tool>*` for the channel, then `Get-WinEvent -LogName '<channel>' -MaxEvents 20`
  during and after a session; record the `eventIds` that appear only for a session.
- `process`: a process that exists only while a session is active. Confirm that "the tool is open but nobody is
  connected" does **not** start it (the agent fails open: a running tool alone is never a session).

Then, for each tool:

1. Edit the JSON, including `verified` and `checked`. Tools with no reliable evidence keep `sessionEvidence: []` (or
   unverified candidates) and ship with install and run detection only. If nothing reliable is found for Quick Assist,
   decide per the spec's open question.
2. Add the log excerpt (fake IDs) as a fixture under `apps/desktop/crates/agent-core/tests/fixtures/` and a case in
   `crates/agent-core/tests/` so the pattern is exercised.
3. Run `pnpm --filter @neo/tools test` (the regex-subset test), then `pnpm --filter @neo/desktop lists` to refresh
   `crates/agent-service/data/lists-snapshot.json` (a test fails when it drifts), then `cargo test --workspace`.

Known gaps to fill: UltraViewer, RustDesk and AeroAdmin have no Windows publishers; ScreenConnect has no service or
process names; every session candidate is `verified: false`.

## Releasing

A release is a tag: `desktop-v<version>`, where `<version>` is `version` in `apps/desktop/Cargo.toml` (the workflow
checks they match). `desktop-release.yml` builds, signs and publishes the MSI and `latest.json`.

```bash
# bump `version` under [workspace.package] in apps/desktop/Cargo.toml, commit, then
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
```

What the workflow does, in order: checks the signing configuration (and **fails first** if it is incomplete; nothing
ships unsigned), runs the tests, builds `neo-agent.exe` and `neo.exe` unbundled, signs them, bundles the MSI from the
signed programs, signs the MSI, verifies every file's Authenticode signature (and that they share one signer), signs the
MSI with the minisign update key, writes `latest.json`, and creates the GitHub release. It also uploads `latest.json` to
a rolling pre-release tagged `desktop-latest`, because that fixed address is what installed agents poll
(`releases/latest` would point at whichever release, extension or desktop, is newest).

### One-time setup

| Where | Name | What |
|---|---|---|
| Repository variable | `DESKTOP_SIGNING_PROVIDER` | `azure` (the only provider wired into the workflow) |
| Repository variable | `NEO_DESKTOP_UPDATE_PUBKEY` | The update public key: the contents of the `.pub` file from `tauri signer generate`. Compiled into every agent. |
| Repository secret | `DESKTOP_UPDATE_SIGNING_KEY` | The matching private key (the `.key` file contents). Keep an offline backup: **losing it strands every installed agent**, because they only trust this key. |
| Repository secret | `DESKTOP_UPDATE_SIGNING_KEY_PASSWORD` | The key's password, if it has one. |
| Variables (Azure) | `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_PROFILE` | The Artifact Signing endpoint, account and certificate profile names. |
| Secrets (Azure) | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | An app registration with the certificate-profile signer role on the Artifact Signing account. |

Generate the update key once, on a trusted machine: `pnpm --filter @neo/desktop exec tauri signer generate -w neo-update.key`.

### Signing options

Neither option gives instant SmartScreen reputation (EV certificates no longer do either, since 2024).

- **Azure Artifact Signing** (formerly Trusted Signing). The Basic tier is about **$9.99 a month**. Individual
  developers in the US and Canada are eligible; identity validation takes a few business days. It signs through
  `Azure/artifact-signing-action` on the Windows runner, which is what `desktop-release.yml` does. Set up an Artifact
  Signing account and a *Public Trust* certificate profile in Azure, create an app registration, and grant it the certificate-profile signer
  role.
- **SignPath Foundation**: free code signing for open-source projects, subject to their approval (apply with the public
  repository). It signs through an *asynchronous* API: upload the unsigned file as a workflow artifact
  (`actions/upload-artifact`), submit it with `signpath/github-action-submit-signing-request`, and download the signed
  result. That does not fit the current step order, because the programs must be signed *before* the MSI is bundled and
  the MSI signed after, so it means two submissions per release. It is not wired up. To switch, replace the two
  `Azure/artifact-signing-action` steps with a submit/download pair each, give `DESKTOP_SIGNING_PROVIDER` a new value and
  extend the gate step; the "Verify every signature" step stays as the safety net.

### SmartScreen, antivirus and reputation

- **SmartScreen.** Early users will see a "Windows protected your PC" prompt (More info → Run anyway). Reputation builds
  with a consistent publisher identity and downloads over time. Say so on the download page.
- **Antivirus submissions before each public release.** A new, unusual, service-installing binary is exactly what
  heuristics flag, and "our own agent flagged as malware" is a top risk in the plan. Submit the signed MSI and
  `neo-agent.exe` and log each submission in the table below. **Re-check each URL before you use it; these programs
  move, and the ones below are from memory of the vendors' pages.**
  1. Microsoft Security Intelligence, as a software developer: <https://aka.ms/wdsi> (first, since Defender is on every
     target machine).
  2. Avast / AVG whitelisting: <https://www.avast.com/false-positive-file-form.php>.
  3. ESET false-positive submission: <https://support.eset.com/en/kb141-submit-a-file-or-website-for-analysis> (the
     support article links to the current form).
  4. Kaspersky Threat Intelligence / false positives: <https://opentip.kaspersky.com>.
  5. Malwarebytes false-positive reports: <https://forums.malwarebytes.com/forum/122-file-detections/>.
- **Plain presence** helps: the service is called "Neo Protection" with a description, the tray icon is always there while
  enrolled, and the installer's licence page is a "What Neo does" page. Do not add anything hidden or obfuscated.

| Date | Version | Service | Result |
|---|---|---|---|
| | | | |

## CI

`.github/workflows/ci.yml` has two desktop jobs next to `checks`. Both **always start** (the *All checks passed*
aggregator needs `success` from them and counts `skipped` as a failure), and both begin with
`apps/desktop/ci/changed.sh`, which compares the change with the merge base (`fetch-depth: 0`) and, when nothing under
`apps/desktop/**`, `packages/tools/src/data/**` or the CI workflow changed, skips every later step.

- **`desktop-core`** (Ubuntu): `cargo fmt --check`; clippy `-D warnings` and tests for `neo-agent-core` and `neo-agent`;
  then, after installing WebKitGTK, clippy and tests for the tray crate.
- **`desktop-windows`** (`windows-2025`): clippy and tests for the whole workspace on Windows, then:
  1. builds the unsigned MSI (version N) with a throwaway minisign key and a local update URL;
  2. installs it, finds `NeoAgent` Running as LocalSystem with an automatic start, answers `{"op":"status"}` on the pipe
     (the check runs as SYSTEM through a one-shot scheduled task, because the runner is not an interactive session),
     the data directory ACL excludes ordinary users, and the HKLM `Run` entry exists;
  3. enrolls against a fake Neo server (`ci/fake-neo-server.mjs`, answering from the recorded fixtures) and checks the
     token is only in the DPAPI file;
  4. builds N+1, serves a `latest.json` with a signature of a different file and checks the service **refuses** it (log
     line, version unchanged);
  5. serves the real manifest, restarts the service (the update check runs on start) and waits for **the service to apply
     N+1 itself**: it spawns `msiexec`, which stops it, replaces the files and starts the new one. It then checks the
     version is N+1, the enrollment survived, `device.bin` is intact, and that no `DELETE /api/devices/self` was sent
     (an upgrade does not unenroll);
  6. uninstalls, and checks the service is gone, the folder is gone and exactly one `DELETE /api/devices/self` reached
     the server (the uninstall unenroll action).

  Not covered in CI: the *wrong Authenticode signer* refusal (unit-tested; the CI build is unsigned) and real
  SmartScreen/Defender behaviour. Logs are uploaded as the `desktop-windows-logs` artifact.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Nothing happens, no tray icon | `Get-Service NeoAgent` (should be Running); the tray app is `C:\Program Files\Neo\neo.exe` and starts at login (HKLM `Run`, value `Neo`). Run it by hand to see errors. |
| Tray says "Neo Protection isn't running" | Start the service: `Start-Service NeoAgent`. If it stops again, read the service log. |
| Service log | `C:\ProgramData\Neo\logs\neo-agent-YYYY-MM-DD.log` (7 days kept). It records event types and tool ids, never paths from user folders or tokens. Administrator access needed. |
| Run in the foreground | `Stop-Service NeoAgent`, then `& "C:\Program Files\Neo\neo-agent.exe" --console`. |
| Installer problems | Install with `msiexec /i <msi> /l*v install.log` and search for `Return value 3`. |
| Update did not apply | The service log has `update … was not installed: …` (bad signature, wrong signer, download). `C:\ProgramData\Neo\logs\msi-update.log` is `msiexec`'s own log. `C:\ProgramData\Neo\updates\` holds a staged MSI if the install step failed. |
| "No longer connected to a household" | The server answered 401: the device was removed or the member left. Enroll again from the tray. |
| Owner not told | `queue.json` holds events that could not be sent (network or server errors); they retry with backoff and are dropped after 23 hours. |
| Wrong list data | `C:\ProgramData\Neo\lists.json` is the cache; delete it to fall back to the built-in snapshot until the next heartbeat. |
| Reset a computer | Use "Stop protecting this computer" in the tray (the owner is told), or uninstall in Settings → Apps. |

Warning windows and toasts: the critical window is topmost and does not take keyboard focus; a tool-appeared or
unwanted-software warning is a toast (Windows shows toasts only for installed apps, so test with the MSI, not
`tauri dev`).
