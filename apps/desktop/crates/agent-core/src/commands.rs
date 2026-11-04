//! Commands from the server, as pure decisions (`_specs/v2-m3-cutover.md` section 4): which commands in
//! the verified policy bundle to act on, whether the person at the computer must confirm first, and
//! which programs to close for `end_session`.
//!
//! The service closes a program only after both halves say yes: this module (the command is genuine
//! for this device, unexpired, new, and confirmed when it has to be) and `enforce::protected_reason`
//! (the program is not Neo, the system or a service). The OS calls (the prompt, `terminate`) are in
//! `neo-agent` behind the `Actuator` trait; nothing here touches the OS and the time is always passed in.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::clock::parse_rfc3339;
use crate::enforce::{Exclusions, Platform, protected_reason};
use crate::events::CommandOutcome;
use crate::lists::CompiledTool;
use crate::policy::{Command, SessionRef};
use crate::snapshot::ProcessInfo;

/// The only command kind.
pub const KIND_END_SESSION: &str = "end_session";
/// How long the person has to answer before the command counts as declined.
pub const CONFIRM_TIMEOUT_SECS: i64 = 120;
/// Commands read from one bundle (the server sends one per device and tool; this bounds a bad bundle).
pub const MAX_COMMANDS_PER_BUNDLE: usize = 5;
/// Prompts open at once.
pub const MAX_OPEN_PROMPTS: usize = 3;
/// A handled command id is remembered this long (a replayed old bundle is then still a no-op).
const REMEMBER_SECS: i64 = 24 * 3600;
/// ...and at most this many are remembered.
const MAX_REMEMBERED: usize = 200;

/// A command waiting for the person at the computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    pub id: String,
    pub session: SessionRef,
    /// Unix seconds when it was shown.
    pub asked_at: i64,
    /// Unix seconds when no answer means "declined": two minutes after `asked_at`, or the command's own expiry if sooner.
    pub deadline: i64,
    /// Unix seconds when the command itself expires.
    pub expires_at: i64,
}

/// What the service should do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Show the confirmation (End / Keep) and wait.
    Ask(Prompt),
    /// Close the programs of the tool now.
    Run { id: String, session: SessionRef },
    /// Tell the server what became of the command.
    Report {
        id: String,
        outcome: CommandOutcome,
        detail: Option<&'static str>,
    },
}

/// Which commands have been dealt with (persisted, so a restart or a replayed old bundle never acts
/// twice) and which wait for an answer (not persisted: after a restart the same command is asked
/// again, if it has not expired).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Book {
    /// command id -> unix seconds when it was handled.
    handled: BTreeMap<String, i64>,
    #[serde(skip)]
    prompts: Vec<Prompt>,
}

impl Book {
    /// Reads the commands of the bundle in force and returns what to do about the new ones. Safe to
    /// call on every pass: a command already handled or already asked is skipped.
    pub fn intake(&mut self, commands: &[Command], now: i64) -> Vec<Step> {
        let mut steps = Vec::new();
        for c in commands.iter().take(MAX_COMMANDS_PER_BUNDLE) {
            if c.kind != KIND_END_SESSION
                || c.id.is_empty()
                || c.id.len() > 64
                || c.session_ref.tool_id.is_empty()
                || self.handled.contains_key(&c.id)
                || self.prompts.iter().any(|p| p.id == c.id)
            {
                continue;
            }
            let expires = parse_rfc3339(&c.expires_at);
            let Some(expires) = expires.filter(|e| *e > now) else {
                self.remember(&c.id, now);
                steps.push(Step::Report {
                    id: c.id.clone(),
                    outcome: CommandOutcome::Expired,
                    detail: None,
                });
                continue;
            };
            if c.requires_confirmation {
                if self.prompts.len() >= MAX_OPEN_PROMPTS {
                    continue;
                }
                let prompt = Prompt {
                    id: c.id.clone(),
                    session: c.session_ref.clone(),
                    asked_at: now,
                    deadline: (now + CONFIRM_TIMEOUT_SECS).min(expires),
                    expires_at: expires,
                };
                self.prompts.push(prompt.clone());
                steps.push(Step::Ask(prompt));
            } else {
                self.remember(&c.id, now);
                steps.push(Step::Run {
                    id: c.id.clone(),
                    session: c.session_ref.clone(),
                });
            }
        }
        self.prune(now);
        steps
    }

