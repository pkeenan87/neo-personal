//! Child-mode app enforcement, as pure decisions (`_specs/v2-m2-child.md` section 7): which running
//! processes the service may close, and which newly installed apps wait for a parent.
//!
//! **The service closes a program only here, and only when every guard says yes.** The guards fail
//! closed: a fact the OS probe could not read ("unknown") means the process is left alone. The OS
//! calls (message, terminate) are elsewhere, behind the `Actuator` trait of `neo-agent`; this module
//! never touches the OS, and takes the time and the process list as input.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::lists::publisher_matches;
use crate::policy::{AppRef, PolicyBundle};
use crate::snapshot::{AppBundle, ProcessInfo, UninstallEntry};

/// Which kind of computer the process list came from; the protected-process rules differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Mac,
}

/// What the service itself is, so it never closes itself or the tray app.
#[derive(Debug, Clone, Default)]
pub struct Exclusions {
    /// The service's own process id and its parent's.
    pub own_pids: Vec<u32>,
    /// `%WINDIR%` (Windows): nothing under it is ever closed. Empty means unknown, which protects
    /// every process (the rule cannot be evaluated).
    pub windir: String,
    /// Directories whose programs are Neo's own (the install directory, the tray app, the daemon
    /// bundle), matched as path prefixes.
    pub own_dirs: Vec<String>,
}

/// The tray app and the service by name, and the tray's bundle id.
const OWN_IMAGES: [&str; 2] = ["neo.exe", "neo-agent.exe"];
const OWN_BUNDLE_IDS: [&str; 1] = ["dev.neoshield.desktop"];

/// Why a process is never closed. `None` means it may be considered.
pub fn protected_reason(p: &ProcessInfo, platform: Platform, ex: &Exclusions) -> Option<&'static str> {
    if p.pid == 0 || p.pid == 4 || p.pid == 1 || ex.own_pids.contains(&p.pid) {
        return Some("neo or the system");
    }
    if p.image_path.trim().is_empty() {
        // Could not be opened: protected processes are exactly the ones that fail here.
        return Some("path unknown");
    }
    let name = p.image_name.to_lowercase();
    if OWN_IMAGES.contains(&name.as_str())
        || p.bundle_id
            .as_deref()
            .is_some_and(|b| OWN_BUNDLE_IDS.iter().any(|o| b.eq_ignore_ascii_case(o)))
    {
        return Some("neo");
    }
    let path = norm(&p.image_path, platform);
    if ex.own_dirs.iter().any(|d| under(&path, &norm(d, platform))) {
        return Some("neo");
    }
    match platform {
        Platform::Windows => {
            // Session 0 is where services run; an unknown session or owner is "do not touch".
            if !matches!(p.session_id, Some(s) if s != 0) {
                return Some("session 0 or unknown session");
            }
            if p.system_owned != Some(false) {
                return Some("system-owned or unknown owner");
            }
            if ex.windir.trim().is_empty() || under(&path, &norm(&ex.windir, platform)) {
                return Some("under the Windows directory");
            }
        }
        Platform::Mac => {
            if mac_system_path(&p.image_path) {
                return Some("macOS system path");
            }
            // Root-owned (daemons) and unknown owners are left alone; an app run by the person is not.
            if p.system_owned != Some(false) {
                return Some("root-owned or unknown owner");
            }
            // Apple's own software, validated against `anchor apple` by the probe.
            if p.apple_signed != Some(false) {
                return Some("Apple-signed or unknown signature");
            }
        }
    }
    None
}

/// `/System`, the OS tool directories, and Apple's support directories. `/usr/local` is where
/// people's own tools live, so it is not a system path.
fn mac_system_path(path: &str) -> bool {
    if path.starts_with("/usr/local/") {
        return false;
    }
    [
        "/System/",
        "/usr/",
        "/bin/",
        "/sbin/",
        "/Library/Apple/",
        "/private/var/db/",
        "/Library/Developer/CommandLineTools/",
    ]
    .iter()
    .any(|p| path.starts_with(p))
}

fn norm(path: &str, platform: Platform) -> String {
    match platform {
        Platform::Windows => path.trim().replace('/', "\\").to_lowercase(),
        Platform::Mac => path.trim().to_string(),
    }
}

