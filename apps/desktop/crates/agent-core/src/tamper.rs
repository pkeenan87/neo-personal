//! Tamper detection for Child mode (`_specs/v2-m2-child.md` section 7), as pure rules, plus the
//! rate limits that keep a child's repeated attempts from filling the device's 500-events-a-day
//! allowance.
//!
//! What can be seen from a computer's own point of view is small, and every report pages the parent
//! at high severity, so each rule here is conservative: a false alarm costs more than a missed
//! one. `clock_changed` lives in [`crate::clock`]; `bad_policy_signature` in [`crate::policy`].

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::snapshot::ProcessInfo;

// ---- Which programs ---------------------------------------------------------------------------------

/// Program names, lowercase and without `.exe`, of VPN clients a child might install to get around
/// web filtering. A running one is reported as `vpn_app`. Deliberately short: names a person is
/// unlikely to run for another reason.
pub const VPN_APPS: &[&str] = &[
    "openvpn",
    "openvpn-gui",
    "openvpn connect",
    "wireguard",
    "nordvpn",
    "expressvpn",
    "protonvpn",
    "surfshark",
    "mullvad vpn",
    "mullvad-vpn",
    "windscribe",
    "cyberghost",
    "tunnelbear",
    "hotspotshield",
    "psiphon3",
    "lantern",
];

/// Browsers whose web traffic the Neo extension filters, by program name (lowercase, no `.exe`).
pub const BROWSERS: &[&str] = &[
    "chrome",
    "msedge",
    "firefox",
    "brave",
    "google chrome",
    "microsoft edge",
    "brave browser",
];

fn program_name(p: &ProcessInfo) -> String {
    let n = p.image_name.trim().to_lowercase();
    n.strip_suffix(".exe").unwrap_or(&n).to_string()
}

/// The first running VPN client, by its program name.
pub fn running_vpn(procs: &[ProcessInfo]) -> Option<String> {
    procs.iter().map(program_name).find(|n| VPN_APPS.contains(&n.as_str()))
}

/// Whether a known browser is running.
pub fn browser_running(procs: &[ProcessInfo]) -> bool {
    procs.iter().map(program_name).any(|n| BROWSERS.contains(&n.as_str()))
}

/// `browser_without_extension`: a known browser is running and the server has said that the
/// household's Neo extension is *not* enrolled for this member.
///
/// `extension_enrolled` is `None` when nothing has said: **then nothing is reported.** The agent
/// cannot tell by itself (the extension has no fixed id, and the signed bundle and heartbeat carry no
/// such field today), and reporting every Chrome window of every child would page the parent for a
/// child doing nothing wrong. The server has to supply the fact; see the spec's Open Questions.
pub fn browser_without_extension(procs: &[ProcessInfo], extension_enrolled: Option<bool>) -> bool {
    extension_enrolled == Some(false) && browser_running(procs)
}

// ---- The service's own journal ----------------------------------------------------------------------

/// An awake gap longer than this (seconds) with the machine still up is reported.
pub const GAP_REPORT_SECS: u64 = 10 * 60;
/// Boot-time estimates this close are the same boot.
const SAME_BOOT_SLACK_SECS: i64 = 120;

/// What the service wrote last time it was alive (`alive.json`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Alive {
    /// Unix seconds when it was written.
    pub wall: i64,
    /// The boot moment (`wall` minus the monotonic clock), to tell a reboot from a restart.
    pub boot_unix: i64,
    /// Awake seconds since boot when it was written (the clock that stops while the computer sleeps).
    pub awake_secs: u64,
}

impl Alive {
    pub fn stamp(wall: i64, boot_secs: u64, awake_secs: u64) -> Self {
        Alive {
            wall,
            boot_unix: wall - boot_secs as i64,
            awake_secs,
        }
    }
}

/// `agent_service_stopped`: on start, compares the last stamp with now. Reports the gap (awake
/// seconds) only when the same boot was running the whole time and the computer was awake for more
/// than [`GAP_REPORT_SECS`] of it, i.e. the service was off while the computer was in use. A
/// reboot, a shutdown, sleep, or a service crash that came straight back all stay quiet.
pub fn service_gap(prev: &Alive, now: &Alive) -> Option<u64> {
    if prev.wall == 0 {
        return None; // first run
    }
    if (now.boot_unix - prev.boot_unix).abs() > SAME_BOOT_SLACK_SECS {
        return None; // another boot
    }
    let gap = now.awake_secs.checked_sub(prev.awake_secs)?;
    (gap > GAP_REPORT_SECS).then_some(gap)
}

// ---- Rate limits --------------------------------------------------------------------------------------

/// "Not again within this window", per key.
#[derive(Debug, Clone, Default)]
pub struct Limiter {
    last: BTreeMap<String, i64>,
}

