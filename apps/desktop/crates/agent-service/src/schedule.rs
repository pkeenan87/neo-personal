//! What to do when. The service loop wakes every second and asks which tasks are due.

use std::collections::BTreeMap;

/// Processes and session logs.
pub const FAST_SECS: i64 = 5;
/// Uninstall entries and services.
pub const SLOW_SECS: i64 = 60;
/// Event-log channels.
pub const EVENTLOG_SECS: i64 = 30;
/// Heartbeat.
pub const HEARTBEAT_SECS: i64 = 3600;
/// Update check.
pub const UPDATE_SECS: i64 = 24 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Task {
    /// Process snapshot and log tailing.
    Fast,
    /// Uninstall entries and services.
    Slow,
    EventLog,
    Heartbeat,
    UpdateCheck,
}

impl Task {
    fn interval(self) -> i64 {
        match self {
            Task::Fast => FAST_SECS,
            Task::Slow => SLOW_SECS,
            Task::EventLog => EVENTLOG_SECS,
            Task::Heartbeat => HEARTBEAT_SECS,
            Task::UpdateCheck => UPDATE_SECS,
        }
    }

    const ALL: [Task; 5] = [Task::Fast, Task::Slow, Task::EventLog, Task::Heartbeat, Task::UpdateCheck];
}

/// Next-run times in unix seconds. Every task is due on the first call (heartbeat and update check
/// "on start", then on their interval).
#[derive(Debug, Default)]
pub struct Schedule {
    next: BTreeMap<Task, i64>,
}

impl Schedule {
    /// The tasks due at `now`; their next run is set to `now` plus the interval. A task that ran
    /// late (a long sleep) is not repeated for the missed periods.
    pub fn due(&mut self, now: i64) -> Vec<Task> {
        let mut out = Vec::new();
        for t in Task::ALL {
            if self.next.get(&t).is_none_or(|n| now >= *n) {
                self.next.insert(t, now + t.interval());
                out.push(t);
            }
        }
        out
    }

    /// Makes `task` due on the next call (e.g. a heartbeat right after a `low` result).
    pub fn run_soon(&mut self, task: Task) {
        self.next.remove(&task);
    }

    /// Sets the next run of `task` to `at` (unix seconds).
    pub fn set_next(&mut self, task: Task, at: i64) {
        self.next.insert(task, at);
    }

    /// Delays `task` by its full interval from `now` (after running it out of band).
    pub fn postpone(&mut self, task: Task, now: i64) {
        self.next.insert(task, now + task.interval());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_due_first_then_on_interval() {
        let mut s = Schedule::default();
        assert_eq!(s.due(1000).len(), 5);
        assert!(s.due(1001).is_empty());
        assert_eq!(s.due(1005), vec![Task::Fast]);
        assert_eq!(s.due(1030), vec![Task::Fast, Task::EventLog]);
        let at60 = s.due(1060);
        assert!(at60.contains(&Task::Slow) && at60.contains(&Task::Fast));
        assert!(!at60.contains(&Task::Heartbeat));
        assert!(s.due(1000 + 3600).contains(&Task::Heartbeat));
        assert!(!s.due(1000 + 3601).contains(&Task::UpdateCheck));
        assert!(s.due(1000 + 24 * 3600).contains(&Task::UpdateCheck));
    }

    #[test]
    fn a_long_sleep_runs_each_task_once() {
        let mut s = Schedule::default();
        s.due(0);
        assert_eq!(s.due(100_000).len(), 5);
        assert!(s.due(100_001).is_empty());
    }

    #[test]
    fn run_soon_and_postpone() {
        let mut s = Schedule::default();
        s.due(0);
        s.run_soon(Task::Heartbeat);
        assert_eq!(s.due(1), vec![Task::Heartbeat]);
        s.postpone(Task::Heartbeat, 2);
        assert!(!s.due(3).contains(&Task::Heartbeat));
    }
}
