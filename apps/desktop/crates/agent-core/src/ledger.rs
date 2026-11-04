//! The screen-time ledger and downtime (`_specs/v2-m2-child.md` section 7), as pure logic.
//!
//! Each pass the service gives the ledger the trusted time, a monotonic "awake" reading and what
//! the console session is doing; the ledger adds up the minutes the child actually used today (in
//! the household's time zone), compares them with the budget and the downtime windows, and answers
//! with what to tell the person (warnings) and what to do (lock). It touches no OS API.

use std::collections::BTreeSet;

use jiff::civil::Weekday;
use jiff::tz::TimeZone;
use jiff::{Timestamp, Zoned};
use serde::{Deserialize, Serialize};

use crate::clock::parse_rfc3339;
use crate::policy::{DailyMinutes, DowntimeWindow, ScreenTimeRules};

/// No input for this long (seconds) and the person is not using the computer.
pub const IDLE_LIMIT_SECS: u64 = 5 * 60;
/// One pass never adds more than this many seconds, so a stall or a resume cannot dump hours onto
/// the day.
pub const MAX_STEP_SECS: u64 = 15;
/// A locked-out person who signs straight back in is locked again after this long.
pub const RELOCK_SECS: i64 = 30;

/// What the console session is doing, as the OS probe saw it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Console {
    /// Someone is signed in at the console (not the sign-in screen, not disconnected).
    pub present: bool,
    /// The screen is locked.
    pub locked: bool,
    /// Seconds since the last keyboard or mouse input; `None` when the OS cannot say (not counted
    /// as idle).
    pub idle_secs: Option<u64>,
}

impl Console {
    /// Using the computer: signed in, unlocked, and not idle.
    pub fn active(&self) -> bool {
        self.present && !self.locked && self.idle_secs.is_none_or(|i| i < IDLE_LIMIT_SECS)
    }

    /// A session that can be locked now.
    pub fn lockable(&self) -> bool {
        self.present && !self.locked
    }
}

/// Why the computer is being locked or warned about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// The daily budget.
    Budget,
    /// A downtime window.
    Downtime,
}

/// What a pass asks the service to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerEvent {
    /// Tell the person: `minutes` left (rounded up) before the budget ends or downtime starts.
    Warn { cause: Cause, minutes: u32 },
    /// Report `screen_time_exhausted` (once per day for the budget, once per downtime window).
    Exhausted { cause: Cause },
    /// Lock the session now.
    Lock { cause: Cause },
}

/// Where the day stands, for the tray and for tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScreenStatus {
    /// Seconds left today; `None` = no limit.
    pub remaining_secs: Option<u64>,
    /// Today's budget including grants; `None` = no limit.
    pub budget_secs: Option<u64>,
    pub used_secs: u64,
    pub in_downtime: bool,
    /// Unix time the next downtime begins (`None` when there are no windows); while in downtime, the
    /// start of the next one after this.
    pub next_downtime_at: Option<i64>,
    /// While in downtime: when it ends.
    pub downtime_ends_at: Option<i64>,
}

/// One pass's output.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StepOutput {
    pub status: ScreenStatus,
    pub events: Vec<LedgerEvent>,
}

/// One pass's input.
pub struct StepInput<'a> {
    /// Trusted unix time.
    pub now: i64,
    /// Seconds of awake (not asleep) time since boot.
    pub awake_secs: u64,
    pub console: Console,
    pub rules: &'a ScreenTimeRules,
    /// The household's IANA zone; an unknown name is read as UTC (as the server does).
    pub time_zone: &'a str,
}

/// The day's usage. Persisted in `child.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    /// Local date `YYYY-MM-DD` the counters belong to. Only moves forward.
    day: String,
    used_secs: u64,
    /// Warnings already given (keys include the day and the figure they were about).
    warned: BTreeSet<String>,
    /// `screen_time_exhausted` events already produced.
    exhausted: BTreeSet<String>,
    #[serde(skip)]
    last_awake: Option<u64>,
    #[serde(skip)]
    last_lock: Option<i64>,
}

