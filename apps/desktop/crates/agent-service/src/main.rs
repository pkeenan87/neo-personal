//! `neo-agent`: the Neo Protection service. See `neo_agent` (the library) for everything it does.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use neo_agent::cli::{self, Command, USAGE};
use neo_agent::logging::FileLogger;
use neo_agent::persist::DataDir;

fn main() -> ExitCode {
    let command = match cli::parse(std::env::args().skip(1)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match command {
        Command::Version => {
            println!("neo-agent {}", neo_agent::config::VERSION);
            ExitCode::SUCCESS
        }
        Command::Service => run_service(),
        Command::Console { data_dir } => run_console(data_dir),
        Command::Unenroll { data_dir } => unenroll(data_dir),
        Command::DevPipe { path, data_dir, snapshot } => dev_pipe(path, data_dir, snapshot),
    }
}

fn data_dir_or_default(dir: Option<PathBuf>) -> PathBuf {
    dir.unwrap_or_else(default_data_dir)
}

#[cfg(windows)]
fn default_data_dir() -> PathBuf {
    neo_agent::bootstrap::windows_data_dir()
}

#[cfg(target_os = "macos")]
fn default_data_dir() -> PathBuf {
    PathBuf::from(neo_agent::config::MACOS_DATA_DIR)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn default_data_dir() -> PathBuf {
    std::env::temp_dir().join("neo-agent-dev")
}

#[cfg(windows)]
fn entry(stop: Arc<AtomicBool>) {
    use neo_agent::windows::pipe;

    let data_dir = default_data_dir();
    let dir = DataDir::new(&data_dir);
    // Secure the folder before anything is created in it, so every child inherits the ACL.
    let _ = std::fs::create_dir_all(&data_dir);
    let secured = neo_agent::windows::acl::secure_dir(&data_dir);
    let _ = dir.ensure();
    FileLogger::init(&dir.logs_dir(), false);
    if let Err(e) = secured {
        log::error!("could not restrict the data directory: {e}");
    }
    log::info!("neo-agent {} starting", neo_agent::config::VERSION);
    let agent = neo_agent::bootstrap::windows_agent(&data_dir);
    neo_agent::runtime::run_loop(agent, stop, pipe::serve, pipe::wake);
    log::info!("neo-agent stopping");
}

#[cfg(windows)]
fn run_service() -> ExitCode {
    match neo_agent::windows::service::run(entry) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("This program is the Neo Protection service and is started by Windows. To run it by hand use --console.\n({e})");
            ExitCode::from(1)
        }
    }
}

/// Started by launchd with no arguments: the daemon, in the foreground.
#[cfg(target_os = "macos")]
fn run_service() -> ExitCode {
    neo_agent::macos::daemon::run(false, None)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn run_service() -> ExitCode {
    eprintln!("The Windows service and the macOS daemon only run on their own systems.\n\n{USAGE}");
    ExitCode::from(2)
}

#[cfg(windows)]
fn run_console(data_dir: Option<PathBuf>) -> ExitCode {
    let data_dir = data_dir_or_default(data_dir);
    let dir = DataDir::new(&data_dir);
    let _ = dir.ensure();
    let _ = neo_agent::windows::acl::secure_dir(&data_dir);
    FileLogger::init(&dir.logs_dir(), true);
    let agent = neo_agent::bootstrap::windows_agent(&data_dir);
    // Foreground: Ctrl+C ends the process.
    neo_agent::runtime::run_loop(
        agent,
        Arc::new(AtomicBool::new(false)),
        neo_agent::windows::pipe::serve,
        neo_agent::windows::pipe::wake,
    );
    ExitCode::SUCCESS
}

#[cfg(target_os = "macos")]
fn run_console(data_dir: Option<PathBuf>) -> ExitCode {
    neo_agent::macos::daemon::run(true, data_dir)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn run_console(_data_dir: Option<PathBuf>) -> ExitCode {
    eprintln!("--console runs the Windows or macOS agent. On Linux use --dev-pipe <socket>.");
    ExitCode::from(2)
}

#[cfg(windows)]
fn unenroll(data_dir: Option<PathBuf>) -> ExitCode {
    let data_dir = data_dir_or_default(data_dir);
    let dir = DataDir::new(&data_dir);
    let _ = dir.ensure();
    FileLogger::init(&dir.logs_dir(), true);
    neo_agent::bootstrap::windows_agent(&data_dir).unenroll_for_uninstall();
    // Whatever happened, the uninstall must go on.
    ExitCode::SUCCESS
}

#[cfg(target_os = "macos")]
fn unenroll(data_dir: Option<PathBuf>) -> ExitCode {
    // `uninstall.sh` runs this as root: tell the server, forget the token, never fail the uninstall.
    neo_agent::macos::perms::private_umask();
    let data_dir = data_dir_or_default(data_dir);
    let dir = DataDir::new(&data_dir);
    let _ = dir.ensure();
    FileLogger::init(&dir.logs_dir(), true);
    neo_agent::bootstrap::macos_agent(&data_dir).unenroll_for_uninstall();
    ExitCode::SUCCESS
}

#[cfg(not(any(windows, target_os = "macos")))]
fn unenroll(data_dir: Option<PathBuf>) -> ExitCode {
    let data_dir = data_dir_or_default(data_dir);
    neo_agent::bootstrap::dev_agent(&data_dir, None).unenroll_for_uninstall();
    ExitCode::SUCCESS
}

#[cfg(unix)]
fn dev_pipe(path: PathBuf, data_dir: Option<PathBuf>, snapshot: Option<PathBuf>) -> ExitCode {
    let data_dir = data_dir_or_default(data_dir);
    FileLogger::init(&DataDir::new(&data_dir).logs_dir(), true);
    let agent = neo_agent::bootstrap::dev_agent(&data_dir, snapshot);
    eprintln!("neo-agent dev mode: serving {} (data in {})", path.display(), data_dir.display());
    let socket = path.clone();
    let stop = Arc::new(AtomicBool::new(false));
    neo_agent::runtime::run_loop(
        agent,
        stop,
        move |agent, stop| {
            if let Err(e) = neo_agent::ipc::serve_unix(agent, &socket, stop) {
                eprintln!("pipe server stopped: {e}");
            }
        },
        || {},
    );
    ExitCode::SUCCESS
}

#[cfg(not(unix))]
fn dev_pipe(_path: PathBuf, _data_dir: Option<PathBuf>, _snapshot: Option<PathBuf>) -> ExitCode {
    eprintln!("--dev-pipe is for Linux development; the Windows service uses the real named pipe.");
    ExitCode::from(2)
}
