//! Commands from the server inside the service (`_specs/v2-m3-cutover.md` section 4): `end_session`.
//!
//! This file is glue. What is decided (is the command genuine and new, must the person confirm, which
//! programs may be closed) is decided by `neo_agent_core::commands` and `enforce::protected_reason`
//! and tested there; what is done to the computer goes through the `Actuator` and `SystemProbe`
//! traits, so all of it also runs in tests on Linux.
//!
//! A command arrives in the signed policy bundle, in **every** mode (an Elder's computer is the main
//! target; this is deliberately outside the Child-mode gate). The service never closes anything on
//! its own say-so: with `requiresConfirmation` the person at the computer answers a prompt first, and
//! no answer in two minutes, or no tray app to show it in, means nothing is closed.

use serde_json::{Value, json};
use time::OffsetDateTime;

use neo_agent_core::commands::{self as core, Book, Prompt, SessionWatch, Step};
use neo_agent_core::events::{CommandOutcome, SignalEvent};
use neo_agent_core::policy::SessionRef;

use super::child::platform_of;
use super::{Agent, ScanOut};
use crate::actuator::Target;
use crate::persist::{COMMANDS_FILE, DataDir, QUEUE_FILE};
use crate::protocol::ok_response;

/// How long the heartbeat's `pendingCommand` keeps the one-minute policy poll on.
pub const HINT_POLL_WINDOW_SECS: i64 = 10 * 60;

/// What the service keeps about commands.
#[derive(Default)]
pub(super) struct State {
    book: Book,
    /// Whether a remote session is (or just was) under way: the fast poll stays on while it is, and ten minutes after.
    watch: SessionWatch,
    /// Unix seconds until which the heartbeat's `pendingCommand` keeps it on.
    hint_until: i64,
    dirty: bool,
}

impl State {
    pub fn load(dir: &DataDir) -> State {
        State {
            book: dir.read_json(COMMANDS_FILE),
            ..State::default()
        }
    }

    /// A remote-access session of `tool_id` was reported on this computer. `observable`: the lists name programs of
    /// the tool, so its session can be watched until the tool stops.
    pub fn note_session(&mut self, tool_id: &str, ts: i64, observable: bool) {
        self.watch.reported(tool_id, ts, observable);
    }

    /// The heartbeat said a command is waiting for this device.
    pub fn note_pending_hint(&mut self, ts: i64) {
        self.hint_until = ts + HINT_POLL_WINDOW_SECS;
    }

    /// Whether the policy should be polled every minute for a command: a session is active (or ended less
    /// than ten minutes ago), the server said one is waiting, or a prompt is open.
    pub fn wants_poll(&self, ts: i64) -> bool {
        self.watch.active(ts) || ts < self.hint_until || !self.book.open_prompts().is_empty()
    }
}

impl Agent {
    /// One pass: read the commands of the bundle in force, expire unanswered prompts, and act on what
    /// that gives. Cheap when there is nothing: called on every tick.
    pub(super) fn commands_pass(&self, now: OffsetDateTime, scan: &ScanOut, fast: bool) {
        let ts = now.unix_timestamp();
        let steps = {
            let mut g = self.lock();
            // The programs of a tool with a reported session decide whether the session is still on.
            if fast {
                let lists = g.lists.clone();
                g.commands.watch.observe(ts, |tool_id| {
                    lists
                        .tools
                        .iter()
                        .find(|t| t.id == tool_id)
                        .is_some_and(|t| scan.processes.iter().any(|p| core::belongs_to(t, p)))
                });
            }
            let commands = g.child.applied.as_ref().map(|a| a.bundle.commands.clone()).unwrap_or_default();
            let mut steps = g.commands.book.intake(&commands, ts);
            steps.extend(g.commands.book.tick(ts));
            g.commands.dirty |= !steps.is_empty();
            steps
        };
        self.run_steps(now, steps);
        self.save_commands();
    }

    /// `{ "op": "command_answer", "id", "answer": "end" | "keep" }`.
    pub(super) fn answer_command(&self, id: &str, end: bool) -> Value {
        let now = self.deps.clock.now();
        let steps = {
            let mut g = self.lock();
            let steps = g.commands.book.answer(id, end, now.unix_timestamp());
            g.commands.dirty |= !steps.is_empty();
            steps
        };
        let answered = !steps.is_empty();
        self.run_steps(now, steps);
        self.save_commands();
        ok_response(json!({ "answered": answered }))
    }