impl Ledger {
    pub fn used_secs(&self) -> u64 {
        self.used_secs
    }

    pub fn day(&self) -> &str {
        &self.day
    }

    /// One pass. Counts the awake time since the last pass when the person is using the computer
    /// outside downtime, rolls the day over at local midnight, and returns the status and events.
    pub fn step(&mut self, input: &StepInput<'_>) -> StepOutput {
        let tz = zone(input.time_zone);
        let zdt = zoned(input.now, &tz);
        self.roll_day(&zdt);

        let delta = match self.last_awake {
            Some(last) if input.awake_secs >= last => (input.awake_secs - last).min(MAX_STEP_SECS),
            _ => 0, // the first pass, or a reboot reset the clock
        };
        self.last_awake = Some(input.awake_secs);

        let rules = input.rules;
        let in_downtime = in_downtime(&rules.downtime, &zdt);
        if input.console.active() && !in_downtime {
            self.used_secs += delta;
        }

        let base = daily_minutes(&rules.daily_minutes, zdt.weekday()).map(|m| u64::from(m) * 60);
        let grants = grant_secs(rules, input.now);
        let budget_secs = base.map(|b| b + grants);
        let remaining_secs = budget_secs.map(|b| b.saturating_sub(self.used_secs));
        let next_downtime_at = next_downtime_start(&rules.downtime, input.now, &tz);
        let downtime_ends_at = in_downtime.then(|| downtime_end(&rules.downtime, input.now, &tz)).flatten();

        let mut events = Vec::new();
        let day = self.day.clone();
        if remaining_secs == Some(0) {
            if self.exhausted.insert(format!("budget:{day}")) {
                events.push(LedgerEvent::Exhausted { cause: Cause::Budget });
            }
            self.lock_if_due(input, Cause::Budget, &mut events);
        }
        if in_downtime {
            let key = format!("downtime:{}", downtime_key(&rules.downtime, &zdt));
            if self.exhausted.insert(key) {
                events.push(LedgerEvent::Exhausted { cause: Cause::Downtime });
            }
            self.lock_if_due(input, Cause::Downtime, &mut events);
        }

        let warn_secs = u64::from(rules.warn_minutes) * 60;
        if warn_secs > 0 && input.console.lockable() && !in_downtime {
            if let (Some(rem), Some(total)) = (remaining_secs, budget_secs)
                && rem > 0
                && rem <= warn_secs
                && self.warned.insert(format!("budget:{day}:{total}"))
            {
                events.push(LedgerEvent::Warn {
                    cause: Cause::Budget,
                    minutes: rem.div_ceil(60) as u32,
                });
            }
            if let Some(next) = next_downtime_at {
                let until = (next - input.now).max(0) as u64;
                if until > 0 && until <= warn_secs && self.warned.insert(format!("downtime:{next}")) {
                    events.push(LedgerEvent::Warn {
                        cause: Cause::Downtime,
                        minutes: until.div_ceil(60) as u32,
                    });
                }
            }
        }
        self.prune_keys(&day);

        StepOutput {
            status: ScreenStatus {
                remaining_secs,
                budget_secs,
                used_secs: self.used_secs,
                in_downtime,
                next_downtime_at,
                downtime_ends_at,
            },
            events,
        }
    }

    fn lock_if_due(&mut self, input: &StepInput<'_>, cause: Cause, events: &mut Vec<LedgerEvent>) {
        if !input.console.lockable() {
            return;
        }
        if self.last_lock.is_some_and(|t| input.now - t < RELOCK_SECS && input.now >= t) {
            return;
        }
        self.last_lock = Some(input.now);
        // One lock per pass even when both the budget and downtime say so.
        if !events.iter().any(|e| matches!(e, LedgerEvent::Lock { .. })) {
            events.push(LedgerEvent::Lock { cause });
        }
    }

