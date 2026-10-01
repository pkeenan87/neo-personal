//! Build-time configuration. Everything here is a compiled-in default; nothing is read from the
//! environment at run time (a local user must not be able to redirect the service).

/// The service's version, also sent as `clientVersion`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Windows service name, display name and description (shown in `services.msc`).
pub const SERVICE_NAME: &str = "NeoAgent";
pub const SERVICE_DISPLAY_NAME: &str = "Neo Protection";
pub const SERVICE_DESCRIPTION: &str =
    "Warns the people on this computer, and the household owner, when a remote-access scam tool appears. Part of Neo.";

/// The pipe the tray app talks to.
pub const PIPE_NAME: &str = r"\\.\pipe\neo-agent";

/// Windows data directory.
pub const WINDOWS_DATA_DIR: &str = r"C:\ProgramData\Neo";

/// `NEO_BASE_URL` at build time overrides the server (self-hosters).
pub const DEFAULT_BASE_URL: &str = match option_env!("NEO_BASE_URL") {
    Some(u) => u,
    None => "https://www.neoshield.dev",
};

/// `NEO_DESKTOP_UPDATE_URL` at build time overrides the update manifest (self-hosters, CI).
pub const UPDATE_URL: &str = match option_env!("NEO_DESKTOP_UPDATE_URL") {
    Some(u) => u,
    None => "https://github.com/pkeenan87/neo-personal/releases/download/desktop-latest/latest.json",
};

/// The minisign public key, in the format of `plugins.updater.pubkey` in `tauri.conf.json` (the
/// base64 of the `.pub` file). Updates are off when it was not compiled in.
pub const UPDATE_PUBKEY: Option<&str> = option_env!("NEO_DESKTOP_UPDATE_PUBKEY");

/// Build-time switch for CI: when this agent is itself unsigned, accept an unsigned update MSI.
/// Release builds never set it; a signed agent always requires the same signer.
pub const ALLOW_UNSIGNED_UPDATE: bool = option_env!("NEO_ALLOW_UNSIGNED_UPDATE").is_some();

/// The key in `latest.json` `platforms`.
pub const UPDATE_PLATFORM: &str = "windows-x86_64";