    /// The person's answer. An unknown id (already answered, timed out, or never asked) does nothing.
    pub fn answer(&mut self, id: &str, end: bool, now: i64) -> Vec<Step> {
        let Some(i) = self.prompts.iter().position(|p| p.id == id) else {
            return Vec::new();
        };
        let p = self.prompts.remove(i);
        self.remember(&p.id, now);
        if now >= p.expires_at {
            return vec![report(p.id, CommandOutcome::Expired, None)];
        }
        if end {
            vec![Step::Run {
                id: p.id,
                session: p.session,
            }]
        } else {
            vec![report(p.id, CommandOutcome::Declined, Some("kept"))]
        }
    }

    /// Prompts nobody answered by their deadline are declined (or expired, if the command ran out first).
    pub fn tick(&mut self, now: i64) -> Vec<Step> {
        let mut steps = Vec::new();
        let mut keep = Vec::new();
        for p in std::mem::take(&mut self.prompts) {
            if now < p.deadline {
                keep.push(p);
                continue;
            }
            self.remember(&p.id, now);
            steps.push(if now >= p.expires_at {
                report(p.id, CommandOutcome::Expired, None)
            } else {
                report(p.id, CommandOutcome::Declined, Some("no_answer"))
            });
        }
        self.prompts = keep;
        steps
    }

    /// The prompt could not be shown (nobody to show it to): the command fails, nothing is closed.
    pub fn abandon(&mut self, id: &str, detail: &'static str, now: i64) -> Vec<Step> {
        let Some(i) = self.prompts.iter().position(|p| p.id == id) else {
            return Vec::new();
        };
        let p = self.prompts.remove(i);
        self.remember(&p.id, now);
        vec![report(p.id, CommandOutcome::Failed, Some(detail))]
    }

    /// Prompts waiting for an answer.
    pub fn open_prompts(&self) -> &[Prompt] {
        &self.prompts
    }

    /// Whether `id` has been dealt with.
    pub fn is_handled(&self, id: &str) -> bool {
        self.handled.contains_key(id)
    }

    fn remember(&mut self, id: &str, now: i64) {
        self.handled.insert(id.to_string(), now);
    }

    fn prune(&mut self, now: i64) {
        self.handled.retain(|_, at| now - *at <= REMEMBER_SECS);
        while self.handled.len() > MAX_REMEMBERED {
            let Some(oldest) = self.handled.iter().min_by_key(|(_, at)| **at).map(|(id, _)| id.clone()) else {
                break;
            };
            self.handled.remove(&oldest);
        }
    }
}

fn report(id: String, outcome: CommandOutcome, detail: Option<&'static str>) -> Step {
    Step::Report { id, outcome, detail }
}

// ---- How long to keep listening for a command -------------------------------------------------------------

/// After the last sign of an active session, the policy is still polled for this long (the owner may ask
/// just after the person closed the window, and the request needs a device that answers).
pub const AFTER_SESSION_SECS: i64 = 10 * 60;
/// A tool whose programs the lists do not name cannot be seen ending, so a report of its session keeps the
/// poll on for this long instead.
pub const UNWATCHABLE_WINDOW_SECS: i64 = 30 * 60;
/// A watched tool whose programs are not running is dropped after this long.
pub const MISSING_GRACE_SECS: i64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Watched {
    last_event: i64,
    last_running: i64,
}

/// Whether a remote session is (or just was) under way on this computer, which is when a request to end
/// it can arrive: the agent then fetches its policy every minute. A session is reported once (by its log
/// line or event) and has no "ended" signal, so it is **watched through the tool's programs**: while any of
/// them runs the session counts as active, and [`AFTER_SESSION_SECS`] after the last sign it stops counting.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionWatch {
    tools: BTreeMap<String, Watched>,
    poll_until: i64,
}