impl Limiter {
    /// Whether `key` may act at `now`; records the time when it may.
    pub fn allow(&mut self, key: &str, now: i64, window_secs: i64) -> bool {
        if let Some(&t) = self.last.get(key)
            && now >= t
            && now - t < window_secs
        {
            return false;
        }
        if self.last.len() > 256 {
            self.last.retain(|_, t| now - *t < 86_400);
        }
        self.last.insert(key.to_string(), now);
        true
    }
}

/// At most `limit` per UTC day.
#[derive(Debug, Clone, Default)]
pub struct DailyCap {
    day: i64,
    count: u32,
}

impl DailyCap {
    pub fn take(&mut self, now: i64, limit: u32) -> bool {
        let day = now.div_euclid(86_400);
        if day != self.day {
            self.day = day;
            self.count = 0;
        }
        if self.count >= limit {
            return false;
        }
        self.count += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str) -> ProcessInfo {
        ProcessInfo {
            pid: 5,
            image_name: name.into(),
            ..Default::default()
        }
    }

    #[test]
    fn vpn_clients_are_found_by_program_name() {
        assert_eq!(running_vpn(&[p("explorer.exe"), p("NordVPN.exe")]).as_deref(), Some("nordvpn"));
        assert_eq!(running_vpn(&[p("WireGuard.EXE")]).as_deref(), Some("wireguard"));
        assert_eq!(running_vpn(&[p("Mullvad VPN")]).as_deref(), Some("mullvad vpn"));
        assert_eq!(running_vpn(&[p("notepad.exe"), p("vpnc.exe"), p("nordvpn-service.exe")]), None);
        assert_eq!(running_vpn(&[]), None);
    }

    #[test]
    fn a_browser_without_the_extension_is_reported_only_when_the_server_says_so() {
        let chrome = [p("chrome.exe"), p("explorer.exe")];
        assert!(!browser_without_extension(&chrome, None), "unknown is never reported");
        assert!(!browser_without_extension(&chrome, Some(true)));
        assert!(browser_without_extension(&chrome, Some(false)));
        assert!(!browser_without_extension(&[p("notepad.exe")], Some(false)), "no browser running");
        assert!(browser_without_extension(&[p("Google Chrome")], Some(false)));
        assert!(browser_without_extension(&[p("firefox.exe")], Some(false)));
        assert!(!browser_without_extension(&[p("chromedriver.exe")], Some(false)));
    }

    fn alive(wall: i64, boot_secs: u64, awake: u64) -> Alive {
        Alive::stamp(wall, boot_secs, awake)
    }

    #[test]
    fn a_stopped_service_on_a_running_computer_is_reported() {
        // Stamped at wall 10_000 with the machine up 5_000 s, 4_000 of them awake.
        let prev = alive(10_000, 5_000, 4_000);
        // Back 1_800 s later, same boot, 1_800 more awake seconds.
        assert_eq!(service_gap(&prev, &alive(11_800, 6_800, 5_800)), Some(1_800));
        // A crash that restarted at once.
        assert_eq!(service_gap(&prev, &alive(10_030, 5_030, 4_030)), None);
        // Right at the limit is not over it.
        assert_eq!(service_gap(&prev, &alive(10_600, 5_600, 4_600)), None);
        assert_eq!(service_gap(&prev, &alive(10_601, 5_601, 4_601)), Some(601));
    }

    #[test]
    fn reboots_shutdowns_and_sleep_are_quiet() {
        let prev = alive(10_000, 5_000, 4_000);
        // The computer was off for two days: a different boot.
        assert_eq!(service_gap(&prev, &alive(10_000 + 172_800, 300, 290)), None);
        // It slept for six hours: wall and boot advanced, awake did not.
        assert_eq!(service_gap(&prev, &alive(10_000 + 21_600, 5_000 + 21_600, 4_010)), None);
        // The awake clock cannot go back within a boot, but if it does nothing is reported.
        assert_eq!(service_gap(&prev, &alive(11_000, 6_000, 100)), None);
        // The first run has nothing to compare with.
        assert_eq!(service_gap(&Alive::default(), &alive(11_000, 6_000, 5_000)), None);
        // A wall-clock change in the gap looks like another boot: clock_changed covers that.
        assert_eq!(service_gap(&prev, &alive(10_000 + 86_400, 6_800, 5_800)), None);
    }

    #[test]
    fn the_limiter_allows_once_per_window_per_key() {
        let mut l = Limiter::default();
        assert!(l.allow("a", 1000, 60));
        assert!(!l.allow("a", 1059, 60));
        assert!(l.allow("b", 1059, 60));
        assert!(l.allow("a", 1060, 60));
        // A clock that moved back does not lock a key out forever.
        assert!(l.allow("a", 500, 60));
    }

    #[test]
    fn the_daily_cap_resets_each_utc_day() {
        let mut c = DailyCap::default();
        assert!(c.take(100, 2));
        assert!(c.take(200, 2));
        assert!(!c.take(300, 2));
        assert!(c.take(86_400 + 5, 2));
    }
}
