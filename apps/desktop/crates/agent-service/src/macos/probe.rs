//! The macOS implementation of [`SystemProbe`]: libproc processes, `.app` bundles, launchd items,
//! files, the unified log and the TCC databases. The decisions live in the portable modules; this
//! file only wires them to the Security framework and libproc.

use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use neo_agent_core::detect::ExeHint;
use neo_agent_core::lists::PathEnv;
use neo_agent_core::snapshot::{
    AppBundle, EventLogRecord, ExeFacts, ProcessInfo, ServiceInfo, TccSnapshot, UnifiedLogRecord, UninstallEntry,
};
use time::OffsetDateTime;

use crate::inspect;
use crate::probe::{FileStat, SystemProbe};

use super::bundles::{self, IdentCache, LocalUser};
use super::codesign::{self, CodeInfo};
use super::{exec, procs, tcc, unifiedlog};

const USERS: &str = "/Users";
const APPLICATIONS: &str = "/Applications";
const LIBRARY: &str = "/Library";
/// At most this many bundles are listed per scan.
const MAX_BUNDLES: usize = 1500;
/// At most this many bundles are hashed per scan.
const MAX_FACTS: usize = 50;

/// What a process contributes to matching.
#[derive(Clone, Default)]
struct ProcIdent {
    bundle_id: Option<String>,
    team_id: Option<String>,
}

pub struct MacProbe {
    procs: Mutex<IdentCache<ProcIdent>>,
    bundles: Mutex<IdentCache<(Option<bundles::BundleInfo>, CodeInfo)>>,
    /// Private directory for the WAL-aware copy of a TCC database.
    scratch: PathBuf,
    /// The TCC schema was not understood: detection stays off for this run.
    tcc_disabled: AtomicBool,
    /// The first successful read has been logged.
    tcc_logged: AtomicBool,
}

impl MacProbe {
    pub fn new(data_dir: &Path) -> Self {
        MacProbe {
            procs: Mutex::new(IdentCache::default()),
            bundles: Mutex::new(IdentCache::default()),
            scratch: data_dir.join("tmp"),
            tcc_disabled: AtomicBool::new(false),
            tcc_logged: AtomicBool::new(false),
        }
    }

    fn users(&self) -> Vec<LocalUser> {
        bundles::local_users(Path::new(USERS))
    }

    /// Bundle id and Team ID for the executable at `exe`, cached by path, size and modified time.
    fn proc_ident(&self, exe: &str) -> ProcIdent {
        let path = Path::new(exe);
        let Some((size, mtime)) = inspect::file_identity(path) else {
            return ProcIdent::default();
        };
        let bundle = bundles::bundle_of(path);
        let target = bundle.clone().unwrap_or_else(|| path.to_path_buf());
        let key = target.to_string_lossy().to_string();
        let mut cache = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        cache.get_or_compute(&key, size, mtime, || ProcIdent {
            bundle_id: bundle.as_deref().and_then(bundles::read_bundle_info).and_then(|i| i.bundle_id),
            team_id: codesign::inspect(&target).team_id,
        })
    }

    /// Info.plist and signature facts of a bundle, cached on its main executable's identity.
    fn bundle_facts(&self, app: &Path) -> (Option<bundles::BundleInfo>, CodeInfo, Option<PathBuf>) {
        let info = bundles::read_bundle_info(app);
        let exe = bundles::main_executable(app, info.as_ref());
        let (size, mtime) = exe.as_deref().and_then(inspect::file_identity).unwrap_or((0, 0));
        let key = app.to_string_lossy().to_string();
        let mut cache = self.bundles.lock().unwrap_or_else(|e| e.into_inner());
        let (info, code) = cache.get_or_compute(&key, size, mtime, || (info, codesign::inspect(app)));
        (info, code, exe)
    }
}