/// `path` is `dir` itself or inside it (a prefix at a separator boundary).
fn under(path: &str, dir: &str) -> bool {
    let d = dir.trim_end_matches(['\\', '/']);
    if d.is_empty() {
        return false;
    }
    path == d || (path.starts_with(d) && matches!(path.as_bytes().get(d.len()), Some(b'\\' | b'/')))
}

// ---- Matching -------------------------------------------------------------------------------------

/// Whether the running `p` is the app `r` names. A bundle id is exact (case-insensitive). Otherwise
/// every field the ref sets must match: the image name (case-insensitive) and the signer (the same
/// delimited match as the detection lists). An empty ref matches nothing.
pub fn app_matches(r: &AppRef, p: &ProcessInfo) -> bool {
    if r.is_empty() {
        return false;
    }
    if let Some(b) = non_blank(&r.bundle_id) {
        return p.bundle_id.as_deref().is_some_and(|pb| pb.trim().eq_ignore_ascii_case(b));
    }
    if let Some(img) = non_blank(&r.image)
        && !p.image_name.trim().eq_ignore_ascii_case(img)
    {
        return false;
    }
    if let Some(s) = non_blank(&r.signer)
        && !p.signer.as_deref().is_some_and(|ps| publisher_matches(ps, s))
    {
        return false;
    }
    true
}

/// Whether the policy entry `approved` covers the app `app` (the reported ref of a pending app):
/// the same rule as [`app_matches`], applied to the fields of a ref instead of a process.
pub fn ref_covers(approved: &AppRef, app: &AppRef) -> bool {
    if approved.is_empty() {
        return false;
    }
    if let Some(b) = non_blank(&approved.bundle_id) {
        return non_blank(&app.bundle_id).is_some_and(|ab| ab.eq_ignore_ascii_case(b));
    }
    if let Some(img) = non_blank(&approved.image)
        && !non_blank(&app.image).is_some_and(|ai| ai.eq_ignore_ascii_case(img))
    {
        return false;
    }
    if let Some(s) = non_blank(&approved.signer)
        && !non_blank(&app.signer).is_some_and(|a| publisher_matches(a, s))
    {
        return false;
    }
    true
}

fn non_blank(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

// ---- Decisions ------------------------------------------------------------------------------------

/// Why a process is closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// In `apps.block`.
    Blocked,
    /// Newly installed and not yet in `apps.approved`.
    AwaitingApproval,
}

/// A newly installed app waiting for a parent (persisted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingApp {
    pub name: String,
    pub app: AppRef,
    /// Unix seconds when it was first seen.
    pub since: i64,
}

/// One process to close.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseAction {
    pub pid: u32,
    /// The path the process had when it was listed; the OS layer re-checks it before closing.
    pub image_path: String,
    /// The app's name for the message ("Roblox").
    pub name: String,
    /// The ref to report in `app_blocked`.
    pub app: AppRef,
    pub reason: CloseReason,
}

/// What the app guard knows besides the process list.
pub struct AppContext<'a> {
    pub bundle: &'a PolicyBundle,
    pub pending: &'a [PendingApp],
    /// Downtime is in force now: `screenTime.allowDuringDowntime` is then left alone.
    pub in_downtime: bool,
    pub platform: Platform,
    pub exclusions: &'a Exclusions,
}

/// The running processes the block list or the apps waiting for approval name: the only ones whose
/// owner and session the OS probe needs to look up before [`processes_to_close`] decides. Cheap
/// string matching, so every process can be tried on every pass.
pub fn candidates(procs: &[ProcessInfo], bundle: &PolicyBundle, pending: &[PendingApp]) -> Vec<ProcessInfo> {
    if !bundle.is_child() {
        return Vec::new();
    }
    procs
        .iter()
        .filter(|p| {
            bundle.apps.block.iter().any(|r| app_matches(r, p))
                || (bundle.apps.require_approval && pending.iter().any(|pa| app_matches(&pa.app, p)))
        })
        .cloned()
        .collect()
}