    /// The day only moves forward: going back (a corrected clock, a changed household zone) keeps
    /// the counters rather than handing back a fresh budget.
    fn roll_day(&mut self, zdt: &Zoned) {
        let today = zdt.date().to_string();
        if self.day.is_empty() {
            self.day = today;
        } else if today > self.day {
            self.day = today;
            self.used_secs = 0;
            // A downtime window that began yesterday evening is still the same window after midnight.
            self.warned.retain(|k| k.starts_with("downtime:"));
            self.exhausted.retain(|k| k.starts_with("downtime:"));
        }
    }

    /// Keys from other days are forgotten (downtime keys carry their own date, so they are kept a day).
    fn prune_keys(&mut self, day: &str) {
        self.warned.retain(|k| k.contains(day) || k.starts_with("downtime:"));
        if self.warned.len() > 64 {
            self.warned.clear();
        }
        if self.exhausted.len() > 64 {
            self.exhausted.retain(|k| k.contains(day));
        }
    }
}

// ---- Time helpers ---------------------------------------------------------------------------------

fn zone(name: &str) -> TimeZone {
    TimeZone::get(name.trim()).unwrap_or(TimeZone::UTC)
}

fn zoned(unix: i64, tz: &TimeZone) -> Zoned {
    Timestamp::from_second(unix).unwrap_or(Timestamp::UNIX_EPOCH).to_zoned(tz.clone())
}

/// The local `YYYY-MM-DD` of `unix` in `time_zone`.
pub fn local_day(unix: i64, time_zone: &str) -> String {
    zoned(unix, &zone(time_zone)).date().to_string()
}

fn daily_minutes(d: &DailyMinutes, wd: Weekday) -> Option<u32> {
    match wd {
        Weekday::Monday => d.mon,
        Weekday::Tuesday => d.tue,
        Weekday::Wednesday => d.wed,
        Weekday::Thursday => d.thu,
        Weekday::Friday => d.fri,
        Weekday::Saturday => d.sat,
        Weekday::Sunday => d.sun,
    }
}

/// Seconds granted by `screenTime.grants` that are still running at `now`.
pub fn grant_secs(rules: &ScreenTimeRules, now: i64) -> u64 {
    rules
        .grants
        .iter()
        .filter(|g| parse_rfc3339(&g.until).is_some_and(|until| until > now))
        .map(|g| u64::from(g.minutes) * 60)
        .sum()
}