    fn run_steps(&self, now: OffsetDateTime, steps: Vec<Step>) {
        for step in steps {
            match step {
                Step::Ask(prompt) => self.ask(now, &prompt),
                Step::Run { id, session } => {
                    let (outcome, detail) = self.end_session(&session);
                    log::info!("command {id}: {} ({detail})", outcome.as_str());
                    if outcome == CommandOutcome::Done && detail == "closed" {
                        let tool = self.tool_label(&session.tool_id);
                        self.notice(
                            "session",
                            "Remote session ended",
                            &format!("Neo closed {tool} on this computer, as you asked."),
                        );
                    }
                    self.report(now, &id, outcome, Some(detail));
                }
                Step::Report { id, outcome, detail } => self.report(now, &id, outcome, detail),
            }
        }
    }

    /// Shows the confirmation in the tray. With no tray app listening there is nobody to ask, so the
    /// command fails and nothing is closed.
    fn ask(&self, now: OffsetDateTime, prompt: &Prompt) {
        let tool = self.tool_label(&prompt.session.tool_id);
        let deadline = OffsetDateTime::from_unix_timestamp(prompt.deadline)
            .ok()
            .and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok());
        let delivered = self.hub.broadcast(&json!({
            "push": "confirm",
            "id": prompt.id,
            "kind": "end_session",
            "title": format!("Your helper asked to end the remote session from {tool}."),
            "body": "End it now?",
            "expiresAt": deadline,
        }));
        log::info!("end_session prompt {} shown to {delivered} subscriber(s)", prompt.id);
        if delivered == 0 {
            let steps = {
                let mut g = self.lock();
                let steps = g.commands.book.abandon(&prompt.id, "tray_unavailable", now.unix_timestamp());
                g.commands.dirty |= !steps.is_empty();
                steps
            };
            // `abandon` only yields a report.
            self.run_steps(now, steps);
        }
    }

    /// Closes the programs of the tool, if every guard allows it; says what happened.
    fn end_session(&self, session: &SessionRef) -> (CommandOutcome, &'static str) {
        let lists = self.lock().lists.clone();
        let Some(tool) = lists.tools.iter().find(|t| t.id == session.tool_id) else {
            return (CommandOutcome::Failed, "not_supported");
        };
        let probe = &*self.deps.probe;
        let procs = probe.processes();
        let mut found = core::candidates(&procs, tool);
        if found.is_empty() {
            return core::result_for(0, 0, 0);
        }
        // Owner, session and signature are looked up only for the tool's own processes.
        probe.process_facts(&mut found);
        let exclusions = probe.exclusions();
        let may_close = core::closable(&found, platform_of(probe.platform()), &exclusions);
        let mut closed = 0;
        for p in &may_close {
            let target = Target {
                pid: p.pid,
                image_path: p.image_path.clone(),
            };
            match self.deps.actuator.terminate(&target) {
                Ok(()) => closed += 1,
                Err(e) => log::warn!("could not close pid {}: {e}", p.pid),
            }
        }
        core::result_for(found.len(), may_close.len(), closed)
    }

    /// Queues the `command_result` for the server and tells any open prompt it is over.
    fn report(&self, now: OffsetDateTime, id: &str, outcome: CommandOutcome, detail: Option<&str>) {
        {
            let mut g = self.lock();
            g.queue.push([SignalEvent::command_result(now, id, outcome, detail)], now);
            // Sent by this tick's `flush`; the server is waiting for the answer.
            let _ = self.dir.write_atomic(QUEUE_FILE, &g.queue.to_json());
        }
        self.hub.broadcast(&json!({ "push": "confirm_done", "id": id }));
    }

    fn tool_label(&self, tool_id: &str) -> String {
        self.lock()
            .lists
            .tool_name(tool_id)
            .unwrap_or("a remote-access program")
            .to_string()
    }

    fn save_commands(&self) {
        let mut g = self.lock();
        if !g.commands.dirty {
            return;
        }
        g.commands.dirty = false;
        if let Err(e) = self.dir.write_json(COMMANDS_FILE, &g.commands.book) {
            log::error!("could not save the command list: {e}");
        }
    }

    /// Forgets everything about commands (the device was unenrolled or disconnected).
    pub(super) fn commands_reset(&self, g: &mut super::Inner) {
        g.commands = State::default();
        let _ = self.dir.remove(COMMANDS_FILE);
    }
}