/// The processes to close now. Empty unless the bundle is a Child bundle. Precedence, strongest
/// first: protected, `apps.approved`, `allowDuringDowntime` (during downtime only), then the block
/// list, then the apps waiting for approval.
pub fn processes_to_close(procs: &[ProcessInfo], ctx: &AppContext<'_>) -> Vec<CloseAction> {
    let b = ctx.bundle;
    if !b.is_child() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for p in procs {
        if protected_reason(p, ctx.platform, ctx.exclusions).is_some() {
            continue;
        }
        if b.apps.approved.iter().any(|r| app_matches(r, p)) {
            continue;
        }
        if ctx.in_downtime && b.screen_time.allow_during_downtime.iter().any(|r| app_matches(r, p)) {
            continue;
        }
        if let Some(r) = b.apps.block.iter().find(|r| app_matches(r, p)) {
            out.push(action(p, r.clone(), p_name(p), CloseReason::Blocked));
            continue;
        }
        if b.apps.require_approval
            && let Some(pa) = ctx.pending.iter().find(|pa| app_matches(&pa.app, p))
        {
            out.push(action(p, pa.app.clone(), pa.name.clone(), CloseReason::AwaitingApproval));
        }
    }
    out
}

fn action(p: &ProcessInfo, app: AppRef, name: String, reason: CloseReason) -> CloseAction {
    CloseAction {
        pid: p.pid,
        image_path: p.image_path.clone(),
        name,
        app,
        reason,
    }
}

/// "RobloxPlayerBeta.exe" -> "RobloxPlayerBeta"; a macOS executable name is used as is.
fn p_name(p: &ProcessInfo) -> String {
    let n = p.image_name.trim();
    let lower = n.to_lowercase();
    let n = if lower.ends_with(".exe") { &n[..n.len() - 4] } else { n };
    if n.is_empty() { "An app".to_string() } else { n.to_string() }
}

/// Drops pending apps a parent has since approved (`apps.approved` covers them) and caps the list.
pub fn prune_pending(pending: &mut Vec<PendingApp>, bundle: &PolicyBundle) {
    pending.retain(|pa| !bundle.apps.approved.iter().any(|a| ref_covers(a, &pa.app)));
    if pending.len() > MAX_PENDING {
        pending.drain(..pending.len() - MAX_PENDING);
    }
}

/// At most this many apps wait for approval at once.
pub const MAX_PENDING: usize = 50;

// ---- Install detection ------------------------------------------------------------------------------

/// An installed application, as far as install detection cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledApp {
    /// Stable identity for "have we seen this before" (never a path).
    pub key: String,
    pub name: String,
    /// macOS: the bundle id, which is also the ref.
    pub bundle_id: Option<String>,
    /// Windows: the entry, for finding its main executable.
    pub entry: Option<UninstallEntry>,
}

/// Windows uninstall entries as installed apps. Entries with nothing to find the program by (no
/// `DisplayIcon` `.exe` and no install location) are left out: they cannot be enforced anyway.
pub fn installed_from_uninstall(entries: &[UninstallEntry]) -> Vec<InstalledApp> {
    entries
        .iter()
        .filter(|e| !e.display_name.trim().is_empty() && crate::detect::exe_hint(e).is_some())
        .map(|e| InstalledApp {
            key: format!(
                "{}\u{1f}{}",
                e.display_name.trim().to_lowercase(),
                e.publisher.as_deref().unwrap_or("").trim().to_lowercase()
            ),
            name: e.display_name.trim().to_string(),
            bundle_id: None,
            entry: Some(e.clone()),
        })
        .collect()
}

/// macOS `.app` bundles as installed apps (Apple's own are left out; they are protected anyway).
pub fn installed_from_bundles(bundles: &[AppBundle]) -> Vec<InstalledApp> {
    bundles
        .iter()
        .filter(|b| !b.is_apple())
        .filter_map(|b| {
            let id = b.bundle_id.as_deref()?.trim();
            (!id.is_empty()).then(|| InstalledApp {
                key: id.to_lowercase(),
                name: b.name.trim().to_string(),
                bundle_id: Some(id.to_string()),
                entry: None,
            })
        })
        .collect()
}

