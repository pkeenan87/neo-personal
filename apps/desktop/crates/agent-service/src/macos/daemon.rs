//! The launchd entry: runs in the foreground (launchd is the supervisor), stops on SIGTERM, serves
//! the socket, and watches for `Neo.app` being moved to the Trash.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::time::Duration;

use crate::agent::Agent;
use crate::config;
use crate::ipc::serve_unix_checked;
use crate::logging::FileLogger;
use crate::persist::DataDir;

use super::peer::GetPeerEid;
use super::trash::{TrashWatch, Verdict, app_matches, check_interval_secs, remove_self, spawn_uninstall_script};
use super::{codesign, installer, perms};

/// Set by the signal handler (an atomic store is async-signal-safe).
static STOP: AtomicPtr<AtomicBool> = AtomicPtr::new(std::ptr::null_mut());

extern "C" fn on_signal(_sig: libc::c_int) {
    let p = STOP.load(Ordering::SeqCst);
    if !p.is_null() {
        // SAFETY: the pointer comes from a leaked `Arc` that is never freed.
        unsafe { (*p).store(true, Ordering::SeqCst) };
    }
}

fn install_signal_handlers(stop: &Arc<AtomicBool>) {
    STOP.store(Arc::into_raw(stop.clone()) as *mut AtomicBool, Ordering::SeqCst);
    let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
    // SAFETY: installing a handler that only does an atomic store.
    unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Sleeps `secs` in one-second steps, returning early (true) when `stop` is set.
fn sleep_or_stop(secs: u64, stop: &AtomicBool) -> bool {
    for _ in 0..secs {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    stop.load(Ordering::SeqCst)
}

/// The Trash rule: every few seconds check that `/Applications/Neo.app` exists with our signer;
/// when it has been gone for the grace period, unenroll and remove.
fn watch_tray_app(agent: Arc<Agent>, stop: Arc<AtomicBool>) {
    let own_team = installer::own_team_id();
    let grace = config::TRASH_GRACE_SECS;
    let every = check_interval_secs(grace);
    let mut watch = TrashWatch::new(grace);
    log::info!("watching {} (grace {grace}s, every {every}s)", config::MACOS_TRAY_APP);
    loop {
        if sleep_or_stop(every, &stop) {
            return;
        }
        let app = Path::new(config::MACOS_TRAY_APP);
        let exists = app.exists();
        let app_team = if exists { codesign::inspect(app).team_id } else { None };
        let present = app_matches(exists, own_team.as_deref(), app_team.as_deref());
        match watch.observe(now_unix(), present) {
            Verdict::Present => {}
            Verdict::Waiting { missing_for_secs } => {
                log::info!("{} is missing or replaced ({missing_for_secs}s so far)", config::MACOS_TRAY_APP);
            }
            Verdict::Remove => {
                let script = PathBuf::from(config::MACOS_UNINSTALL_SCRIPT);
                if let Err(e) = remove_self(&agent, || spawn_uninstall_script(&script)) {
                    log::error!("could not start the uninstall script: {e}");
                }
                // The script boots this daemon out (SIGTERM); until then there is nothing left to do.
                return;
            }
        }
    }
}

/// Runs the daemon until SIGTERM, or until the agent asks to be relaunched. `console` logs to
/// stderr as well and uses `data_dir` (default: the root-only system directory).
pub fn run(console: bool, data_dir: Option<PathBuf>) -> ExitCode {
    perms::private_umask();
    let data_dir = data_dir.unwrap_or_else(|| PathBuf::from(config::MACOS_DATA_DIR));
    // Lock the directory down before anything is created in it.
    if let Err(e) = perms::secure_data_dir(&data_dir, perms::root_owner()) {
        eprintln!("could not secure the data directory {}: {e}", data_dir.display());
        return ExitCode::from(1);
    }
    let dir = DataDir::new(&data_dir);
    let _ = dir.ensure();
    FileLogger::init(&dir.logs_dir(), console);
    log::info!("neo-agent {} starting", config::VERSION);

    let stop = Arc::new(AtomicBool::new(false));
    install_signal_handlers(&stop);
    let agent = crate::bootstrap::macos_agent(&data_dir);

    {
        let (agent, stop) = (agent.clone(), stop.clone());
        std::thread::spawn(move || watch_tray_app(agent, stop));
    }

    let peer: Arc<dyn crate::ipc::PeerCheck> = Arc::new(GetPeerEid);
    crate::runtime::run_loop(
        agent,
        stop,
        move |agent, stop| {
            let socket = Path::new(config::MACOS_SOCKET_PATH);
            if let Err(e) = serve_unix_checked(agent, socket, stop, Some(peer)) {
                log::error!("the socket server stopped: {e}");
            }
        },
        || {},
    );
    log::info!("neo-agent stopping");
    ExitCode::SUCCESS
}
