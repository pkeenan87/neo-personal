//! Child mode inside the service (`_specs/v2-m2-child.md` section 7): fetching and verifying the
//! signed policy, closing blocked and not-yet-approved apps, counting screen time and locking,
//! tamper reports, and the two IPC ops (`policy_status`, `request`).
//!
//! This file is glue. What is decided (which process may be closed, how much time is left, whether
//! a clock moved) is decided by the pure modules of `neo-agent-core` (`policy`, `enforce`,
//! `ledger`, `clock`, `tamper`) and tested there; what is done to the computer goes through the
//! `Actuator` and `SystemProbe` traits, so all of it also runs in tests on Linux.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;

use neo_agent_core::api::{ApiClient, ApiError, DeviceRequest, PolicyFetch};
use neo_agent_core::clock::{ClockMemo, ClockWatch, TrustedClock, parse_rfc3339};
use neo_agent_core::enforce::{self, AppContext, Inventory, PendingApp, Platform};
use neo_agent_core::events::{SignalEvent, TamperReason};
use neo_agent_core::ledger::{Cause, Ledger, LedgerEvent, ScreenStatus, StepInput};
use neo_agent_core::policy::{AppRef, PolicyBundle, TrustedKey, VerifyError, verify_envelope};
use neo_agent_core::tamper::{self, Alive, DailyCap, Limiter};

use super::{Agent, DynTransport, Inner, ScanOut};
use crate::actuator::Target;
use crate::persist::{ALIVE_FILE, CHILD_FILE, DataDir, POLICY_FILE};
use crate::protocol::{error_response, ok_response};
use crate::schedule::Task;

/// While a request from this device is open, the policy and the request list are fetched this often.
pub const REQUEST_POLL_SECS: i64 = 60;
/// A stored bundle that expires within this many seconds is refetched unconditionally (no
/// `If-None-Match`), because the ETag does not change when only the timestamps do.
const REFRESH_BEFORE_EXPIRY_SECS: i64 = 86_400;
/// The notice for the same app or the same warning is not repeated within this window.
const NOTICE_REPEAT_SECS: i64 = 60;
/// `app_blocked` for the same app is reported at most this often.
const BLOCKED_REPORT_SECS: i64 = 3600;
/// `tamper_detected` for the same reason is reported at most this often (the server dedupes by hour
/// too; this keeps a determined child from filling the device's daily allowance).
const TAMPER_REPORT_SECS: i64 = 6 * 3600;
/// At most this many Child-mode events a day, over all kinds (the device's own cap is 500).
const CHILD_EVENTS_PER_DAY: u32 = 150;
/// At most this many `app_installed` a day.
const INSTALLS_PER_DAY: u32 = 20;
/// New apps whose main program is hashed and checked in one pass; the rest are named by what is
/// known without opening any file.
const MAX_RESOLVE_PER_PASS: usize = 10;
/// The working state is written at least this often.
const SAVE_EVERY_SECS: i64 = 60;

/// A verified bundle and how it arrived.
#[derive(Debug, Clone)]
pub(super) struct Applied {
    pub bundle: PolicyBundle,
    /// The envelope as received, kept to re-verify it after a restart.
    pub envelope: Value,
    pub etag: Option<String>,
    pub issued_at: i64,
    pub expires_at: Option<i64>,
}

/// `policy.json`.
#[derive(Serialize, Deserialize)]
struct PolicyFile {
    envelope: Value,
    etag: Option<String>,
}

/// `child.json`.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct ChildFile {
    ledger: Ledger,
    inventory: Inventory,
    pending: Vec<PendingApp>,
    memo: ClockMemo,
}

/// Everything Child mode keeps in memory.
pub(super) struct ChildState {
    pub applied: Option<Applied>,
    ledger: Ledger,
    inventory: Inventory,
    pending: Vec<PendingApp>,
    memo: ClockMemo,
    clock: Option<TrustedClock>,
    watch: ClockWatch,
    status: Option<ScreenStatus>,
    extension_enrolled: Option<bool>,
    requests: Vec<DeviceRequest>,
    /// Unix seconds of the next policy and request poll while a request is open.
    next_poll: i64,
    limiter: Limiter,
    events: DailyCap,
    installs: DailyCap,
    last_alive: i64,
    last_save: i64,
    gap_checked: bool,
    dirty: bool,
}