/// An app that disappears from the list for less than this is not "new" when it comes back (a
/// failed read of one registry hive is not an install).
pub const FORGET_AFTER_SECS: i64 = 7 * 86_400;

/// Which apps the service has seen (persisted in `child.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inventory {
    /// The first full list has been recorded silently.
    baselined: bool,
    /// key -> last seen (unix seconds).
    seen: BTreeMap<String, i64>,
}

impl Inventory {
    /// Records a full app list and returns the apps that are new. The first list ever is the
    /// baseline: everything in it is recorded and nothing is new. An empty list changes nothing
    /// (a failed read must not make everything look new next time).
    pub fn observe(&mut self, apps: &[InstalledApp], now: i64) -> Vec<InstalledApp> {
        if apps.is_empty() {
            return Vec::new();
        }
        let first = !self.baselined;
        let mut fresh = Vec::new();
        let mut seen_now = BTreeSet::new();
        for a in apps {
            if !seen_now.insert(a.key.clone()) {
                continue;
            }
            if self.seen.insert(a.key.clone(), now).is_none() && !first {
                fresh.push(a.clone());
            }
        }
        self.baselined = true;
        self.seen.retain(|_, last| now - *last <= FORGET_AFTER_SECS);
        fresh
    }

    pub fn is_baselined(&self) -> bool {
        self.baselined
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{AppsRules, DowntimeWindow, ScreenTimeRules};

    fn win(pid: u32, image: &str, path: &str, signer: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            pid,
            image_name: image.into(),
            image_path: path.into(),
            signer: signer.map(str::to_string),
            session_id: Some(1),
            system_owned: Some(false),
            ..Default::default()
        }
    }

