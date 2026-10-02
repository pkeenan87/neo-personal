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
#[cfg(target_os = "macos")]
pub const UPDATE_PLATFORM: &str = "darwin-universal";
#[cfg(not(target_os = "macos"))]
pub const UPDATE_PLATFORM: &str = "windows-x86_64";

// ---- macOS (spec `_specs/desktop-agent-macos.md`) ----------------------------------------------

/// The unix socket the tray app talks to (mode 0666, owned by root).
pub const MACOS_SOCKET_PATH: &str = "/var/run/neo-agent.sock";
/// Root-only (0700) data directory; `device.json` and the state files live here.
pub const MACOS_DATA_DIR: &str = "/Library/Application Support/Neo/data";
/// The daemon's own signed bundle: what the person selects in the Full Disk Access list.
pub const MACOS_DAEMON_BUNDLE: &str = "/Library/Application Support/Neo/Neo Protection.app";
/// Removes everything; also run from Terminal and by the tray's "Uninstall Neo...".
pub const MACOS_UNINSTALL_SCRIPT: &str = "/Library/Application Support/Neo/Neo Protection.app/Contents/Resources/uninstall.sh";
/// The tray app. Moving it to the Trash counts as an uninstall.
pub const MACOS_TRAY_APP: &str = "/Applications/Neo.app";

/// Build-time `NEO_TRASH_GRACE_SECS` (CI only) shortens how long `/Applications/Neo.app` may be
/// missing before the daemon unenrolls and removes itself. Default 10 minutes.
pub const TRASH_GRACE_SECS: u64 = parse_secs(option_env!("NEO_TRASH_GRACE_SECS"), 600);

/// Parses a build-time number of seconds; anything but digits (or zero) means `default`.
pub const fn parse_secs(raw: Option<&str>, default: u64) -> u64 {
    let Some(s) = raw else { return default };
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 9 {
        return default;
    }
    let mut n: u64 = 0;
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            return default;
        }
        n = n * 10 + (b[i] - b'0') as u64;
        i += 1;
    }
    if n == 0 { default } else { n }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_time_seconds_parse_strictly() {
        assert_eq!(parse_secs(None, 600), 600);
        assert_eq!(parse_secs(Some("20"), 600), 20);
        assert_eq!(parse_secs(Some(""), 600), 600);
        assert_eq!(parse_secs(Some("0"), 600), 600, "zero would remove the agent at once");
        assert_eq!(parse_secs(Some("-5"), 600), 600);
        assert_eq!(parse_secs(Some("20s"), 600), 600);
        assert_eq!(parse_secs(Some("9999999999"), 600), 600);
        assert_eq!(TRASH_GRACE_SECS, parse_secs(option_env!("NEO_TRASH_GRACE_SECS"), 600));
    }
}