/// `HH:MM` as minutes after midnight.
fn minutes_of(text: &str) -> Option<u32> {
    let (h, m) = text.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

fn window_minutes(w: &DowntimeWindow) -> Option<(u32, u32)> {
    let (s, e) = (minutes_of(&w.start)?, minutes_of(&w.end)?);
    (s != e).then_some((s, e))
}

fn in_window(m: u32, (s, e): (u32, u32)) -> bool {
    if s < e { (s..e).contains(&m) } else { m >= s || m < e }
}

/// Whether the local time of `zdt` is inside any downtime window. A window may cross midnight
/// (`21:00`-`07:00`); one whose start equals its end is empty; an unreadable one is ignored.
pub fn in_downtime(windows: &[DowntimeWindow], zdt: &Zoned) -> bool {
    let m = u32::from(zdt.hour() as u8) * 60 + u32::from(zdt.minute() as u8);
    windows.iter().filter_map(window_minutes).any(|w| in_window(m, w))
}

/// Identifies the downtime window `zdt` is in by the date it started on (`2026-11-03T21:00`).
fn downtime_key(windows: &[DowntimeWindow], zdt: &Zoned) -> String {
    let m = u32::from(zdt.hour() as u8) * 60 + u32::from(zdt.minute() as u8);
    for w in windows {
        let Some((s, e)) = window_minutes(w) else { continue };
        if !in_window(m, (s, e)) {
            continue;
        }
        // After midnight inside a window that started the evening before.
        let date = if s > e && m < e {
            zdt.date().yesterday().unwrap_or(zdt.date())
        } else {
            zdt.date()
        };
        return format!("{date}T{}", w.start.trim());
    }
    String::new()
}

/// The instants (unix seconds) at which a window's `start` or `end` next occurs after `now`.
fn next_edges(windows: &[DowntimeWindow], now: i64, tz: &TimeZone, edge_of: impl Fn((u32, u32)) -> u32) -> Option<i64> {
    let today = zoned(now, tz).date();
    let mut best: Option<i64> = None;
    for w in windows.iter().filter_map(window_minutes) {
        let m = edge_of(w);
        for day_offset in 0..=2i64 {
            let Ok(date) = today.checked_add(jiff::Span::new().days(day_offset)) else {
                continue;
            };
            let Ok(at) = date.at((m / 60) as i8, (m % 60) as i8, 0, 0).to_zoned(tz.clone()) else {
                continue;
            };
            let t = at.timestamp().as_second();
            if t > now {
                best = Some(best.map_or(t, |b| b.min(t)));
                break;
            }
        }
    }
    best
}

/// When the next downtime window begins after `now`.
pub fn next_downtime_start(windows: &[DowntimeWindow], now: i64, tz: &TimeZone) -> Option<i64> {
    next_edges(windows, now, tz, |(s, _)| s)
}

/// When the current downtime ends.
fn downtime_end(windows: &[DowntimeWindow], now: i64, tz: &TimeZone) -> Option<i64> {
    let zdt = zoned(now, tz);
    let m = u32::from(zdt.hour() as u8) * 60 + u32::from(zdt.minute() as u8);
    let current: Vec<DowntimeWindow> = windows
        .iter()
        .filter(|w| window_minutes(w).is_some_and(|win| in_window(m, win)))
        .cloned()
        .collect();
    next_edges(&current, now, tz, |(_, e)| e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::Grant;

    const NY: &str = "America/New_York";

    fn at(iso: &str) -> i64 {
        iso.parse::<Timestamp>().unwrap().as_second()
    }

    fn rules(mon_to_fri: Option<u32>, sat_sun: Option<u32>, downtime: &[(&str, &str)], warn: u32) -> ScreenTimeRules {
        ScreenTimeRules {
            daily_minutes: DailyMinutes {
                mon: mon_to_fri,
                tue: mon_to_fri,
                wed: mon_to_fri,
                thu: mon_to_fri,
                fri: mon_to_fri,
                sat: sat_sun,
                sun: sat_sun,
            },
            downtime: downtime
                .iter()
                .map(|(s, e)| DowntimeWindow {
                    start: (*s).into(),
                    end: (*e).into(),
                })
                .collect(),
            warn_minutes: warn,
            ..Default::default()
        }
    }

    const ACTIVE: Console = Console {
        present: true,
        locked: false,
        idle_secs: Some(0),
    };

    /// Runs the ledger once per `step_secs` of both trusted and awake time.
    struct Sim {
        ledger: Ledger,
        now: i64,
        awake: u64,
    }

    impl Sim {
        fn new(start_iso: &str) -> Self {
            Sim {
                ledger: Ledger::default(),
                now: at(start_iso),
                awake: 1000,
            }
        }

        fn step(&mut self, rules: &ScreenTimeRules, console: Console) -> StepOutput {
            self.ledger.step(&StepInput {
                now: self.now,
                awake_secs: self.awake,
                console,
                rules,
                time_zone: NY,
            })
        }

        /// Advances `secs` in five-second passes, returning every event.
        fn run(&mut self, secs: u64, rules: &ScreenTimeRules, console: Console) -> Vec<LedgerEvent> {
            let mut out = Vec::new();
            for _ in 0..(secs / 5) {
                self.now += 5;
                self.awake += 5;
                out.extend(self.step(rules, console).events);
            }
            out
        }
    }

    #[test]
    fn only_active_unlocked_time_counts() {
        let r = rules(Some(60), Some(60), &[], 10);
        let mut s = Sim::new("2026-11-03T15:00:00Z"); // Tuesday 10:00 in New York
        s.step(&r, ACTIVE);
        s.run(600, &r, ACTIVE);
        assert_eq!(s.ledger.used_secs(), 600);
        s.run(300, &r, Console { locked: true, ..ACTIVE });
        s.run(300, &r, Console { present: false, ..ACTIVE });
        s.run(
            300,
            &r,
            Console {
                idle_secs: Some(IDLE_LIMIT_SECS),
                ..ACTIVE
            },
        );
        assert_eq!(s.ledger.used_secs(), 600, "locked, signed out and idle time do not count");
        s.run(300, &r, Console { idle_secs: None, ..ACTIVE });
        assert_eq!(s.ledger.used_secs(), 900, "an unknown idle time counts as using it");
        assert_eq!(s.step(&r, ACTIVE).status.remaining_secs, Some(3600 - 900));
    }

    #[test]
    fn a_stall_or_a_reboot_does_not_dump_time_on_the_day() {
        let r = rules(Some(60), Some(60), &[], 0);
        let mut s = Sim::new("2026-11-03T15:00:00Z");
        s.step(&r, ACTIVE);
        // Two hours pass between passes (a stalled service): at most one step is added.
        s.now += 7200;
        s.awake += 7200;
        s.step(&r, ACTIVE);
        assert_eq!(s.ledger.used_secs(), MAX_STEP_SECS);
        // The awake clock went down (a reboot): nothing is added.
        s.awake = 3;
        s.now += 5;
        s.step(&r, ACTIVE);
        assert_eq!(s.ledger.used_secs(), MAX_STEP_SECS);
    }

    #[test]
    fn the_budget_runs_out_warns_first_then_locks() {
        let r = rules(Some(2), Some(2), &[], 1); // two minutes, warn one minute before
        let mut s = Sim::new("2026-11-03T15:00:00Z");
        s.step(&r, ACTIVE);
        let ev = s.run(55, &r, ACTIVE);
        assert!(ev.is_empty(), "no warning yet: {ev:?}");
        let ev = s.run(10, &r, ACTIVE);
        assert_eq!(
            ev,
            vec![LedgerEvent::Warn {
                cause: Cause::Budget,
                minutes: 1
            }]
        );
        // Only once.
        assert!(s.run(30, &r, ACTIVE).is_empty());
        let ev = s.run(40, &r, ACTIVE);
        assert_eq!(
            ev,
            vec![
                LedgerEvent::Exhausted { cause: Cause::Budget },
                LedgerEvent::Lock { cause: Cause::Budget }
            ],
            "reported once, then locked"
        );
        let st = s.step(&r, ACTIVE).status;
        assert_eq!(st.remaining_secs, Some(0));
        // Signing straight back in: locked again, but not every pass.
        let again = s.run(RELOCK_SECS as u64 + 5, &r, ACTIVE);
        let locks = again.iter().filter(|e| matches!(e, LedgerEvent::Lock { .. })).count();
        assert!((1..=2).contains(&locks), "{again:?}");
        assert!(
            !again.iter().any(|e| matches!(e, LedgerEvent::Exhausted { .. })),
            "not reported again"
        );
    }

    #[test]
    fn nothing_locks_when_nobody_is_signed_in_or_it_is_already_locked() {
        let r = rules(Some(0), Some(0), &[], 10);
        let mut s = Sim::new("2026-11-03T15:00:00Z");
        for c in [Console { present: false, ..ACTIVE }, Console { locked: true, ..ACTIVE }] {
            let ev = s.run(60, &r, c);
            assert!(!ev.iter().any(|e| matches!(e, LedgerEvent::Lock { .. })), "{ev:?}");
        }
        let ev = s.run(10, &r, ACTIVE);
        assert!(ev.contains(&LedgerEvent::Lock { cause: Cause::Budget }));
    }

    #[test]
    fn no_limit_means_no_budget_events() {
        let r = rules(None, None, &[], 10);
        let mut s = Sim::new("2026-11-03T15:00:00Z");
        let ev = s.run(3600, &r, ACTIVE);
        assert!(ev.is_empty());
        let st = s.step(&r, ACTIVE).status;
        assert_eq!(st.remaining_secs, None);
        assert_eq!(st.budget_secs, None);
        assert!(st.used_secs > 0);
    }

    #[test]
    fn weekday_and_weekend_budgets() {
        let r = rules(Some(60), Some(180), &[], 0);
        let mut tue = Sim::new("2026-11-03T15:00:00Z");
        assert_eq!(tue.step(&r, ACTIVE).status.budget_secs, Some(3600));
        let mut sat = Sim::new("2026-11-07T15:00:00Z");
        assert_eq!(sat.step(&r, ACTIVE).status.budget_secs, Some(10_800));
    }

    #[test]
    fn grants_add_minutes_while_they_run_and_warn_again() {
        let mut r = rules(Some(2), Some(2), &[], 1);
        let mut s = Sim::new("2026-11-03T15:00:00Z");
        s.step(&r, ACTIVE);
        s.run(115, &r, ACTIVE);
        // A parent grants 30 minutes until the end of the day: the lock is lifted by the new bundle.
        r.grants = vec![Grant {
            minutes: 30,
            until: "2026-11-04T05:00:00Z".into(),
        }];
        let st = s.step(&r, ACTIVE).status;
        assert_eq!(st.budget_secs, Some(32 * 60));
        assert!(st.remaining_secs.unwrap() > 29 * 60);
        // Nearly out again: warns again, since the budget is a different figure.
        let ev = s.run(30 * 60, &r, ACTIVE);
        assert!(
            ev.iter().any(|e| matches!(e, LedgerEvent::Warn { cause: Cause::Budget, .. })),
            "{ev:?}"
        );
        // An expired grant counts for nothing.
        let mut expired = rules(Some(2), Some(2), &[], 0);
        expired.grants = vec![Grant {
            minutes: 30,
            until: "2026-11-03T14:59:59Z".into(),
        }];
        assert_eq!(
            Sim::new("2026-11-03T15:00:00Z").step(&expired, ACTIVE).status.budget_secs,
            Some(120)
        );
        // Exactly at `until` the grant is over (until must be in the future).
        let mut edge = rules(Some(2), Some(2), &[], 0);
        edge.grants = vec![Grant {
            minutes: 30,
            until: "2026-11-03T15:00:00Z".into(),
        }];
        assert_eq!(Sim::new("2026-11-03T15:00:00Z").step(&edge, ACTIVE).status.budget_secs, Some(120));
    }

    #[test]
    fn midnight_resets_in_the_household_zone_including_across_a_dst_change() {
        let r = rules(Some(60), Some(60), &[], 0);
        // Fall back: the night of 1 November 2026 in New York is 25 hours long. Local midnight
        // between the 1st and 2nd is 05:00Z (EST); between the 31st and 1st it is 04:00Z (EDT).
        let mut s = Sim::new("2026-11-01T03:59:30Z"); // 23:59:30 on 31 October, EDT
        s.step(&r, ACTIVE);
        s.run(25, &r, ACTIVE);
        assert_eq!(s.ledger.day(), "2026-10-31");
        assert_eq!(s.ledger.used_secs(), 25);
        s.run(10, &r, ACTIVE); // 00:00:05 on 1 November
        assert_eq!(s.ledger.day(), "2026-11-01");
        assert!(s.ledger.used_secs() <= 10, "a new day, a new budget");
        // 05:30Z on 1 Nov is 01:30 EDT, and 06:30Z is 01:30 EST (the hour repeats): same local day.
        s.now = at("2026-11-01T06:30:00Z");
        s.awake += 5;
        s.step(&r, ACTIVE);
        assert_eq!(s.ledger.day(), "2026-11-01");
        // The next local midnight is 05:00Z on the 2nd, not 04:00Z.
        s.now = at("2026-11-02T04:30:00Z");
        s.awake += 5;
        s.step(&r, ACTIVE);
        assert_eq!(s.ledger.day(), "2026-11-01", "still the 1st at 23:30 EST");
        s.now = at("2026-11-02T05:00:05Z");
        s.awake += 5;
        s.step(&r, ACTIVE);
        assert_eq!(s.ledger.day(), "2026-11-02");

        // Spring forward: 8 March 2026, 02:00 EST jumps to 03:00 EDT. Midnight is 05:00Z that day.
        let mut s = Sim::new("2026-03-08T04:59:50Z");
        s.step(&r, ACTIVE);
        assert_eq!(s.ledger.day(), "2026-03-07");
        s.now = at("2026-03-08T05:00:00Z");
        s.awake += 5;
        s.step(&r, ACTIVE);
        assert_eq!(s.ledger.day(), "2026-03-08");
    }

    #[test]
    fn the_day_never_goes_back() {
        let r = rules(Some(60), Some(60), &[], 0);
        let mut s = Sim::new("2026-11-03T15:00:00Z");
        s.step(&r, ACTIVE);
        s.run(300, &r, ACTIVE);
        assert_eq!(s.ledger.used_secs(), 300);
        // The trusted clock is corrected a day back: the counters stay.
        s.now = at("2026-11-02T15:00:00Z");
        s.awake += 5;
        s.step(&r, ACTIVE);
        assert_eq!(s.ledger.day(), "2026-11-03");
        assert!(s.ledger.used_secs() >= 300);
    }

    #[test]
    fn an_unknown_zone_is_utc() {
        assert_eq!(local_day(at("2026-11-03T23:30:00Z"), "Not/AZone"), "2026-11-03");
        assert_eq!(local_day(at("2026-11-03T23:30:00Z"), NY), "2026-11-03");
        assert_eq!(local_day(at("2026-11-04T03:30:00Z"), NY), "2026-11-03");
        assert_eq!(local_day(at("2026-11-04T03:30:00Z"), "Asia/Tokyo"), "2026-11-04");
    }

    #[test]
    fn downtime_across_midnight() {
        let w = [DowntimeWindow {
            start: "21:00".into(),
            end: "07:00".into(),
        }];
        let tz = zone(NY);
        let yes = |iso: &str| in_downtime(&w, &zoned(at(iso), &tz));
        assert!(!yes("2026-11-03T19:59:00Z")); // 14:59
        assert!(!yes("2026-11-04T01:59:00Z")); // 20:59
        assert!(yes("2026-11-04T02:00:00Z")); // 21:00
        assert!(yes("2026-11-04T04:30:00Z")); // 23:30
        assert!(yes("2026-11-04T05:30:00Z")); // 00:30
        assert!(yes("2026-11-04T11:59:00Z")); // 06:59
        assert!(!yes("2026-11-04T12:00:00Z")); // 07:00
        // Within a day.
        let day = [DowntimeWindow {
            start: "13:00".into(),
            end: "14:00".into(),
        }];
        assert!(in_downtime(&day, &zoned(at("2026-11-03T18:30:00Z"), &tz)));
        assert!(!in_downtime(&day, &zoned(at("2026-11-03T19:00:00Z"), &tz)));
        // Empty and unreadable windows never apply.
        let odd = [
            DowntimeWindow {
                start: "10:00".into(),
                end: "10:00".into(),
            },
            DowntimeWindow {
                start: "25:00".into(),
                end: "07:00".into(),
            },
            DowntimeWindow {
                start: "x".into(),
                end: "y".into(),
            },
        ];
        assert!(!in_downtime(&odd, &zoned(at("2026-11-03T15:00:00Z"), &tz)));
    }

    #[test]
    fn downtime_warns_then_locks_and_is_reported_once_per_window() {
        let r = rules(None, None, &[("21:00", "07:00")], 10);
        let mut s = Sim::new("2026-11-04T01:49:00Z"); // 20:49
        s.step(&r, ACTIVE);
        let ev = s.run(120, &r, ACTIVE); // 20:51: the ten-minute warning came at 20:50
        assert_eq!(
            ev,
            vec![LedgerEvent::Warn {
                cause: Cause::Downtime,
                minutes: 10
            }],
            "{ev:?}"
        );
        let ev = s.run(9 * 60 + 10, &r, ACTIVE); // through 21:00:10
        assert!(!ev.iter().any(|e| matches!(e, LedgerEvent::Warn { .. })), "warned once: {ev:?}");
        assert!(ev.contains(&LedgerEvent::Exhausted { cause: Cause::Downtime }), "{ev:?}");
        assert!(ev.contains(&LedgerEvent::Lock { cause: Cause::Downtime }), "{ev:?}");
        // Time during downtime is not counted against the budget.
        let used = s.ledger.used_secs();
        s.run(60, &r, ACTIVE);
        assert_eq!(s.ledger.used_secs(), used);
        let st = s.step(&r, ACTIVE).status;
        assert!(st.in_downtime);
        assert_eq!(st.downtime_ends_at, Some(at("2026-11-04T12:00:00Z")));
        // Next evening's window is reported again.
        s.now = at("2026-11-05T02:00:10Z");
        s.awake += 5;
        let ev = s.step(&r, ACTIVE).events;
        assert!(ev.contains(&LedgerEvent::Exhausted { cause: Cause::Downtime }), "{ev:?}");
    }

    #[test]
    fn the_downtime_that_started_yesterday_is_one_window() {
        let r = rules(None, None, &[("21:00", "07:00")], 0);
        let mut s = Sim::new("2026-11-04T04:00:00Z"); // 23:00
        let first = s.step(&r, ACTIVE).events;
        assert!(first.contains(&LedgerEvent::Exhausted { cause: Cause::Downtime }));
        // After midnight, still the same window: no second report.
        s.now = at("2026-11-04T06:00:00Z"); // 01:00 on the 4th
        s.awake += 5;
        let ev = s.step(&r, ACTIVE).events;
        assert!(!ev.iter().any(|e| matches!(e, LedgerEvent::Exhausted { .. })), "{ev:?}");
    }

    #[test]
    fn next_downtime_start_handles_midnight_and_dst() {
        let tz = zone(NY);
        let w = [DowntimeWindow {
            start: "21:00".into(),
            end: "07:00".into(),
        }];
        // At 10:00 the next start is 21:00 today.
        assert_eq!(
            next_downtime_start(&w, at("2026-11-03T15:00:00Z"), &tz),
            Some(at("2026-11-04T02:00:00Z"))
        );
        // At 23:00, inside the window, the next start is tomorrow 21:00.
        assert_eq!(
            next_downtime_start(&w, at("2026-11-04T04:00:00Z"), &tz),
            Some(at("2026-11-05T02:00:00Z"))
        );
        // The clocks went back on 1 November: from 07:00 EST that day, 21:00 is 02:00Z the next day.
        assert_eq!(
            next_downtime_start(&w, at("2026-11-01T12:00:00Z"), &tz),
            Some(at("2026-11-02T02:00:00Z"))
        );
        // The evening before the change it is still EDT: 21:00 on 31 October is 01:00Z.
        assert_eq!(
            next_downtime_start(&w, at("2026-10-31T12:00:00Z"), &tz),
            Some(at("2026-11-01T01:00:00Z"))
        );
        // A start inside the spring-forward gap (02:30 does not exist on 8 March) lands on a real instant.
        let gap = [DowntimeWindow {
            start: "02:30".into(),
            end: "03:30".into(),
        }];
        let t = next_downtime_start(&gap, at("2026-03-08T05:00:00Z"), &tz).unwrap();
        assert!(t > at("2026-03-08T05:00:00Z") && t < at("2026-03-08T09:00:00Z"));
        assert_eq!(next_downtime_start(&[], at("2026-11-03T15:00:00Z"), &tz), None);
    }

    #[test]
    fn warnings_stay_quiet_when_off_or_when_nobody_can_see_them() {
        let r = rules(Some(2), Some(2), &[], 0);
        let mut s = Sim::new("2026-11-03T15:00:00Z");
        s.step(&r, ACTIVE);
        let ev = s.run(110, &r, ACTIVE);
        assert!(!ev.iter().any(|e| matches!(e, LedgerEvent::Warn { .. })));
        let r = rules(Some(2), Some(2), &[], 1);
        let mut s = Sim::new("2026-11-03T15:00:00Z");
        s.step(&r, ACTIVE);
        let ev = s.run(80, &r, Console { locked: true, ..ACTIVE });
        assert!(ev.is_empty());
    }
}