impl ChildState {
    pub fn load(dir: &DataDir, keys: &[TrustedKey]) -> ChildState {
        let file: ChildFile = dir.read_json(CHILD_FILE);
        let applied = dir
            .read_string(POLICY_FILE)
            .and_then(|s| serde_json::from_str::<PolicyFile>(&s).ok())
            .and_then(|f| verify_applied(f.envelope, f.etag, keys).ok());
        ChildState {
            applied,
            ledger: file.ledger,
            inventory: file.inventory,
            pending: file.pending,
            memo: file.memo,
            ..ChildState::empty()
        }
    }

    pub fn empty() -> ChildState {
        ChildState {
            applied: None,
            ledger: Ledger::default(),
            inventory: Inventory::default(),
            pending: Vec::new(),
            memo: ClockMemo::default(),
            clock: None,
            watch: ClockWatch::default(),
            status: None,
            extension_enrolled: None,
            requests: Vec::new(),
            next_poll: 0,
            limiter: Limiter::default(),
            events: DailyCap::default(),
            installs: DailyCap::default(),
            last_alive: 0,
            last_save: 0,
            gap_checked: false,
            dirty: false,
        }
    }

    pub fn set_extension_enrolled(&mut self, v: Option<bool>) {
        self.extension_enrolled = v;
    }

    fn is_child(&self) -> bool {
        self.applied.as_ref().is_some_and(|a| a.bundle.is_child())
    }

    fn has_open_request(&self) -> bool {
        self.requests.iter().any(|r| r.status == "pending")
    }

    fn file(&self) -> String {
        serde_json::to_string(&json!({
            "ledger": self.ledger,
            "inventory": self.inventory,
            "pending": self.pending,
            "memo": self.memo,
        }))
        .unwrap_or_else(|_| "{}".to_string())
    }
}

fn verify_applied(envelope: Value, etag: Option<String>, keys: &[TrustedKey]) -> Result<Applied, VerifyError> {
    let v = verify_envelope(&envelope, keys)?;
    let issued_at = parse_rfc3339(&v.bundle.issued_at).unwrap_or(0);
    let expires_at = parse_rfc3339(&v.bundle.expires_at);
    Ok(Applied {
        bundle: v.bundle,
        envelope,
        etag,
        issued_at,
        expires_at,
    })
}

fn app_key(a: &AppRef) -> String {
    let f = |s: &Option<String>| s.as_deref().unwrap_or("").trim().to_lowercase();
    format!("{}|{}|{}", f(&a.bundle_id), f(&a.signer), f(&a.image))
}

pub(super) fn platform_of(name: &str) -> Platform {
    if name == "macos" { Platform::Mac } else { Platform::Windows }
}

impl Agent {
    // ---- policy -----------------------------------------------------------------------------------

    /// The version of the policy applied now, for the heartbeat.
    pub(super) fn applied_policy_version(&self) -> Option<String> {
        self.lock().child.applied.as_ref().map(|a| a.bundle.policy_version.clone())
    }

    /// Moves the trusted clock to the server's time (from a `Date` header).
    pub(super) fn sync_server_time(&self, server_unix: i64) {
        let boot = self.deps.probe.clocks().boot_secs;
        let mut g = self.lock();
        let wall = self.deps.clock.now().unix_timestamp();
        let memo = g.child.memo.last_trusted;
        let moved = g
            .child
            .clock
            .get_or_insert_with(|| TrustedClock::new(wall, boot, Some(memo)))
            .sync_server(server_unix, boot);
        if moved {
            log::info!("trusted clock set from the server");
        }
    }

