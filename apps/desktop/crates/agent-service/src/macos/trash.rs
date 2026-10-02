//! "Moving Neo.app to the Trash is an uninstall" (spec "Decisions"). The daemon looks for
//! `/Applications/Neo.app` on a timer; if it has been gone (or replaced by an app with a different
//! signer) for the grace period, it unenrolls and removes itself. Pure state, driven by the daemon.

/// How often to look, given the grace period: often enough that removal follows the grace period
/// closely (a quarter of it), but never faster than 5 seconds or slower than the spec's 60.
pub fn check_interval_secs(grace_secs: u64) -> u64 {
    (grace_secs / 4).clamp(5, 60)
}

/// Whether the app on disk is ours. `exists` is whether the bundle is there; the Team IDs are the
/// daemon's own and the app's (`None` = unsigned or ad-hoc). Both unsigned counts as a match (a
/// development or CI build); a different Team ID does not.
pub fn app_matches(exists: bool, own_team: Option<&str>, app_team: Option<&str>) -> bool {
    exists && own_team == app_team
}

/// What to do after an observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The app is there (or came back).
    Present,
    /// Missing, still within the grace period.
    Waiting { missing_for_secs: u64 },
    /// Missing for the whole grace period: unenroll and remove.
    Remove,
}

#[derive(Debug, Clone)]
pub struct TrashWatch {
    grace_secs: u64,
    missing_since: Option<i64>,
}

impl TrashWatch {
    pub fn new(grace_secs: u64) -> Self {
        TrashWatch {
            grace_secs,
            missing_since: None,
        }
    }

    /// Records one look at `now` (unix seconds). A put-back app resets the clock.
    pub fn observe(&mut self, now: i64, present: bool) -> Verdict {
        if present {
            self.missing_since = None;
            return Verdict::Present;
        }
        let since = *self.missing_since.get_or_insert(now);
        let missing = now.saturating_sub(since).max(0) as u64;
        if missing >= self.grace_secs {
            Verdict::Remove
        } else {
            Verdict::Waiting { missing_for_secs: missing }
        }
    }
}

/// The removal: tell the server first, then hand over to `uninstall.sh`.
///
/// The agent unenrolls itself (`DELETE /api/devices/self`, which raises the owner's
/// `device_removed` alert) and forgets its token **before** the script runs, so the script's own
/// `neo-agent --unenroll` finds nothing to send and the owner is told exactly once. The script
/// then boots the daemon out and deletes everything. Removal goes on even when the device was never
/// enrolled or the server is unreachable.
pub fn remove_self(agent: &crate::agent::Agent, spawn_uninstall: impl FnOnce() -> std::io::Result<()>) -> std::io::Result<()> {
    log::warn!("removal note: Neo.app has been missing or replaced; unenrolling and removing Neo Protection");
    agent.unenroll_for_uninstall();
    spawn_uninstall()
}

/// Starts `/bin/sh <script>` detached (own process group, no stdio), so it survives launchd
/// booting this daemon out (the plist sets `AbandonProcessGroup`).
pub fn spawn_uninstall_script(script: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut child = Command::new("/bin/sh")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()?;
    // Reap it when it finishes (if this process is still around by then).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn present_app_never_triggers() {
        let mut w = TrashWatch::new(600);
        for t in (0..5000).step_by(60) {
            assert_eq!(w.observe(t, true), Verdict::Present);
        }
    }

    #[test]
    fn missing_for_the_grace_period_removes() {
        let mut w = TrashWatch::new(600);
        assert_eq!(w.observe(1000, false), Verdict::Waiting { missing_for_secs: 0 });
        assert_eq!(w.observe(1060, false), Verdict::Waiting { missing_for_secs: 60 });
        assert_eq!(w.observe(1599, false), Verdict::Waiting { missing_for_secs: 599 });
        assert_eq!(w.observe(1600, false), Verdict::Remove);
    }

    #[test]
    fn put_back_within_the_grace_period_resets_the_clock() {
        let mut w = TrashWatch::new(600);
        assert!(matches!(w.observe(0, false), Verdict::Waiting { .. }));
        assert!(matches!(w.observe(500, false), Verdict::Waiting { .. }));
        assert_eq!(w.observe(560, true), Verdict::Present);
        // Gone again: a fresh 10 minutes, not the remaining 40 seconds.
        assert!(matches!(w.observe(600, false), Verdict::Waiting { missing_for_secs: 0 }));
        assert!(matches!(w.observe(1199, false), Verdict::Waiting { .. }));
        assert_eq!(w.observe(1200, false), Verdict::Remove);
    }

    #[test]
    fn a_ci_grace_period_is_followed_within_one_check_interval() {
        // NEO_TRASH_GRACE_SECS=20: looks every 5 s, so removal lands within 25 s of the deletion.
        let grace = 20;
        let step = check_interval_secs(grace) as i64;
        assert_eq!(step, 5);
        let mut w = TrashWatch::new(grace);
        let mut t = 100;
        let removed_at = loop {
            if w.observe(t, false) == Verdict::Remove {
                break t;
            }
            t += step;
        };
        assert!(removed_at - 100 <= grace as i64 + step);
    }

    #[test]
    fn the_default_interval_is_the_specs_sixty_seconds() {
        assert_eq!(check_interval_secs(600), 60);
        assert_eq!(check_interval_secs(3600), 60);
        assert_eq!(check_interval_secs(1), 5);
        assert!(check_interval_secs(40) <= 40);
    }

    #[test]
    fn the_signer_must_match_or_both_be_unsigned() {
        assert!(app_matches(true, Some("AB12CD34EF"), Some("AB12CD34EF")));
        assert!(app_matches(true, None, None));
        assert!(!app_matches(true, Some("AB12CD34EF"), Some("ZZ99ZZ99ZZ")));
        assert!(!app_matches(true, Some("AB12CD34EF"), None), "a signed daemon with an unsigned app");
        assert!(!app_matches(true, None, Some("AB12CD34EF")));
        assert!(!app_matches(false, None, None));
    }
}
