//! Time the child cannot move. Screen time and downtime run on a clock anchored to the server's
//! `Date` header and advanced by a monotonic clock that keeps counting through sleep, so changing
//! the computer's clock moves neither midnight nor downtime (`_specs/v2-m2-child.md`, edge cases).
//! A changed clock is reported once as `clock_changed`.
//!
//! Everything here takes the readings as arguments; the OS supplies them (`Clocks` in `neo-agent`).

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::{Rfc2822, Rfc3339};

/// The wall clock may differ from the trusted one by this much before it is a change (NTP steps,
/// the server's one-second `Date`, and a slow request all fit inside).
pub const CLOCK_TOLERANCE_SECS: i64 = 5 * 60;
/// A server time that differs from the trusted one by less than this does not move the anchor.
const SYNC_JITTER_SECS: i64 = 3;

/// "Now", from an anchor and a monotonic clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedClock {
    anchor_unix: i64,
    anchor_boot_secs: u64,
    synced: bool,
}

impl TrustedClock {
    /// Starts from the wall clock, but never earlier than `floor` (the newest trusted time written
    /// before the last stop): setting the clock back across a restart gains nothing.
    pub fn new(wall_unix: i64, boot_secs: u64, floor: Option<i64>) -> Self {
        TrustedClock {
            anchor_unix: floor.map_or(wall_unix, |f| f.max(wall_unix)),
            anchor_boot_secs: boot_secs,
            synced: false,
        }
    }

    /// The trusted unix time for a monotonic reading (`boot_secs` counts through sleep).
    pub fn now(&self, boot_secs: u64) -> i64 {
        self.anchor_unix + boot_secs.saturating_sub(self.anchor_boot_secs) as i64
    }

    /// Re-anchors to the server's time. Returns whether the trusted time moved.
    pub fn sync_server(&mut self, server_unix: i64, boot_secs: u64) -> bool {
        let moved = (server_unix - self.now(boot_secs)).abs() >= SYNC_JITTER_SECS;
        if moved || !self.synced {
            self.anchor_unix = server_unix;
            self.anchor_boot_secs = boot_secs;
        }
        self.synced = true;
        moved
    }

    /// Whether the server has set the anchor at least once since this process started.
    pub fn is_synced(&self) -> bool {
        self.synced
    }

    /// The wall clock minus the trusted clock, in seconds.
    pub fn wall_offset(&self, wall_unix: i64, boot_secs: u64) -> i64 {
        wall_unix - self.now(boot_secs)
    }
}

/// Unix seconds from an HTTP `Date` header (`Tue, 03 Nov 2026 10:00:00 GMT`); `None` if unreadable.
pub fn parse_http_date(text: &str) -> Option<i64> {
    OffsetDateTime::parse(text.trim(), &Rfc2822).ok().map(|t| t.unix_timestamp())
}

/// Unix seconds from an RFC 3339 timestamp.
pub fn parse_rfc3339(text: &str) -> Option<i64> {
    OffsetDateTime::parse(text.trim(), &Rfc3339).ok().map(|t| t.unix_timestamp())
}

/// Decides when a moved wall clock is worth reporting: once per change, not every pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClockWatch {
    /// The offset (seconds) already reported, while the clock is still off.
    reported: Option<i64>,
}

impl ClockWatch {
    /// `Some(offset)` the first time the wall clock is more than the tolerance away from the trusted
    /// clock, and again only if it moves by more than the tolerance from what was reported. Back
    /// within the tolerance, the watch is armed again.
    pub fn check(&mut self, wall_offset_secs: i64) -> Option<i64> {
        if wall_offset_secs.abs() <= CLOCK_TOLERANCE_SECS {
            self.reported = None;
            return None;
        }
        match self.reported {
            Some(r) if (wall_offset_secs - r).abs() <= CLOCK_TOLERANCE_SECS => None,
            _ => {
                self.reported = Some(wall_offset_secs);
                Some(wall_offset_secs)
            }
        }
    }
}

/// What is written to `child.json` so a restart cannot walk time backwards.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClockMemo {
    /// The newest trusted unix time seen.
    pub last_trusted: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_trusted_clock_follows_the_monotonic_clock_not_the_wall_clock() {
        let c = TrustedClock::new(1_000_000, 500, None);
        assert_eq!(c.now(500), 1_000_000);
        assert_eq!(c.now(560), 1_000_060);
        // A reading below the anchor (a reboot reset the clock) does not go back.
        assert_eq!(c.now(10), 1_000_000);
    }

    #[test]
    fn a_restart_cannot_go_back_in_time() {
        let c = TrustedClock::new(1_000_000, 0, Some(1_050_000));
        assert_eq!(c.now(0), 1_050_000);
        // A wall clock ahead of the floor wins (a normal restart).
        assert_eq!(TrustedClock::new(1_100_000, 0, Some(1_050_000)).now(0), 1_100_000);
    }

    #[test]
    fn the_server_date_sets_the_anchor_and_small_differences_do_not_move_it() {
        let mut c = TrustedClock::new(1_000_000, 100, None);
        assert!(!c.is_synced());
        // The wall clock was a day fast: the server corrects it.
        assert!(c.sync_server(913_600, 100));
        assert!(c.is_synced());
        assert_eq!(c.now(100), 913_600);
        assert_eq!(c.now(130), 913_630);
        // A second later is jitter.
        assert!(!c.sync_server(913_631, 130));
        assert_eq!(c.now(130), 913_630);
        assert!(c.sync_server(913_730, 130));
    }

    #[test]
    fn wall_offset_is_wall_minus_trusted() {
        let c = TrustedClock::new(1_000_000, 0, None);
        assert_eq!(c.wall_offset(1_000_030, 30), 0);
        assert_eq!(c.wall_offset(1_000_030 + 7200, 30), 7200);
        assert_eq!(c.wall_offset(900_000, 30), -100_030);
    }

    #[test]
    fn http_and_rfc3339_dates_parse() {
        assert_eq!(parse_http_date("Wed, 04 Nov 2026 00:48:25 GMT"), Some(1_793_753_305));
        assert_eq!(parse_http_date(" Wed, 04 Nov 2026 00:48:25 GMT "), Some(1_793_753_305));
        assert_eq!(parse_http_date("yesterday"), None);
        assert_eq!(parse_rfc3339("2026-11-04T00:48:25Z"), Some(1_793_753_305));
        assert_eq!(parse_rfc3339("2026-11-03T19:48:25-05:00"), Some(1_793_753_305));
        assert_eq!(parse_rfc3339("nope"), None);
    }

    #[test]
    fn a_clock_change_is_reported_once_and_again_only_if_it_moves_further() {
        let mut w = ClockWatch::default();
        assert_eq!(w.check(0), None);
        assert_eq!(w.check(299), None);
        assert_eq!(w.check(-299), None);
        assert_eq!(w.check(3600), Some(3600));
        assert_eq!(w.check(3601), None, "still the same change");
        assert_eq!(w.check(3600 + 100), None);
        assert_eq!(w.check(86_400), Some(86_400), "moved again");
        // Put right, then changed again: a new report.
        assert_eq!(w.check(2), None);
        assert_eq!(w.check(-7200), Some(-7200));
    }
}