    /// `GET /api/devices/policy` and, if it verifies, applies it. Every failure leaves the bundle in
    /// force as it was.
    pub(super) fn fetch_policy(&self, client: &ApiClient<DynTransport>, now: OffsetDateTime) {
        let ts = now.unix_timestamp();
        let (etag, device_id) = {
            let g = self.lock();
            let etag = g.child.applied.as_ref().and_then(|a| {
                let fresh = a.expires_at.is_none_or(|e| e - ts > REFRESH_BEFORE_EXPIRY_SECS);
                fresh.then(|| a.etag.clone().unwrap_or_else(|| format!("\"{}\"", a.bundle.policy_version)))
            });
            (etag, g.meta.device_id.clone())
        };
        match client.policy(etag.as_deref()) {
            Ok(PolicyFetch::NotModified { server_date }) => {
                if let Some(d) = server_date {
                    self.sync_server_time(d);
                }
            }
            Ok(PolicyFetch::Updated {
                envelope,
                etag,
                server_date,
            }) => {
                if let Some(d) = server_date {
                    self.sync_server_time(d);
                }
                self.apply_envelope(envelope, etag, device_id.as_deref(), now);
            }
            Err(ApiError::Disconnected) => self.handle_disconnect(),
            Err(e) => log::warn!("policy fetch failed: {e}"),
        }
    }

    fn apply_envelope(&self, envelope: Value, etag: Option<String>, device_id: Option<&str>, now: OffsetDateTime) {
        let keys = &self.deps.policy_keys;
        let verified = verify_applied(envelope, etag, keys).and_then(|a| {
            // A correctly signed bundle for another device is still not this device's policy.
            if device_id.is_some_and(|id| a.bundle.device_id != id) {
                Err(VerifyError::Malformed)
            } else {
                Ok(a)
            }
        });
        let applied = match verified {
            Ok(a) => a,
            Err(e) => {
                log::warn!("a policy bundle was refused: {e}");
                let ts = now.unix_timestamp();
                let mut g = self.lock();
                let reportable = g.child.limiter.allow("tamper:bad_policy_signature", ts, TAMPER_REPORT_SECS);
                if reportable && g.child.events.take(ts, CHILD_EVENTS_PER_DAY) {
                    g.queue
                        .push([SignalEvent::tamper_detected(now, TamperReason::BadPolicySignature)], now);
                    let _ = self.dir.write_atomic(crate::persist::QUEUE_FILE, &g.queue.to_json());
                }
                return;
            }
        };
        let mut g = self.lock();
        if let Some(cur) = &g.child.applied
            && applied.issued_at < cur.issued_at
        {
            log::warn!("an older policy bundle was ignored");
            return;
        }
        let changed = g.child.applied.as_ref().map(|a| a.bundle.policy_version.as_str()) != Some(applied.bundle.policy_version.as_str());
        log::info!(
            "policy {} applied (mode {}, expires {})",
            applied.bundle.policy_version.get(..8).unwrap_or(""),
            applied.bundle.mode,
            applied.bundle.expires_at
        );
        let file = PolicyFile {
            envelope: applied.envelope.clone(),
            etag: applied.etag.clone(),
        };
        if let Err(e) = self.dir.write_json(POLICY_FILE, &file) {
            log::error!("could not save the policy: {e}");
        }
        if applied.bundle.is_child() {
            enforce::prune_pending(&mut g.child.pending, &applied.bundle);
        } else {
            g.child.pending.clear();
        }
        g.child.applied = Some(applied);
        g.child.dirty = true;
        // A new bundle is enforced at once, not at the next five-second pass.
        g.sched.run_soon(Task::Fast);
        drop(g);
        if changed {
            self.status_changed();
        }
    }

    // ---- requests ---------------------------------------------------------------------------------