fn macos_version() -> String {
    exec::run_capped("/usr/bin/sw_vers", &["-productVersion".to_string()], Duration::from_secs(5), 256)
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

impl SystemProbe for MacProbe {
    fn computer_name(&self) -> String {
        exec::run_capped(
            "/usr/sbin/scutil",
            &["--get".to_string(), "ComputerName".to_string()],
            Duration::from_secs(5),
            512,
        )
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Mac".to_string())
    }

    fn path_env(&self) -> PathEnv {
        PathEnv {
            homes: self.users().into_iter().map(|u| u.home.to_string_lossy().to_string()).collect(),
            ..Default::default()
        }
    }

    fn processes(&self) -> Vec<ProcessInfo> {
        let mut out = Vec::new();
        for pid in procs::list_pids() {
            let Some(path) = procs::pid_path(pid) else { continue };
            let image_name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let ident = if bundles::is_system_path(&path) {
                ProcIdent::default()
            } else {
                self.proc_ident(&path)
            };
            out.push(ProcessInfo {
                pid: pid as u32,
                image_name,
                image_path: path,
                signer: None,
                team_id: ident.team_id,
                bundle_id: ident.bundle_id,
            });
        }
        out
    }

    fn uninstall_entries(&self) -> Vec<UninstallEntry> {
        Vec::new()
    }

    fn services(&self) -> Vec<ServiceInfo> {
        let dirs = bundles::launchd_dirs(Path::new(LIBRARY), &self.users());
        bundles::launchd_items(&dirs)
    }

    fn file_stat(&self, path: &str) -> Option<FileStat> {
        let m = std::fs::metadata(path).ok()?;
        m.is_file().then(|| FileStat {
            len: m.len(),
            // A rotated or replaced log is a new inode.
            token: Some(m.ino().to_string()),
        })
    }

    fn read_range(&self, path: &str, start: u64, len: u64) -> io::Result<Vec<u8>> {
        let mut f = std::fs::File::open(path)?;
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        f.take(len).read_to_end(&mut buf)?;
        Ok(buf)
    }

    fn event_records(&self, _channel: &str, _event_ids: &[u32], _since_unix: i64) -> Vec<EventLogRecord> {
        Vec::new()
    }

    fn exe_facts(&self, _hints: &[ExeHint]) -> Vec<ExeFacts> {
        Vec::new()
    }

    fn platform(&self) -> &'static str {
        "macos"
    }

    fn app_bundles(&self) -> Vec<AppBundle> {
        let users = self.users();
        let mut out = Vec::new();
        for dir in bundles::app_dirs(Path::new(APPLICATIONS), &users) {
            for app in bundles::list_apps(&dir) {
                if out.len() >= MAX_BUNDLES {
                    return out;
                }
                let (info, code, _exe) = self.bundle_facts(&app);
                let Some(info) = info else { continue };
                out.push(AppBundle {
                    path: app.to_string_lossy().to_string(),
                    bundle_id: info.bundle_id,
                    name: info.name,
                    version: info.version,
                    team_id: code.team_id,
                    signing_id: code.identifier,
                    signer: code.signer,
                });
            }
        }
        out
    }

    fn bundle_exe_facts(&self, paths: &[String]) -> Vec<ExeFacts> {
        let mut out = Vec::new();
        for p in paths.iter().take(MAX_FACTS) {
            let app = Path::new(p);
            let (_info, code, exe) = self.bundle_facts(app);
            let Some(exe) = exe else { continue };
            let Ok(sha256) = inspect::hash_file(&exe) else { continue };
            out.push(ExeFacts {
                path: exe.to_string_lossy().to_string(),
                sha256,
                signed_trusted: code.developer_id,
                signer: code.signer,
            });
        }
        out
    }

    fn unified_log(&self, predicates: &[String]) -> Vec<UnifiedLogRecord> {
        unifiedlog::query(predicates, OffsetDateTime::now_utc())
    }

    fn full_disk_access(&self) -> Option<bool> {
        tcc::can_read(Path::new(tcc::SYSTEM_DB))
    }

    fn tcc(&self) -> Option<TccSnapshot> {
        if self.tcc_disabled.load(Ordering::SeqCst) {
            return None;
        }
        let users: Vec<(u32, PathBuf)> = self.users().into_iter().map(|u| (u.uid, u.home)).collect();
        let pass = tcc::read_all(Path::new(tcc::SYSTEM_DB), &users, &self.scratch);
        if let Some(why) = pass.unsupported {
            // Fails open: the other detectors are unaffected. Logged once, with the macOS version
            // the verification task needs to record a new fixture.
            if !self.tcc_disabled.swap(true, Ordering::SeqCst) {
                log::warn!(
                    "the TCC database is not in a shape this agent understands (macOS {}): {why}; permission checks are off",
                    macos_version()
                );
            }
            return None;
        }
        if pass.denied || pass.snapshot.dbs_read.is_empty() {
            return None;
        }
        if !self.tcc_logged.swap(true, Ordering::SeqCst) {
            // Counts only, never what the rows say.
            log::info!(
                "TCC databases read: {} database(s), {} row(s)",
                pass.snapshot.dbs_read.len(),
                pass.snapshot.rows.len()
            );
        }
        Some(pass.snapshot)
    }
}