impl SessionWatch {
    /// An incoming session of `tool_id` was reported at `ts`. `observable`: the detection lists name programs
    /// of the tool, so it can be seen running (and ending); otherwise a fixed window is all there is.
    pub fn reported(&mut self, tool_id: &str, ts: i64, observable: bool) {
        if observable {
            self.tools.insert(
                tool_id.to_string(),
                Watched {
                    last_event: ts,
                    last_running: ts,
                },
            );
            self.poll_until = self.poll_until.max(ts + AFTER_SESSION_SECS);
        } else {
            self.poll_until = self.poll_until.max(ts + UNWATCHABLE_WINDOW_SECS);
        }
    }

    /// One look at the running programs (the 5-second scan). `running(tool_id)` says whether any program of
    /// the tool is running now. A running tool keeps the poll on until [`AFTER_SESSION_SECS`] after it stops.
    pub fn observe(&mut self, ts: i64, running: impl Fn(&str) -> bool) {
        let mut until = self.poll_until;
        for (id, w) in self.tools.iter_mut() {
            if running(id) {
                w.last_running = ts;
                until = until.max(ts + AFTER_SESSION_SECS);
            }
        }
        self.poll_until = until;
        self.tools
            .retain(|_, w| ts - w.last_running.max(w.last_event) <= MISSING_GRACE_SECS);
    }

    /// Whether the policy should be polled every minute at `ts` because of a session.
    pub fn active(&self, ts: i64) -> bool {
        ts < self.poll_until
    }

    /// Whether a watched tool is still thought to be running (a session may be open right now).
    pub fn watching(&self) -> bool {
        !self.tools.is_empty()
    }
}

// ---- Which programs to close ------------------------------------------------------------------------

/// Whether the running `p` belongs to `tool`: its image name is one the detection list gives for the
/// tool (the tool's own processes, or a process that exists only during a session), or its macOS
/// bundle id is one of the tool's. Names only: a program that merely has a similar name is not matched.
pub fn belongs_to(tool: &CompiledTool, p: &ProcessInfo) -> bool {
    let name = p.image_name.trim();
    if !name.is_empty()
        && tool
            .process_names
            .iter()
            .chain(tool.process_evidence.iter())
            .any(|n| n.trim().eq_ignore_ascii_case(name))
    {
        return true;
    }
    p.bundle_id
        .as_deref()
        .is_some_and(|b| tool.bundle_ids.iter().any(|t| t.eq_ignore_ascii_case(b.trim())))
}

/// The running processes of `tool`: the only ones whose owner and session the OS probe needs to look
/// up before [`closable`] decides.
pub fn candidates(procs: &[ProcessInfo], tool: &CompiledTool) -> Vec<ProcessInfo> {
    procs.iter().filter(|p| belongs_to(tool, p)).cloned().collect()
}

/// The candidates that may be closed: those that pass the same guards as app blocking (not Neo, not
/// the system, not a service, not Apple's). A fact the OS probe could not read protects the process.
pub fn closable(cands: &[ProcessInfo], platform: Platform, ex: &Exclusions) -> Vec<ProcessInfo> {
    cands
        .iter()
        .filter(|p| protected_reason(p, platform, ex).is_none())
        .cloned()
        .collect()
}