    /// Polls the policy (and the device's own requests while one is open) every minute while a request
    /// is open or a command may be on its way (a remote session was seen lately, the heartbeat said a
    /// command is waiting, or a confirmation is open).
    fn poll_requests(&self, now: OffsetDateTime) {
        let ts = now.unix_timestamp();
        let (creds, want_requests) = {
            let mut g = self.lock();
            let want_requests = g.child.has_open_request();
            if !(want_requests || g.commands.wants_poll(ts)) || ts < g.child.next_poll {
                return;
            }
            g.child.next_poll = ts + REQUEST_POLL_SECS;
            (g.creds.as_ref().map(|c| (c.base_url.clone(), c.token.clone())), want_requests)
        };
        let Some((base, token)) = creds else { return };
        let Ok(client) = self.client(&base, Some(&token)) else { return };
        // The policy first: an approval (or a command) is in the bundle before the status says so.
        self.fetch_policy(&client, now);
        if !want_requests {
            return;
        }
        match client.list_requests(false) {
            Ok(list) => self.note_requests(list),
            Err(ApiError::Disconnected) => self.handle_disconnect(),
            Err(e) => log::warn!("request poll failed: {e}"),
        }
    }

    /// Stores the request list and tells the person about answers.
    fn note_requests(&self, list: Vec<DeviceRequest>) {
        let answered: Vec<DeviceRequest> = {
            let mut g = self.lock();
            let was_pending: BTreeSet<String> = g
                .child
                .requests
                .iter()
                .filter(|r| r.status == "pending")
                .map(|r| r.id.clone())
                .collect();
            let answered = list
                .iter()
                .filter(|r| was_pending.contains(&r.id) && r.status != "pending")
                .cloned()
                .collect();
            g.child.requests = list;
            answered
        };
        for r in &answered {
            let (title, body) = match r.status.as_str() {
                "approved" => ("Your request was approved", "A parent said yes. Neo has updated this computer."),
                "denied" => ("A parent said no", "Your request was not approved."),
                _ => ("Your request ran out", "Nobody answered before the day ended. You can ask again."),
            };
            self.notice("request", title, body);
        }
        if !answered.is_empty() {
            self.status_changed();
        }
    }

    /// `{ "op": "request", "kind": "more_time", "minutes": n }`.
    pub(super) fn request_more_time(&self, minutes: u32) -> Value {
        let Some((base, token)) = self.lock().creds.as_ref().map(|c| (c.base_url.clone(), c.token.clone())) else {
            return error_response("not_enrolled", "This computer is not connected to a household.");
        };
        if !self.lock().child.is_child() {
            return error_response("not_child_mode", "Child mode is not on for this computer.");
        }
        let client = match self.client(&base, Some(&token)) {
            Ok(c) => c,
            Err(e) => return super::map_api_error(&e),
        };
        match client.request_more_time(minutes) {
            Ok(r) => {
                let ts = self.deps.clock.now().unix_timestamp();
                {
                    let mut g = self.lock();
                    g.child.requests.retain(|x| x.id != r.id);
                    g.child.requests.insert(0, r.clone());
                    g.child.next_poll = ts + REQUEST_POLL_SECS;
                }
                self.status_changed();
                ok_response(json!({ "id": r.id, "status": r.status, "minutes": minutes }))
            }
            Err(ApiError::Disconnected) => {
                self.handle_disconnect();
                super::map_api_error(&ApiError::Disconnected)
            }
            Err(ApiError::Http { code, .. }) if code == "not_child_mode" => {
                error_response("not_child_mode", "Child mode is not on for this computer.")
            }
            Err(ApiError::Http { code, .. }) if code == "too_many_pending" => error_response(
                "too_many_pending",
                "There are already several requests waiting for a parent. Wait for an answer first.",
            ),
            Err(ApiError::Http { code, .. }) if code == "daily_limit" => {
                error_response("daily_limit", "That is the most requests for one day. Try again tomorrow.")
            }
            Err(e) => super::map_api_error(&e),
        }
    }

    // ---- IPC: policy_status -----------------------------------------------------------------------

