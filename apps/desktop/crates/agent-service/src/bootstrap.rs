//! Wiring the real parts together. Behind the `http` feature because it needs the real HTTP
//! client.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use neo_agent_core::api::UreqTransport;

use crate::agent::{Agent, Deps, DynTransport, NullNotifier, SystemClock};
use crate::config;
use crate::net::UreqDownloader;
use crate::persist::DataDir;
use crate::probe::DevProbe;
use crate::secrets::{FileSecretStore, PlainProtector};
use crate::update::{Installer, StandardUpdater, UpdateError};

fn transport() -> DynTransport {
    DynTransport(Arc::new(UreqTransport::new(&format!("neo-agent/{}", config::VERSION))))
}

/// Never installs anything (development).
struct NoInstaller;

impl Installer for NoInstaller {
    fn own_signer(&self) -> Option<String> {
        None
    }
    fn signer_of(&self, _msi: &Path) -> Option<String> {
        None
    }
    fn install(&self, _msi: &Path) -> Result<(), UpdateError> {
        Err(UpdateError::Install("not supported on this platform".into()))
    }
}

/// An agent for Linux development: the machine is a snapshot file, the token is stored unencrypted
/// in the data directory, and nothing is ever installed.
pub fn dev_agent(data_dir: &Path, snapshot: Option<PathBuf>) -> Arc<Agent> {
    let dir = DataDir::new(data_dir);
    let _ = dir.ensure();
    Arc::new(Agent::new(
        Deps {
            probe: Box::new(DevProbe { snapshot_file: snapshot }),
            secrets: Box::new(FileSecretStore::new(dir.clone(), PlainProtector)),
            notifier: Box::new(NullNotifier),
            clock: Box::new(SystemClock),
            transport: transport(),
            updater: Box::new(StandardUpdater {
                manifest_url: config::UPDATE_URL.to_string(),
                pubkey: None,
                platform: config::UPDATE_PLATFORM.to_string(),
                stage_dir: dir.updates_dir(),
                allow_unsigned: false,
                downloader: UreqDownloader::default(),
                installer: NoInstaller,
            }),
        },
        dir,
    ))
}

/// The real Windows agent.
#[cfg(windows)]
pub fn windows_agent(data_dir: &Path) -> Arc<Agent> {
    use crate::windows::{dpapi::DpapiProtector, installer::MsiInstaller, notify::WtsNotifier, probe::WindowsProbe};

    let dir = DataDir::new(data_dir);
    Arc::new(Agent::new(
        Deps {
            probe: Box::new(WindowsProbe::new()),
            secrets: Box::new(FileSecretStore::new(dir.clone(), DpapiProtector)),
            notifier: Box::new(WtsNotifier),
            clock: Box::new(SystemClock),
            transport: transport(),
            updater: Box::new(StandardUpdater {
                manifest_url: config::UPDATE_URL.to_string(),
                pubkey: config::UPDATE_PUBKEY.map(str::to_string),
                platform: config::UPDATE_PLATFORM.to_string(),
                stage_dir: dir.updates_dir(),
                allow_unsigned: config::ALLOW_UNSIGNED_UPDATE,
                downloader: UreqDownloader::default(),
                installer: MsiInstaller {
                    log_path: dir.logs_dir().join("msi-update.log"),
                },
            }),
        },
        dir,
    ))
}

/// The default Windows data directory (`%ProgramData%\Neo`).
pub fn windows_data_dir() -> PathBuf {
    match std::env::var_os("ProgramData") {
        Some(p) => PathBuf::from(p).join("Neo"),
        None => PathBuf::from(config::WINDOWS_DATA_DIR),
    }
}