/// What to tell the server after trying to close the tool: how many processes belong to it (`found`),
/// how many of those may be closed, and how many were closed. Nothing running is "done": the session
/// is no longer there, and the detail says so.
pub fn result_for(found: usize, may_close: usize, closed: usize) -> (CommandOutcome, &'static str) {
    if found == 0 {
        (CommandOutcome::Done, "not_running")
    } else if may_close == 0 {
        (CommandOutcome::Failed, "protected")
    } else if closed == 0 {
        (CommandOutcome::Failed, "close_failed")
    } else {
        (CommandOutcome::Done, "closed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lists::{CompiledLists, DetectionLists, MacosSignatures, RemoteAccessTool, WindowsSignatures};

    const NOW: i64 = 1_800_000_000;

    fn iso(ts: i64) -> String {
        time::OffsetDateTime::from_unix_timestamp(ts)
            .unwrap()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    }

    fn cmd(id: &str, confirm: bool, expires_in: i64) -> Command {
        Command {
            id: id.into(),
            kind: KIND_END_SESSION.into(),
            session_ref: SessionRef {
                tool_id: "anydesk".into(),
                peer_id: Some("123 456".into()),
            },
            requires_confirmation: confirm,
            expires_at: iso(NOW + expires_in),
        }
    }

    fn reports(steps: &[Step]) -> Vec<(&str, CommandOutcome, Option<&'static str>)> {
        steps
            .iter()
            .filter_map(|s| match s {
                Step::Report { id, outcome, detail } => Some((id.as_str(), *outcome, *detail)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_command_that_needs_confirmation_is_asked_not_run() {
        let mut b = Book::default();
        let steps = b.intake(&[cmd("c1", true, 600)], NOW);
        let [Step::Ask(p)] = steps.as_slice() else { panic!("{steps:?}") };
        assert_eq!(
            (p.id.as_str(), p.asked_at, p.deadline, p.expires_at),
            ("c1", NOW, NOW + 120, NOW + 600)
        );
        assert_eq!(p.session.tool_id, "anydesk");
        assert_eq!(b.open_prompts().len(), 1);
        assert!(!b.is_handled("c1"));
    }

    #[test]
    fn confirming_runs_it_once() {
        let mut b = Book::default();
        b.intake(&[cmd("c1", true, 600)], NOW);
        let steps = b.answer("c1", true, NOW + 20);
        assert!(matches!(steps.as_slice(), [Step::Run { id, session }] if id == "c1" && session.tool_id == "anydesk"));
        assert!(b.is_handled("c1"));
        assert!(b.open_prompts().is_empty());
        // A second answer, and the same bundle again, do nothing.
        assert!(b.answer("c1", true, NOW + 21).is_empty());
        assert!(b.intake(&[cmd("c1", true, 600)], NOW + 22).is_empty());
    }

    #[test]
    fn keeping_declines_and_closes_nothing() {
        let mut b = Book::default();
        b.intake(&[cmd("c1", true, 600)], NOW);
        let steps = b.answer("c1", false, NOW + 5);
        assert_eq!(reports(&steps), [("c1", CommandOutcome::Declined, Some("kept"))]);
        assert!(!steps.iter().any(|s| matches!(s, Step::Run { .. })));
        assert!(b.intake(&[cmd("c1", true, 600)], NOW + 6).is_empty());
    }

    #[test]
    fn no_answer_in_two_minutes_is_declined() {
        let mut b = Book::default();
        b.intake(&[cmd("c1", true, 600)], NOW);
        assert!(b.tick(NOW + 119).is_empty());
        let steps = b.tick(NOW + 120);
        assert_eq!(reports(&steps), [("c1", CommandOutcome::Declined, Some("no_answer"))]);
        // Too late to answer now.
        assert!(b.answer("c1", true, NOW + 121).is_empty());
        assert!(b.tick(NOW + 500).is_empty());
    }

    #[test]
    fn the_command_running_out_first_is_expired_not_declined() {
        let mut b = Book::default();
        b.intake(&[cmd("c1", true, 30)], NOW);
        assert_eq!(b.open_prompts()[0].deadline, NOW + 30);
        assert_eq!(reports(&b.tick(NOW + 30)), [("c1", CommandOutcome::Expired, None)]);
    }

    #[test]
    fn an_answer_after_the_command_expired_does_not_run_it() {
        let mut b = Book::default();
        b.intake(&[cmd("c1", true, 30)], NOW);
        let steps = b.answer("c1", true, NOW + 31);
        assert_eq!(reports(&steps), [("c1", CommandOutcome::Expired, None)]);
        assert!(!steps.iter().any(|s| matches!(s, Step::Run { .. })));
    }

    #[test]
    fn an_expired_command_is_reported_once_and_never_acted_on() {
        let mut b = Book::default();
        let steps = b.intake(&[cmd("old", true, -1), cmd("older", false, 0)], NOW);
        assert_eq!(
            reports(&steps),
            [("old", CommandOutcome::Expired, None), ("older", CommandOutcome::Expired, None)]
        );
        assert!(!steps.iter().any(|s| matches!(s, Step::Run { .. } | Step::Ask(_))));
        assert!(b.intake(&[cmd("old", true, -1)], NOW + 1).is_empty());
        // A bad expiry is not acted on either.
        let mut bad = cmd("bad", false, 600);
        bad.expires_at = "tomorrow".into();
        assert_eq!(reports(&b.intake(&[bad], NOW)), [("bad", CommandOutcome::Expired, None)]);
    }

    #[test]
    fn a_command_without_confirmation_runs_at_once_and_only_once() {
        let mut b = Book::default();
        let steps = b.intake(&[cmd("c1", false, 600)], NOW);
        assert!(matches!(steps.as_slice(), [Step::Run { id, .. }] if id == "c1"));
        assert!(b.intake(&[cmd("c1", false, 600)], NOW + 5).is_empty());
    }

    #[test]
    fn a_duplicate_in_one_bundle_and_across_passes_is_one_prompt() {
        let mut b = Book::default();
        let steps = b.intake(&[cmd("c1", true, 600), cmd("c1", true, 600)], NOW);
        assert_eq!(steps.len(), 1);
        assert!(b.intake(&[cmd("c1", true, 600)], NOW + 5).is_empty());
        assert_eq!(b.open_prompts().len(), 1);
    }

    #[test]
    fn unknown_kinds_and_malformed_commands_are_ignored_without_a_trace() {
        let mut b = Book::default();
        let mut other = cmd("c1", false, 600);
        other.kind = "lock_screen".into();
        let mut no_id = cmd("", false, 600);
        no_id.id = String::new();
        let mut no_tool = cmd("c3", false, 600);
        no_tool.session_ref.tool_id = String::new();
        let mut long = cmd("x", false, 600);
        long.id = "x".repeat(65);
        assert!(b.intake(&[other, no_id, no_tool, long], NOW).is_empty());
        assert!(!b.is_handled("c1"));
    }

    #[test]
    fn at_most_a_few_commands_per_bundle_and_a_few_prompts_at_once() {
        let mut b = Book::default();
        let many: Vec<Command> = (0..10).map(|i| cmd(&format!("c{i}"), true, 600)).collect();
        let steps = b.intake(&many, NOW);
        assert_eq!(steps.len(), MAX_OPEN_PROMPTS);
        assert_eq!(b.open_prompts().len(), MAX_OPEN_PROMPTS);
        // Answering one frees a place; the next pass asks the next command.
        b.answer("c0", false, NOW + 1);
        let more = b.intake(&many, NOW + 2);
        assert!(matches!(more.as_slice(), [Step::Ask(p)] if p.id == "c3"));
    }

    #[test]
    fn a_prompt_that_cannot_be_shown_fails_the_command() {
        let mut b = Book::default();
        b.intake(&[cmd("c1", true, 600)], NOW);
        let steps = b.abandon("c1", "tray_unavailable", NOW + 1);
        assert_eq!(reports(&steps), [("c1", CommandOutcome::Failed, Some("tray_unavailable"))]);
        assert!(b.open_prompts().is_empty());
        assert!(b.abandon("c1", "tray_unavailable", NOW + 2).is_empty());
    }

    #[test]
    fn handled_ids_survive_a_restart_but_prompts_do_not() {
        let mut b = Book::default();
        b.intake(&[cmd("done", false, 600), cmd("asked", true, 600)], NOW);
        let text = serde_json::to_string(&b).unwrap();
        let mut restarted: Book = serde_json::from_str(&text).unwrap();
        assert!(restarted.is_handled("done"));
        // The replayed bundle does not run "done" again; "asked" is asked again, with a fresh window.
        let steps = restarted.intake(&[cmd("done", false, 600), cmd("asked", true, 600)], NOW + 30);
        let [Step::Ask(p)] = steps.as_slice() else { panic!("{steps:?}") };
        assert_eq!((p.id.as_str(), p.deadline), ("asked", NOW + 150));
    }

    #[test]
    fn old_ids_are_forgotten_after_a_day_and_the_list_is_bounded() {
        let mut b = Book::default();
        b.intake(&[cmd("c1", false, 600)], NOW);
        b.intake(&[], NOW + REMEMBER_SECS + 1);
        // Forgotten, but its expiry has long passed, so a replay is only an `expired` report.
        assert!(!b.is_handled("c1"));
        let mut b = Book::default();
        for i in 0..(MAX_REMEMBERED + 20) {
            b.remember(&format!("id{i}"), NOW + i as i64);
        }
        b.intake(&[], NOW + 1000);
        assert_eq!(b.handled.len(), MAX_REMEMBERED);
        assert!(!b.is_handled("id0"));
        assert!(b.is_handled(&format!("id{}", MAX_REMEMBERED + 19)));
    }

    // ---- targets ----

    fn lists() -> CompiledLists {
        CompiledLists::compile(&DetectionLists {
            remote_access_tools: vec![
                RemoteAccessTool {
                    id: "anydesk".into(),
                    name: "AnyDesk".into(),
                    windows: WindowsSignatures {
                        process_names: vec!["AnyDesk.exe".into()],
                        ..Default::default()
                    },
                    macos: MacosSignatures {
                        bundle_ids: vec!["com.philandro.anydesk".into()],
                        ..Default::default()
                    },
                },
                RemoteAccessTool {
                    id: "teamviewer".into(),
                    name: "TeamViewer".into(),
                    windows: WindowsSignatures {
                        process_names: vec!["TeamViewer.exe".into(), "TeamViewer_Service.exe".into()],
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ],
            ..Default::default()
        })
    }

    fn win(pid: u32, image: &str) -> ProcessInfo {
        ProcessInfo {
            pid,
            image_name: image.into(),
            image_path: format!("C:\\Program Files\\Tool\\{image}"),
            session_id: Some(1),
            system_owned: Some(false),
            ..Default::default()
        }
    }

    fn exclusions() -> Exclusions {
        Exclusions {
            own_pids: vec![999],
            windir: "C:\\Windows".into(),
            own_dirs: vec!["C:\\Program Files\\Neo".into()],
        }
    }

    fn tool<'a>(l: &'a CompiledLists, id: &str) -> &'a CompiledTool {
        l.tools.iter().find(|t| t.id == id).unwrap()
    }

    #[test]
    fn only_the_named_tools_processes_are_candidates() {
        let l = lists();
        let procs = vec![
            win(10, "anydesk.exe"),
            win(11, "AnyDesk.exe"),
            win(12, "TeamViewer.exe"),
            win(13, "notepad.exe"),
            win(14, "AnyDesk.exe.bak"),
        ];
        let c = candidates(&procs, tool(&l, "anydesk"));
        assert_eq!(c.iter().map(|p| p.pid).collect::<Vec<_>>(), [10, 11]);
        let c = candidates(&procs, tool(&l, "teamviewer"));
        assert_eq!(c.iter().map(|p| p.pid).collect::<Vec<_>>(), [12]);
    }

    #[test]
    fn a_mac_bundle_id_matches_the_tool() {
        let l = lists();
        let p = ProcessInfo {
            pid: 20,
            image_name: "AnyDesk".into(),
            image_path: "/Applications/AnyDesk.app/Contents/MacOS/AnyDesk".into(),
            bundle_id: Some("com.philandro.AnyDesk".into()),
            system_owned: Some(false),
            apple_signed: Some(false),
            ..Default::default()
        };
        assert!(belongs_to(tool(&l, "anydesk"), &p));
        assert!(!belongs_to(tool(&l, "teamviewer"), &p));
        assert_eq!(closable(&[p], Platform::Mac, &Exclusions::default()).len(), 1);
    }

    #[test]
    fn the_guards_of_app_blocking_apply() {
        let l = lists();
        let t = tool(&l, "teamviewer");
        let service = ProcessInfo {
            session_id: Some(0),
            system_owned: Some(true),
            ..win(30, "TeamViewer_Service.exe")
        };
        let unknown_owner = ProcessInfo {
            system_owned: None,
            ..win(31, "TeamViewer.exe")
        };
        let under_windir = ProcessInfo {
            image_path: "C:\\Windows\\System32\\TeamViewer.exe".into(),
            ..win(32, "TeamViewer.exe")
        };
        let neo_itself = ProcessInfo {
            image_path: "C:\\Program Files\\Neo\\TeamViewer.exe".into(),
            ..win(33, "TeamViewer.exe")
        };
        let own = win(999, "TeamViewer.exe");
        let ok = win(34, "TeamViewer.exe");
        let procs = vec![service, unknown_owner, under_windir, neo_itself, own, ok];
        let cands = candidates(&procs, t);
        assert_eq!(cands.len(), 6);
        let may = closable(&cands, Platform::Windows, &exclusions());
        assert_eq!(may.iter().map(|p| p.pid).collect::<Vec<_>>(), [34]);
        // With no %WINDIR% the rule cannot be evaluated, so nothing is closed.
        assert!(
            closable(
                &cands,
                Platform::Windows,
                &Exclusions {
                    windir: String::new(),
                    ..exclusions()
                }
            )
            .is_empty()
        );
    }

    #[test]
    fn the_result_never_claims_more_than_happened() {
        assert_eq!(result_for(0, 0, 0), (CommandOutcome::Done, "not_running"));
        assert_eq!(result_for(2, 0, 0), (CommandOutcome::Failed, "protected"));
        assert_eq!(result_for(2, 1, 0), (CommandOutcome::Failed, "close_failed"));
        assert_eq!(result_for(2, 2, 1), (CommandOutcome::Done, "closed"));
    }

    #[test]
    fn a_session_keeps_the_poll_on_while_the_tool_runs_and_ten_minutes_after() {
        let mut w = SessionWatch::default();
        assert!(!w.active(NOW));
        w.reported("anydesk", NOW, true);
        assert!(w.active(NOW) && w.watching());
        // The tool keeps running for two hours: still active, not just for 30 minutes.
        for step in 1..=(2 * 3600 / 5) {
            w.observe(NOW + step * 5, |id| id == "anydesk");
        }
        let last_seen = NOW + 2 * 3600;
        assert!(w.active(last_seen + 5) && w.watching());
        // It stops: active for ten more minutes, and the watch is dropped after a minute.
        w.observe(last_seen + 5, |_| false);
        assert!(w.watching(), "a minute of grace");
        w.observe(last_seen + 70, |_| false);
        assert!(!w.watching());
        assert!(w.active(last_seen + AFTER_SESSION_SECS - 1));
        assert!(!w.active(last_seen + AFTER_SESSION_SECS + 1));
    }

    #[test]
    fn a_session_that_was_never_seen_running_ends_ten_minutes_after_it_was_reported() {
        let mut w = SessionWatch::default();
        w.reported("anydesk", NOW, true);
        w.observe(NOW + 5, |_| false);
        w.observe(NOW + 100, |_| false);
        assert!(!w.watching());
        assert!(w.active(NOW + 599) && !w.active(NOW + 601));
    }

    #[test]
    fn a_tool_that_cannot_be_watched_gets_a_fixed_window_and_other_tools_are_independent() {
        let mut w = SessionWatch::default();
        w.reported("splashtop", NOW, false);
        assert!(!w.watching(), "nothing to watch");
        assert!(w.active(NOW + 1799) && !w.active(NOW + 1801));
        w.reported("anydesk", NOW + 100, true);
        w.reported("teamviewer", NOW + 100, true);
        w.observe(NOW + 110, |id| id == "teamviewer");
        w.observe(NOW + 200, |id| id == "teamviewer");
        assert!(w.watching(), "teamviewer is still running; anydesk was dropped");
        assert_eq!(w.tools.len(), 1);
    }

    #[test]
    fn bundle_commands_deserialize_from_the_wire_shape() {
        let c: Command = serde_json::from_str(
            r#"{"id":"c1","kind":"end_session","sessionRef":{"toolId":"anydesk","peerId":"1 2"},"requiresConfirmation":true,"expiresAt":"2026-11-03T12:10:00.000Z","future":1}"#,
        )
        .unwrap();
        assert_eq!(c.session_ref.peer_id.as_deref(), Some("1 2"));
        assert!(c.requires_confirmation);
        let minimal: Command = serde_json::from_str(r#"{"id":"c","kind":"x"}"#).unwrap();
        assert!(!minimal.requires_confirmation && minimal.session_ref.tool_id.is_empty());
    }
}