    /// What the tray shows: whether Child mode is on, the time left, the next downtime, and requests.
    pub(super) fn policy_status(&self) -> Value {
        let g = self.lock();
        let c = &g.child;
        let Some(a) = &c.applied else {
            return ok_response(json!({ "hasPolicy": false, "childMode": false, "waiting": g.creds.is_some() }));
        };
        let child = a.bundle.is_child();
        let st = c.status.clone().unwrap_or_default();
        let iso = |t: i64| {
            OffsetDateTime::from_unix_timestamp(t)
                .ok()
                .and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok())
        };
        let wall = self.deps.clock.now().unix_timestamp();
        let requests: Vec<Value> = c
            .requests
            .iter()
            .take(5)
            .map(|r| json!({ "id": r.id, "kind": r.kind, "status": r.status, "decidedAt": r.decided_at }))
            .collect();
        ok_response(json!({
            "hasPolicy": true,
            "childMode": child,
            "mode": a.bundle.mode,
            "policyVersion": a.bundle.policy_version,
            "expired": a.expires_at.is_some_and(|e| wall > e),
            "timeZone": a.bundle.time_zone,
            "limited": child && st.budget_secs.is_some(),
            "remainingMinutes": child.then_some(st.remaining_secs).flatten().map(|s| s.div_ceil(60)),
            "usedMinutes": child.then_some(st.used_secs / 60),
            "inDowntime": child && st.in_downtime,
            "nextDowntimeAt": if child { st.next_downtime_at.and_then(iso) } else { None },
            "downtimeEndsAt": if child { st.downtime_ends_at.and_then(iso) } else { None },
            "requests": requests,
            "pendingRequests": c.requests.iter().filter(|r| r.status == "pending").count(),
        }))
    }

    // ---- notices ----------------------------------------------------------------------------------

    /// Tells the person: a push to the tray, or the message-box fallback when no tray is listening.
    pub(super) fn notice(&self, kind: &str, title: &str, body: &str) {
        let delivered = self
            .hub
            .broadcast(&json!({ "push": "notice", "kind": kind, "title": title, "body": body }));
        log::info!("notice ({kind}) shown to {delivered} subscriber(s)");
        if delivered == 0 {
            self.deps.notifier.fallback_warning(title, body);
        }
    }

    fn device_label(&self) -> String {
        self.lock()
            .meta
            .device_name
            .clone()
            .unwrap_or_else(|| self.deps.probe.computer_name())
    }

    // ---- the pass ---------------------------------------------------------------------------------

    /// One pass of Child mode, called by `tick` after the heartbeat and the scan. `fast` is the
    /// five-second cadence (screen time, closing apps, tamper); `slow` the 60-second one (installs).
    pub(super) fn child_pass(&self, now: OffsetDateTime, scan: &ScanOut, fast: bool, slow: bool) {
        let ts = now.unix_timestamp();
        let clocks = self.deps.probe.clocks();
        {
            let mut g = self.lock();
            let memo = g.child.memo.last_trusted;
            g.child
                .clock
                .get_or_insert_with(|| TrustedClock::new(ts, clocks.boot_secs, Some(memo)));
        }
        self.check_service_gap(now, &clocks);
        self.poll_requests(now);

        if slow {
            self.observe_installs(now, scan);
        }
        if fast && self.lock().child.is_child() {
            self.fast_pass(now, scan, &clocks);
        }

        // Journal and working state.
        let (alive_due, save_due) = {
            let g = self.lock();
            (
                ts - g.child.last_alive >= SAVE_EVERY_SECS,
                g.child.dirty || ts - g.child.last_save >= SAVE_EVERY_SECS,
            )
        };
        if alive_due {
            let stamp = Alive::stamp(ts, clocks.boot_secs, clocks.awake_secs);
            if let Ok(text) = serde_json::to_string(&stamp) {
                let _ = self.dir.write_atomic(ALIVE_FILE, &text);
            }
            self.lock().child.last_alive = ts;
        }
        if save_due {
            let mut g = self.lock();
            let text = g.child.file();
            let _ = self.dir.write_atomic(CHILD_FILE, &text);
            g.child.last_save = ts;
            g.child.dirty = false;
        }
    }

    /// `agent_service_stopped`, once per start: the journal's last stamp against now.
    fn check_service_gap(&self, now: OffsetDateTime, clocks: &crate::clocks::Clocks) {
        let ts = now.unix_timestamp();
        {
            let mut g = self.lock();
            if g.child.gap_checked {
                return;
            }
            g.child.gap_checked = true;
        }
        let prev: Alive = self.dir.read_json(ALIVE_FILE);
        let current = Alive::stamp(ts, clocks.boot_secs, clocks.awake_secs);
        let Some(gap) = tamper::service_gap(&prev, &current) else { return };
        log::warn!(
            "the service was not running for about {} minutes while the computer was on",
            gap / 60
        );
        if self.lock().child.is_child() {
            self.push_tamper(now, TamperReason::AgentServiceStopped);
        }
    }

    /// Queues `tamper_detected` unless the same reason was reported recently or the day's allowance
    /// of Child-mode events is spent.
    fn push_tamper(&self, now: OffsetDateTime, reason: TamperReason) {
        let ts = now.unix_timestamp();
        let mut g = self.lock();
        if g.child
            .limiter
            .allow(&format!("tamper:{}", reason.as_str()), ts, TAMPER_REPORT_SECS)
            && g.child.events.take(ts, CHILD_EVENTS_PER_DAY)
        {
            log::warn!("tamper: {}", reason.as_str());
            g.queue.push([SignalEvent::tamper_detected(now, reason)], now);
            let _ = self.dir.write_atomic(crate::persist::QUEUE_FILE, &g.queue.to_json());
        }
    }

    fn queue_event(&self, now: OffsetDateTime, event: SignalEvent) -> bool {
        let ts = now.unix_timestamp();
        let mut g = self.lock();
        if !g.child.events.take(ts, CHILD_EVENTS_PER_DAY) {
            return false;
        }
        g.queue.push([event], now);
        let _ = self.dir.write_atomic(crate::persist::QUEUE_FILE, &g.queue.to_json());
        true
    }

    /// Screen time, apps and tamper checks (Child mode only).
    fn fast_pass(&self, now: OffsetDateTime, scan: &ScanOut, clocks: &crate::clocks::Clocks) {
        let ts = now.unix_timestamp();
        let probe = &*self.deps.probe;
        let (bundle, trusted, offset) = {
            let mut g = self.lock();
            let Some(bundle) = g.child.applied.as_ref().map(|a| a.bundle.clone()) else {
                return;
            };
            let Some(clock) = g.child.clock.as_ref() else { return };
            let trusted = clock.now(clocks.boot_secs);
            let offset = clock.wall_offset(ts, clocks.boot_secs);
            g.child.memo.last_trusted = g.child.memo.last_trusted.max(trusted);
            (bundle, trusted, offset)
        };

        // A changed clock.
        if self.lock().child.watch.check(offset).is_some() {
            self.push_tamper(now, TamperReason::ClockChanged);
        }

        // Screen time and downtime.
        let console = probe.console();
        let out = {
            let mut g = self.lock();
            let out = g.child.ledger.step(&StepInput {
                now: trusted,
                awake_secs: clocks.awake_secs,
                console,
                rules: &bundle.screen_time,
                time_zone: &bundle.time_zone,
            });
            g.child.status = Some(out.status.clone());
            g.child.dirty |= !out.events.is_empty();
            out
        };
        let device = self.device_label();
        for e in &out.events {
            match *e {
                LedgerEvent::Warn { cause: Cause::Budget, minutes } => self.notice(
                    "warning",
                    &format!("{device}: {minutes} {} of screen time left", plural_minutes(minutes)),
                    "Save your work. Neo will lock this computer when the time is up. You can ask a parent for more time from the Neo icon.",
                ),
                LedgerEvent::Warn { cause: Cause::Downtime, minutes } => self.notice(
                    "warning",
                    &format!("{device}: downtime starts in {minutes} {}", plural_minutes(minutes)),
                    "Save your work. Neo will lock this computer when downtime begins.",
                ),
                LedgerEvent::Exhausted { .. } => {
                    self.queue_event(now, SignalEvent::screen_time_exhausted(now));
                }
                LedgerEvent::Lock { cause } => {
                    let (title, body) = match cause {
                        Cause::Budget => (format!("{device}: screen time is up"), "Today's time is used up. Neo is locking this computer."),
                        Cause::Downtime => (format!("{device}: it is downtime"), "This computer is locked until downtime ends."),
                    };
                    self.notice("locked", &title, body);
                    if let Err(e) = self.deps.actuator.lock_session() {
                        log::error!("could not lock the session: {e}");
                    }
                }
            }
        }

        // Apps.
        self.close_apps(now, &bundle, scan, out.status.in_downtime);

        // Tamper.
        if let Some(name) = tamper::running_vpn(&scan.processes) {
            log::info!("a VPN app is running: {name}");
            self.push_tamper(now, TamperReason::VpnApp);
        }
        let ext = self.lock().child.extension_enrolled;
        if tamper::browser_without_extension(&scan.processes, ext) {
            self.push_tamper(now, TamperReason::BrowserWithoutExtension);
        }
    }

    /// Closes the blocked and not-yet-approved apps that are running. The message comes first.
    fn close_apps(&self, now: OffsetDateTime, bundle: &PolicyBundle, scan: &ScanOut, in_downtime: bool) {
        let ts = now.unix_timestamp();
        let probe = &*self.deps.probe;
        let pending = self.lock().child.pending.clone();
        let mut candidates = enforce::candidates(&scan.processes, bundle, &pending);
        if candidates.is_empty() {
            return;
        }
        probe.process_facts(&mut candidates);
        let exclusions = probe.exclusions();
        let ctx = AppContext {
            bundle,
            pending: &pending,
            in_downtime,
            platform: platform_of(probe.platform()),
            exclusions: &exclusions,
        };
        let device = self.device_label();
        for action in enforce::processes_to_close(&candidates, &ctx) {
            let key = app_key(&action.app);
            let (title, body) = match action.reason {
                enforce::CloseReason::Blocked => (
                    format!("{device}: {} is blocked in Child mode", action.name),
                    "A parent has blocked this app. If you need it, ask a parent.".to_string(),
                ),
                enforce::CloseReason::AwaitingApproval => (
                    "Waiting for a parent to approve".to_string(),
                    format!(
                        "{} is new on {device}. Neo asked a parent. It will open once they say yes.",
                        action.name
                    ),
                ),
            };
            if self.lock().child.limiter.allow(&format!("notice:{key}"), ts, NOTICE_REPEAT_SECS) {
                self.notice("blocked", &title, &body);
            }
            let target = Target {
                pid: action.pid,
                image_path: action.image_path.clone(),
            };
            match self.deps.actuator.terminate(&target) {
                Ok(()) => {
                    log::info!("closed {} ({:?})", action.name, action.reason);
                    let report = self.lock().child.limiter.allow(&format!("blocked:{key}"), ts, BLOCKED_REPORT_SECS);
                    if report {
                        self.queue_event(now, SignalEvent::app_blocked(now, &action.name, &action.app));
                    }
                }
                Err(e) => log::warn!("could not close {}: {e}", action.name),
            }
        }
    }

    /// Records the installed apps; a new one on a Child device is reported, and held if the policy
    /// requires approval.
    fn observe_installs(&self, now: OffsetDateTime, scan: &ScanOut) {
        let ts = now.unix_timestamp();
        let probe = &*self.deps.probe;
        let platform = platform_of(probe.platform());
        let apps = match platform {
            Platform::Mac => enforce::installed_from_bundles(&scan.app_bundles),
            Platform::Windows => enforce::installed_from_uninstall(&scan.uninstall_entries),
        };
        // Without a bundle nothing is recorded: the first list after the first bundle is the baseline,
        // so an install while the device had no settings yet is not mistaken for old.
        let (bundle, fresh) = {
            let mut g = self.lock();
            let Some(bundle) = g.child.applied.as_ref().map(|a| a.bundle.clone()) else {
                return;
            };
            let before = g.child.inventory.len();
            let fresh = g.child.inventory.observe(&apps, ts);
            g.child.dirty |= g.child.inventory.len() != before;
            (bundle, fresh)
        };
        if !bundle.is_child() || fresh.is_empty() {
            return;
        }
        for (i, app) in fresh.iter().enumerate() {
            if !self.lock().child.installs.take(ts, INSTALLS_PER_DAY) {
                break;
            }
            let app_ref = self.app_ref_of(app, i < MAX_RESOLVE_PER_PASS);
            log::info!("a new app appeared: {}", app.name);
            self.queue_event(now, SignalEvent::app_installed(now, &app.name, &app_ref));
            let held = bundle.apps.require_approval
                && !app_ref.is_empty()
                && !bundle.apps.approved.iter().any(|a| enforce::ref_covers(a, &app_ref));
            if held {
                let mut g = self.lock();
                g.child.pending.retain(|p| p.app != app_ref);
                g.child.pending.push(PendingApp {
                    name: app.name.clone(),
                    app: app_ref,
                    since: ts,
                });
                let cur = g.child.applied.as_ref().map(|a| a.bundle.clone());
                if let Some(b) = cur {
                    enforce::prune_pending(&mut g.child.pending, &b);
                }
                g.child.dirty = true;
            }
        }
    }

    /// The `AppRef` that identifies a newly installed app. macOS: the bundle id. Windows: the image
    /// name and the signer of its main program (hashing it only when `resolve`); the image name
    /// alone from `DisplayIcon` otherwise.
    fn app_ref_of(&self, app: &enforce::InstalledApp, resolve: bool) -> AppRef {
        if let Some(b) = &app.bundle_id {
            return AppRef {
                bundle_id: Some(b.clone()),
                ..AppRef::default()
            };
        }
        let Some(entry) = &app.entry else { return AppRef::default() };
        let Some(hint) = neo_agent_core::detect::exe_hint(entry) else {
            return AppRef::default();
        };
        if resolve && let Some(f) = self.deps.probe.exe_facts(std::slice::from_ref(&hint)).into_iter().next() {
            let image = f.path.rsplit(['\\', '/']).next().map(str::to_string).filter(|s| !s.is_empty());
            let signer = if f.signed_trusted { f.signer.clone() } else { None };
            return AppRef {
                image,
                signer,
                ..AppRef::default()
            };
        }
        match hint {
            neo_agent_core::detect::ExeHint::File(path) => AppRef {
                image: path.rsplit(['\\', '/']).next().map(str::to_string).filter(|s| !s.is_empty()),
                ..AppRef::default()
            },
            neo_agent_core::detect::ExeHint::FirstExeIn(_) => AppRef::default(),
        }
    }

    // ---- state changes ----------------------------------------------------------------------------

    /// Forgets everything Child mode kept (the device was unenrolled or disconnected): the next
    /// enrollment must not inherit another member's bundle, ledger or pending apps.
    pub(super) fn child_reset(&self, g: &mut Inner) {
        g.child = ChildState::empty();
        for f in [POLICY_FILE, CHILD_FILE, ALIVE_FILE] {
            let _ = self.dir.remove(f);
        }
    }

    /// For tests and `status`: whether a verified Child bundle is in force.
    pub fn child_mode_on(&self) -> bool {
        self.lock().child.is_child()
    }

    /// The processes a pass would look at: for the dev `--dev-pipe` mode and tests.
    #[doc(hidden)]
    pub fn child_pending_apps(&self) -> Vec<PendingApp> {
        self.lock().child.pending.clone()
    }
}

fn plural_minutes(n: u32) -> &'static str {
    if n == 1 { "minute" } else { "minutes" }
}

/// Re-exported so `agent.rs` can name the type in `Inner` without a long path.
pub(super) type State = ChildState;