    fn mac(pid: u32, path: &str, bundle: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            pid,
            image_name: path.rsplit('/').next().unwrap().into(),
            image_path: path.into(),
            bundle_id: bundle.map(str::to_string),
            system_owned: Some(false),
            apple_signed: Some(false),
            ..Default::default()
        }
    }

    fn ex() -> Exclusions {
        Exclusions {
            own_pids: vec![100, 101],
            windir: r"C:\Windows".into(),
            own_dirs: vec![r"C:\Program Files\Neo".into(), "/Applications/Neo.app".into()],
        }
    }

    fn app_ref(signer: Option<&str>, image: Option<&str>) -> AppRef {
        AppRef {
            signer: signer.map(str::to_string),
            image: image.map(str::to_string),
            ..Default::default()
        }
    }

    fn bundle_id(id: &str) -> AppRef {
        AppRef {
            bundle_id: Some(id.into()),
            ..Default::default()
        }
    }

    fn child(apps: AppsRules) -> PolicyBundle {
        PolicyBundle {
            v: 1,
            mode: "child".into(),
            apps,
            ..Default::default()
        }
    }

    fn close(b: &PolicyBundle, pending: &[PendingApp], procs: &[ProcessInfo], platform: Platform, in_downtime: bool) -> Vec<CloseAction> {
        let e = ex();
        processes_to_close(
            procs,
            &AppContext {
                bundle: b,
                pending,
                in_downtime,
                platform,
                exclusions: &e,
            },
        )
    }

    #[test]
    fn matching_signer_and_image_or_bundle_id() {
        let roblox = win(
            7,
            "RobloxPlayerBeta.exe",
            r"C:\Users\Kid\AppData\Local\Roblox\RobloxPlayerBeta.exe",
            Some("CN=Roblox Corporation, O=Roblox Corporation"),
        );
        assert!(app_matches(
            &app_ref(Some("Roblox Corporation"), Some("robloxplayerbeta.exe")),
            &roblox
        ));
        assert!(app_matches(&app_ref(Some("Roblox Corporation"), None), &roblox));
        assert!(app_matches(&app_ref(None, Some("RobloxPlayerBeta.exe")), &roblox));
        assert!(!app_matches(&app_ref(Some("Roblox Corporation"), Some("other.exe")), &roblox));
        assert!(
            !app_matches(&app_ref(Some("Roblox"), None), &roblox),
            "a prefix of the signer is not the signer"
        );
        assert!(!app_matches(&app_ref(Some("Roblox Corporation Fake"), None), &roblox));
        // An unsigned process has no signer to match.
        let unsigned = win(8, "RobloxPlayerBeta.exe", r"C:\x\RobloxPlayerBeta.exe", None);
        assert!(!app_matches(
            &app_ref(Some("Roblox Corporation"), Some("RobloxPlayerBeta.exe")),
            &unsigned
        ));
        assert!(app_matches(&app_ref(None, Some("RobloxPlayerBeta.exe")), &unsigned));
        // An empty ref matches nothing; so does a blank one.
        assert!(!app_matches(&AppRef::default(), &roblox));
        assert!(!app_matches(&app_ref(Some("  "), Some("")), &roblox));
        let m = mac(9, "/Applications/Roblox.app/Contents/MacOS/Roblox", Some("com.roblox.RobloxPlayer"));
        assert!(app_matches(&bundle_id("com.roblox.robloxplayer"), &m));
        assert!(!app_matches(&bundle_id("com.roblox"), &m));
        assert!(!app_matches(
            &bundle_id("com.roblox.RobloxPlayer"),
            &win(1, "x.exe", "C:\\x.exe", None)
        ));
    }

    #[test]
    fn blocked_apps_are_closed_on_windows() {
        let b = child(AppsRules {
            block: vec![app_ref(Some("Roblox Corporation"), Some("RobloxPlayerBeta.exe"))],
            ..Default::default()
        });
        let procs = [
            win(
                7,
                "RobloxPlayerBeta.exe",
                r"C:\Users\Kid\Roblox\RobloxPlayerBeta.exe",
                Some("CN=Roblox Corporation"),
            ),
            win(8, "notepad.exe", r"C:\Users\Kid\notepad.exe", None),
        ];
        let out = close(&b, &[], &procs, Platform::Windows, false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].pid, 7);
        assert_eq!(out[0].name, "RobloxPlayerBeta");
        assert_eq!(out[0].reason, CloseReason::Blocked);
    }

    #[test]
    fn nothing_is_closed_outside_child_mode() {
        let mut b = child(AppsRules {
            block: vec![app_ref(None, Some("game.exe"))],
            ..Default::default()
        });
        let procs = [win(7, "game.exe", r"C:\g\game.exe", None)];
        assert_eq!(close(&b, &[], &procs, Platform::Windows, false).len(), 1);
        for mode in ["standard", "elder", ""] {
            b.mode = mode.into();
            assert!(close(&b, &[], &procs, Platform::Windows, false).is_empty(), "{mode}");
        }
    }

    #[test]
    fn windows_protected_processes_are_never_closed() {
        // Even when the block list names them (a signer-only ref would match system files too).
        let b = child(AppsRules {
            block: vec![
                app_ref(None, Some("x.exe")),
                app_ref(Some("Microsoft Windows"), None),
                app_ref(None, Some("neo.exe")),
            ],
            ..Default::default()
        });
        let base = win(7, "x.exe", r"C:\Users\Kid\x.exe", None);
        assert_eq!(
            close(&b, &[], std::slice::from_ref(&base), Platform::Windows, false).len(),
            1,
            "control: closable"
        );
        let cases: Vec<(&str, ProcessInfo)> = vec![
            (
                "session 0",
                ProcessInfo {
                    session_id: Some(0),
                    ..base.clone()
                },
            ),
            (
                "session unknown",
                ProcessInfo {
                    session_id: None,
                    ..base.clone()
                },
            ),
            (
                "system owned",
                ProcessInfo {
                    system_owned: Some(true),
                    ..base.clone()
                },
            ),
            (
                "owner unknown",
                ProcessInfo {
                    system_owned: None,
                    ..base.clone()
                },
            ),
            ("under windir", win(7, "x.exe", r"C:\Windows\System32\x.exe", None)),
            (
                "under windir, other case and slashes",
                win(7, "x.exe", "c:/windows/temp/x.exe", None),
            ),
            (
                "no path",
                ProcessInfo {
                    image_path: String::new(),
                    ..base.clone()
                },
            ),
            ("system idle", ProcessInfo { pid: 0, ..base.clone() }),
            ("system", ProcessInfo { pid: 4, ..base.clone() }),
            ("the service", ProcessInfo { pid: 100, ..base.clone() }),
            ("its parent", ProcessInfo { pid: 101, ..base.clone() }),
            ("the tray app by name", win(7, "Neo.exe", r"C:\Users\Kid\neo.exe", None)),
            ("the service by name", win(7, "neo-agent.exe", r"C:\Users\Kid\neo-agent.exe", None)),
            ("neo's install directory", win(7, "x.exe", r"C:\Program Files\Neo\x.exe", None)),
        ];
        for (name, p) in cases {
            assert!(close(&b, &[], &[p], Platform::Windows, false).is_empty(), "{name}");
        }
        // A sibling directory with the same prefix is not under the Windows directory.
        assert_eq!(
            close(&b, &[], &[win(7, "x.exe", r"C:\WindowsApps\x.exe", None)], Platform::Windows, false).len(),
            1
        );
        // With no Windows directory known the rule cannot be evaluated, so nothing is closed.
        let mut e = ex();
        e.windir.clear();
        let ctx = AppContext {
            bundle: &b,
            pending: &[],
            in_downtime: false,
            platform: Platform::Windows,
            exclusions: &e,
        };
        assert!(processes_to_close(std::slice::from_ref(&base), &ctx).is_empty());
    }

    #[test]
    fn mac_protected_processes_are_never_closed() {
        let b = child(AppsRules {
            block: vec![
                bundle_id("com.apple.Safari"),
                bundle_id("com.game.Game"),
                bundle_id("dev.neoshield.desktop"),
            ],
            ..Default::default()
        });
        let game = mac(7, "/Applications/Game.app/Contents/MacOS/Game", Some("com.game.Game"));
        assert_eq!(
            close(&b, &[], std::slice::from_ref(&game), Platform::Mac, false).len(),
            1,
            "control: closable"
        );
        let cases: Vec<(&str, ProcessInfo)> = vec![
            (
                "system path",
                mac(7, "/System/Applications/Safari.app/Contents/MacOS/Safari", Some("com.apple.Safari")),
            ),
            (
                "cryptex Safari, apple-signed",
                ProcessInfo {
                    apple_signed: Some(true),
                    ..mac(
                        7,
                        "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari",
                        Some("com.apple.Safari"),
                    )
                },
            ),
            ("/usr", mac(7, "/usr/libexec/x", Some("com.game.Game"))),
            (
                "apple signed anywhere",
                ProcessInfo {
                    apple_signed: Some(true),
                    ..game.clone()
                },
            ),
            (
                "apple signature unknown",
                ProcessInfo {
                    apple_signed: None,
                    ..game.clone()
                },
            ),
            (
                "root owned",
                ProcessInfo {
                    system_owned: Some(true),
                    ..game.clone()
                },
            ),
            (
                "owner unknown",
                ProcessInfo {
                    system_owned: None,
                    ..game.clone()
                },
            ),
            ("launchd", ProcessInfo { pid: 1, ..game.clone() }),
            ("the daemon", ProcessInfo { pid: 100, ..game.clone() }),
            (
                "the tray app",
                mac(7, "/Applications/Neo.app/Contents/MacOS/Neo", Some("dev.neoshield.desktop")),
            ),
            (
                "neo's bundle id elsewhere",
                mac(7, "/Users/kid/Neo2/Neo", Some("dev.neoshield.desktop")),
            ),
        ];
        for (name, p) in cases {
            assert!(close(&b, &[], &[p], Platform::Mac, false).is_empty(), "{name}");
        }
        // Homebrew-style tools under /usr/local are the person's own.
        let local = mac(7, "/usr/local/bin/game", Some("com.game.Game"));
        assert_eq!(close(&b, &[], &[local], Platform::Mac, false).len(), 1);
    }

    #[test]
    fn approved_apps_win_over_the_block_list_and_pending() {
        let r = app_ref(Some("Roblox Corporation"), Some("RobloxPlayerBeta.exe"));
        let b = child(AppsRules {
            block: vec![r.clone()],
            approved: vec![app_ref(None, Some("robloxplayerbeta.exe"))],
            require_approval: true,
        });
        let p = win(
            7,
            "RobloxPlayerBeta.exe",
            r"C:\g\RobloxPlayerBeta.exe",
            Some("CN=Roblox Corporation"),
        );
        assert!(close(&b, &[], std::slice::from_ref(&p), Platform::Windows, false).is_empty());
        let pending = [PendingApp {
            name: "Roblox".into(),
            app: r,
            since: 1,
        }];
        assert!(close(&b, &pending, &[p], Platform::Windows, false).is_empty());
    }

    #[test]
    fn allow_during_downtime_only_holds_during_downtime() {
        let zoom = app_ref(Some("Zoom Video Communications"), Some("Zoom.exe"));
        let b = PolicyBundle {
            screen_time: ScreenTimeRules {
                allow_during_downtime: vec![zoom.clone()],
                downtime: vec![DowntimeWindow {
                    start: "21:00".into(),
                    end: "07:00".into(),
                }],
                ..Default::default()
            },
            ..child(AppsRules {
                block: vec![zoom],
                ..Default::default()
            })
        };
        let p = win(7, "Zoom.exe", r"C:\z\Zoom.exe", Some("CN=Zoom Video Communications, Inc."));
        assert!(
            close(&b, &[], std::slice::from_ref(&p), Platform::Windows, true).is_empty(),
            "during downtime"
        );
        assert_eq!(
            close(&b, &[], &[p], Platform::Windows, false).len(),
            1,
            "outside downtime it is still blocked"
        );
    }

    #[test]
    fn apps_waiting_for_approval_are_closed_only_when_approval_is_required() {
        let new_app = app_ref(Some("Epic Games, Inc."), Some("EpicGamesLauncher.exe"));
        let pending = [PendingApp {
            name: "Epic Games Launcher".into(),
            app: new_app,
            since: 5,
        }];
        let p = win(
            7,
            "EpicGamesLauncher.exe",
            r"C:\e\EpicGamesLauncher.exe",
            Some("CN=Epic Games, Inc."),
        );
        let mut b = child(AppsRules {
            require_approval: true,
            ..Default::default()
        });
        let out = close(&b, &pending, std::slice::from_ref(&p), Platform::Windows, false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].reason, CloseReason::AwaitingApproval);
        assert_eq!(out[0].name, "Epic Games Launcher");
        // The 14 to 17 band: notify only, nothing is held.
        b.apps.require_approval = false;
        assert!(close(&b, &pending, &[p], Platform::Windows, false).is_empty());
    }

    #[test]
    fn only_processes_the_policy_names_are_candidates() {
        let blocked = app_ref(None, Some("game.exe"));
        let waiting = PendingApp {
            name: "Epic".into(),
            app: app_ref(None, Some("epic.exe")),
            since: 1,
        };
        let procs = [
            win(1, "game.exe", r"C:\g\game.exe", None),
            win(2, "epic.exe", r"C:\e\epic.exe", None),
            win(3, "notepad.exe", r"C:\n\notepad.exe", None),
        ];
        let mut b = child(AppsRules {
            block: vec![blocked],
            require_approval: true,
            ..Default::default()
        });
        let pids = |v: Vec<ProcessInfo>| v.iter().map(|p| p.pid).collect::<Vec<_>>();
        assert_eq!(pids(candidates(&procs, &b, std::slice::from_ref(&waiting))), [1, 2]);
        b.apps.require_approval = false;
        assert_eq!(pids(candidates(&procs, &b, std::slice::from_ref(&waiting))), [1]);
        b.mode = "standard".into();
        assert!(candidates(&procs, &b, &[waiting]).is_empty());
    }

    #[test]
    fn approval_clears_a_pending_app() {
        let app = app_ref(Some("Epic Games, Inc."), Some("EpicGamesLauncher.exe"));
        let mut pending = vec![
            PendingApp {
                name: "Epic".into(),
                app: app.clone(),
                since: 1,
            },
            PendingApp {
                name: "Other".into(),
                app: app_ref(Some("Other Co"), Some("o.exe")),
                since: 2,
            },
        ];
        let mut b = child(AppsRules {
            approved: vec![app.clone()],
            ..Default::default()
        });
        prune_pending(&mut pending, &b);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].name, "Other");
        // A signer-only approval covers every app with that signer.
        b.apps.approved = vec![app_ref(Some("other co"), None)];
        prune_pending(&mut pending, &b);
        assert!(pending.is_empty());
        // Bundle ids.
        let mut pending = vec![PendingApp {
            name: "G".into(),
            app: bundle_id("com.g.G"),
            since: 1,
        }];
        b.apps.approved = vec![bundle_id("COM.G.G")];
        prune_pending(&mut pending, &b);
        assert!(pending.is_empty());
        // The list is capped (the oldest go first).
        let many: Vec<PendingApp> = (0..60)
            .map(|i| PendingApp {
                name: format!("a{i}"),
                app: bundle_id(&format!("com.a.a{i}")),
                since: i,
            })
            .collect();
        let mut pending = many;
        prune_pending(&mut pending, &PolicyBundle::default());
        assert_eq!(pending.len(), MAX_PENDING);
        assert_eq!(pending[0].name, "a10");
    }

    fn entry(name: &str, publisher: &str, loc: Option<&str>) -> UninstallEntry {
        UninstallEntry {
            display_name: name.into(),
            publisher: Some(publisher.into()),
            install_location: loc.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn the_first_list_is_the_baseline_and_later_ones_report_new_apps() {
        let mut inv = Inventory::default();
        let a = installed_from_uninstall(&[entry("Chrome", "Google LLC", Some(r"C:\c")), entry("Steam", "Valve", Some(r"C:\s"))]);
        assert_eq!(a.len(), 2);
        assert!(inv.observe(&a, 1000).is_empty(), "baseline");
        assert!(inv.is_baselined());
        assert!(inv.observe(&a, 1100).is_empty());
        let mut b = a.clone();
        b.extend(installed_from_uninstall(&[entry(
            "Roblox Player",
            "Roblox Corporation",
            Some(r"C:\r"),
        )]));
        let fresh = inv.observe(&b, 1200);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].name, "Roblox Player");
        assert!(inv.observe(&b, 1300).is_empty(), "reported once");
    }

    #[test]
    fn a_failed_read_does_not_make_everything_new() {
        let mut inv = Inventory::default();
        let all = installed_from_uninstall(&[entry("Chrome", "Google", Some("c")), entry("Steam", "Valve", Some("s"))]);
        inv.observe(&all, 0);
        // An empty list changes nothing.
        assert!(inv.observe(&[], 100).is_empty());
        assert!(inv.observe(&all, 200).is_empty());
        // One hive missing for one pass: the app is remembered and is not new when it returns.
        assert!(inv.observe(&all[..1], 300).is_empty());
        assert!(inv.observe(&all, 400).is_empty());
        // Gone for over a week, then back: a reinstall.
        assert!(inv.observe(&all[..1], 400 + 8 * 86_400).is_empty());
        assert_eq!(inv.observe(&all, 400 + 8 * 86_400 + 10).len(), 1);
    }

    #[test]
    fn entries_without_a_program_to_find_are_skipped() {
        let apps = installed_from_uninstall(&[
            entry("Update for X (KB1)", "Microsoft", None),
            entry("Real App", "Co", Some(r"C:\a")),
        ]);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].name, "Real App");
    }

    #[test]
    fn mac_bundles_are_keyed_by_bundle_id_and_apple_apps_are_skipped() {
        let apple = AppBundle {
            path: "/System/Applications/Notes.app".into(),
            bundle_id: Some("com.apple.Notes".into()),
            name: "Notes".into(),
            signing_id: Some("com.apple.Notes".into()),
            ..Default::default()
        };
        let game = AppBundle {
            path: "/Applications/Game.app".into(),
            bundle_id: Some("com.game.Game".into()),
            name: "Game".into(),
            team_id: Some("ABCDE12345".into()),
            ..Default::default()
        };
        let nobundle = AppBundle {
            path: "/Applications/X.app".into(),
            name: "X".into(),
            ..Default::default()
        };
        let apps = installed_from_bundles(&[apple, game, nobundle]);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].key, "com.game.game");
        assert_eq!(apps[0].bundle_id.as_deref(), Some("com.game.Game"));
    }
}
