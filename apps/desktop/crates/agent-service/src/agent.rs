//! The service's brain: scheduling, scanning, detection, the queue, warnings, enrollment and
//! updates. It talks to the OS only through the traits in [`crate::probe`], [`crate::secrets`],
//! [`Notifier`], [`Clock`] and [`crate::update::Updater`], so all of it runs in tests on Linux.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use serde_json::{Value, json};
use time::OffsetDateTime;

use neo_agent_core::api::{
    ApiClient, ApiError, DeviceFlowPoll, HttpRequest, HttpResponse, SignalResult, SignalStatus, Transport, TransportError,
};
use neo_agent_core::detect::{self, ExeHint};
use neo_agent_core::events::{EventBody, SignalEvent};
use neo_agent_core::lists::{CompiledLists, DetectionLists};
use neo_agent_core::queue::EventQueue;
use neo_agent_core::snapshot::Snapshot;
use neo_agent_core::state::{Cursors, History, SeenState};
use neo_agent_core::warn::{ExpectedTool, WarningKind, decide_with_lists};
use time::Duration;

use crate::config;
use crate::hub::Hub;
use crate::persist::{CURSORS_FILE, DataDir, LISTS_FILE, META_FILE, Meta, QUEUE_FILE, SEEN_FILE};
use crate::probe::SystemProbe;
use crate::protocol::{Request, error_response, ok_response};
use crate::schedule::{Schedule, Task};
use crate::secrets::{Credentials, SecretStore};
use crate::text::fallback_text;
use crate::update::Updater;

/// The lists compiled into the binary (first run and offline fallback). Regenerate with
/// `pnpm --filter @neo/desktop build`.
const BUILTIN_LISTS: &str = include_str!("../data/lists-snapshot.json");
/// At most this many programs are hashed per 60-second scan.
const MAX_EXE_HINTS_PER_SCAN: usize = 50;
/// How long a failed heartbeat waits before the next try.
const HEARTBEAT_RETRY_SECS: i64 = 300;
/// Warnings remembered so the owner-told update can reach an open window.
const MAX_REMEMBERED_WARNINGS: usize = 50;
const DEFAULT_OWNER: &str = "the household owner";
/// While Full Disk Access is missing, it is re-probed this often (the tray can ask sooner).
const FDA_REPROBE_SECS: i64 = 300;
/// The daemon exits for a relaunch at most this often (only the tray's "Done" button asks for it).
const FDA_RELAUNCH_MIN_SECS: i64 = 60;
/// The relaunch waits this long so the reply to the tray is written first.
const RELAUNCH_DELAY: std::time::Duration = std::time::Duration::from_secs(1);

pub trait Clock: Send + Sync {
    fn now(&self) -> OffsetDateTime;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

/// Speaks when nobody is subscribed to pushes (no tray app running).
pub trait Notifier: Send + Sync {
    fn fallback_warning(&self, title: &str, text: &str);
}

/// Discards messages (Linux dev mode).
pub struct NullNotifier;

impl Notifier for NullNotifier {
    fn fallback_warning(&self, title: &str, text: &str) {
        log::info!("fallback warning (not shown): {title}");
        let _ = text;
    }
}

/// A shareable, type-erased HTTP transport.
#[derive(Clone)]
pub struct DynTransport(pub Arc<dyn Transport + Send + Sync>);

impl Transport for DynTransport {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        self.0.send(req)
    }
}

pub struct Deps {
    pub probe: Box<dyn SystemProbe>,
    pub secrets: Box<dyn SecretStore>,
    pub notifier: Box<dyn Notifier>,
    pub clock: Box<dyn Clock>,
    pub transport: DynTransport,
    pub updater: Box<dyn Updater>,
}

#[derive(Debug, Clone)]
struct SignIn {
    device_code: String,
    base_url: String,
    interval: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct Warning {
    event_id: String,
    kind: WarningKind,
    tool_name: String,
    peer_id: Option<String>,
    severity: &'static str,
    owner_name: String,
    owner_told: bool,
    /// `permission` warnings: which permission (`screen_recording`, `accessibility`, `full_disk_access`).
    service: Option<&'static str>,
}

impl Warning {
    fn push(&self) -> Value {
        let mut v = json!({
            "push": "warning",
            "eventId": self.event_id,
            "kind": self.kind,
            "toolName": self.tool_name,
            "severity": self.severity,
            "ownerName": self.owner_name,
            "ownerTold": self.owner_told,
        });
        if let Some(p) = &self.peer_id {
            v["peerId"] = json!(p);
        }
        if let Some(svc) = self.service {
            v["service"] = json!(svc);
        }
        v
    }
}

struct Inner {
    meta: Meta,
    creds: Option<Credentials>,
    lists: Arc<CompiledLists>,
    seen: SeenState,
    cursors: Cursors,
    queue: EventQueue,
    sched: Schedule,
    sign_in: Option<SignIn>,
    warned: HashMap<String, Warning>,
    /// macOS: whether the daemon can read the TCC database; `None` = not probed yet or not macOS.
    fda: Option<bool>,
    /// Unix seconds of the last Full Disk Access probe.
    fda_probed_at: i64,
}

pub struct Agent {
    deps: Deps,
    dir: DataDir,
    hub: Hub,
    inner: Mutex<Inner>,
    /// macOS: set when the daemon should exit so that launchd relaunches it (see `probe_permissions`).
    relaunch: Mutex<Option<Instant>>,
}

fn builtin_lists() -> DetectionLists {
    serde_json::from_str(BUILTIN_LISTS).unwrap_or_default()
}

fn map_api_error(e: &ApiError) -> Value {
    match e {
        ApiError::Disconnected => error_response("disconnected", "This computer is no longer connected to a household."),
        ApiError::RateLimited { .. } => error_response("rate_limited", "Too many tries. Wait a minute and try again."),
        ApiError::Transport(_) => error_response("server_unreachable", "Couldn't reach Neo. Check your connection and try again."),
        ApiError::BadBaseUrl(_) => error_response("invalid_server_url", "That doesn't look like a valid server address."),
        ApiError::Http { status: 404, .. } => error_response("invalid_code", "That code isn't valid, or it has expired."),
        ApiError::Http { code, .. } if code == "device_limit" => {
            error_response("device_limit", "This household has reached its limit of devices.")
        }
        ApiError::Http { .. } | ApiError::InsufficientScope | ApiError::Decode(_) => {
            error_response("server_error", "Neo couldn't complete that. Try again in a moment.")
        }
    }
}

/// The name the sign-in page shows for this program.
fn client_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Neo for Mac"
    } else {
        "Neo for Windows"
    }
}

fn iso(ts: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp(ts)
        .ok()
        .and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok())
}

impl Agent {
    pub fn new(deps: Deps, dir: DataDir) -> Agent {
        let _ = dir.ensure();
        let creds = match deps.secrets.load() {
            Ok(c) => c,
            Err(e) => {
                log::error!("could not read the device token: {e}");
                None
            }
        };
        let lists_json: Option<DetectionLists> = dir.read_string(LISTS_FILE).and_then(|s| serde_json::from_str(&s).ok());
        let lists = CompiledLists::compile(&lists_json.unwrap_or_else(builtin_lists));
        let meta: Meta = dir.read_json(META_FILE);
        let inner = Inner {
            meta,
            creds,
            lists: Arc::new(lists),
            seen: SeenState::from_json(&dir.read_string(SEEN_FILE).unwrap_or_default()),
            cursors: Cursors::from_json(&dir.read_string(CURSORS_FILE).unwrap_or_default()),
            queue: EventQueue::from_json(&dir.read_string(QUEUE_FILE).unwrap_or_default()),
            sched: Schedule::default(),
            sign_in: None,
            warned: HashMap::new(),
            fda: None,
            fda_probed_at: 0,
        };
        Agent {
            deps,
            dir,
            hub: Hub::default(),
            inner: Mutex::new(inner),
            relaunch: Mutex::new(None),
        }
    }

    pub fn hub(&self) -> &Hub {
        &self.hub
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn client(&self, base: &str, token: Option<&str>) -> Result<ApiClient<DynTransport>, ApiError> {
        let mut c = ApiClient::new(base, self.deps.transport.clone())?;
        c.set_token(token.map(str::to_string));
        Ok(c)
    }

    fn base_url_for(inner: &Inner, requested: Option<&str>) -> String {
        requested
            .map(str::to_string)
            .or_else(|| inner.meta.base_url.clone())
            .unwrap_or_else(|| config::DEFAULT_BASE_URL.to_string())
    }

    fn save_meta(&self, inner: &Inner) {
        if let Err(e) = self.dir.write_json(META_FILE, &inner.meta) {
            log::error!("could not save agent state: {e}");
        }
    }

    fn save_all(&self, inner: &Inner) {
        self.save_meta(inner);
        let _ = self.dir.write_atomic(SEEN_FILE, &inner.seen.to_json());
        let _ = self.dir.write_atomic(QUEUE_FILE, &inner.queue.to_json());
        let _ = self.dir.write_atomic(CURSORS_FILE, &inner.cursors.to_json());
    }

    // ---- status -----------------------------------------------------------------------------

    pub fn status(&self) -> Value {
        let full_disk_access = self.full_disk_access_known();
        let g = self.lock();
        let state = if g.creds.is_some() {
            "enrolled"
        } else if g.meta.disconnected {
            "disconnected"
        } else {
            "not_enrolled"
        };
        ok_response(json!({
            "state": state,
            "version": config::VERSION,
            "serverUrl": Self::base_url_for(&g, None),
            "computerName": self.deps.probe.computer_name(),
            "deviceName": g.meta.device_name,
            "memberName": g.meta.member_name,
            "householdName": g.meta.household_name,
            "ownerName": g.meta.owner_name,
            "lastCheckIn": g.meta.last_heartbeat.and_then(iso),
            "lastWarningAt": g.meta.last_warning.and_then(iso),
            "updateAvailable": g.meta.update_available,
            "platform": self.deps.probe.platform(),
            "fullDiskAccess": full_disk_access,
        }))
    }

    /// The cached Full Disk Access state, probing once if it was never probed. `None` off macOS.
    fn full_disk_access_known(&self) -> Option<bool> {
        let cached = self.lock().fda;
        match cached {
            Some(v) => Some(v),
            None => self.refresh_fda(self.deps.clock.now().unix_timestamp(), true),
        }
    }

    /// Probes Full Disk Access and returns the state. Always when `force` (the tray's Done button);
    /// otherwise on every call (the probe is one `open`) unless it is known to be missing, which is
    /// re-probed only every [`FDA_REPROBE_SECS`]. A change is pushed to the tray.
    fn refresh_fda(&self, ts: i64, force: bool) -> Option<bool> {
        {
            let g = self.lock();
            if !force && g.fda == Some(false) && ts - g.fda_probed_at < FDA_REPROBE_SECS {
                return g.fda;
            }
        }
        let now = self.deps.probe.full_disk_access();
        let changed = {
            let mut g = self.lock();
            g.fda_probed_at = ts;
            let changed = g.fda != now && g.fda.is_some();
            g.fda = now;
            changed
        };
        if changed {
            log::info!("full disk access is now {now:?}");
            self.status_changed();
        }
        now
    }

    /// `probe_permissions`: look at Full Disk Access now. A grant only becomes visible to a process
    /// started after it, so the first failed probe makes the daemon exit once for launchd to
    /// relaunch it (KeepAlive); the tray asks again after a moment.
    fn probe_permissions(&self) -> Value {
        let ts = self.deps.clock.now().unix_timestamp();
        match self.refresh_fda(ts, true) {
            Some(false) => {
                let restarting = {
                    let mut g = self.lock();
                    let allowed = g.meta.fda_relaunch_at.is_none_or(|t| ts - t >= FDA_RELAUNCH_MIN_SECS);
                    if allowed {
                        g.meta.fda_relaunch_at = Some(ts);
                        self.save_meta(&g);
                    }
                    allowed
                };
                if restarting {
                    log::info!("full disk access is not visible; restarting once to pick up a new grant");
                    *self.relaunch.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now() + RELAUNCH_DELAY);
                }
                ok_response(json!({ "fullDiskAccess": false, "restarting": restarting }))
            }
            Some(true) => {
                let mut g = self.lock();
                if g.meta.fda_relaunch_at.take().is_some() {
                    self.save_meta(&g);
                }
                ok_response(json!({ "fullDiskAccess": true, "restarting": false }))
            }
            None => ok_response(json!({ "fullDiskAccess": null, "restarting": false })),
        }
    }

    /// Whether the service loop should end now so that launchd relaunches the daemon.
    pub fn relaunch_due(&self) -> bool {
        self.relaunch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some_and(|at| Instant::now() >= at)
    }

    fn status_changed(&self) {
        self.hub.broadcast(&json!({ "push": "status_changed" }));
    }

    // ---- requests ---------------------------------------------------------------------------

    /// Handles one validated request. `Subscribe` is handled by the pipe server (it needs the
    /// connection), so here it only acknowledges.
    pub fn handle(&self, req: Request) -> Value {
        match req {
            Request::Status => self.status(),
            Request::Subscribe => ok_response(json!({})),
            Request::EnrollPreview { code, server_url } => self.enroll_preview(&code, server_url.as_deref()),
            Request::Enroll { code, name, server_url } => self.enroll(&code, name, server_url.as_deref()),
            Request::SelfEnrollStart { name, server_url } => self.self_enroll_start(name, server_url.as_deref()),
            Request::SelfEnrollPoll => self.self_enroll_poll(),
            Request::CheckUrl { url } => self.check_url(&url),
            Request::Unenroll => self.unenroll(),
            Request::ProbePermissions => self.probe_permissions(),
        }
    }

    fn require_not_enrolled(&self) -> Result<(), Value> {
        if self.lock().creds.is_some() {
            return Err(error_response("already_enrolled", "This computer is already protected."));
        }
        Ok(())
    }

    fn enroll_preview(&self, code: &str, server_url: Option<&str>) -> Value {
        if let Err(v) = self.require_not_enrolled() {
            return v;
        }
        let base = Self::base_url_for(&self.lock(), server_url);
        let result = self.client(&base, None).and_then(|c| c.enroll_preview(code));
        match result {
            Ok(p) => ok_response(json!({
                "householdName": p.household_name,
                "memberName": p.member_name,
                "ownerName": p.owner_name,
                "expiresAt": p.expires_at,
            })),
            Err(e) => map_api_error(&e),
        }
    }

    fn enroll(&self, code: &str, name: Option<String>, server_url: Option<&str>) -> Value {
        if let Err(v) = self.require_not_enrolled() {
            return v;
        }
        let base = Self::base_url_for(&self.lock(), server_url);
        let name = name.unwrap_or_else(|| self.deps.probe.computer_name());
        let result = self.client(&base, None).and_then(|c| c.enroll(code, &name, config::VERSION));
        match result {
            Ok(r) => {
                let owner = r.device.enrolled_by_name.clone();
                self.finish_enrollment(&base, &r.token, &r.device, &r.household_name, r.member_name.as_deref(), owner)
            }
            Err(e) => map_api_error(&e),
        }
    }

    fn finish_enrollment(
        &self,
        base: &str,
        token: &str,
        device: &neo_agent_core::api::Device,
        household: &str,
        member: Option<&str>,
        owner: Option<String>,
    ) -> Value {
        let creds = Credentials {
            token: token.to_string(),
            base_url: base.to_string(),
        };
        if let Err(e) = self.deps.secrets.save(&creds) {
            log::error!("could not store the device token: {e}");
            return error_response("storage_failed", "Neo couldn't save its settings on this computer.");
        }
        {
            let mut g = self.lock();
            g.creds = Some(creds);
            g.meta = Meta {
                base_url: Some(base.to_string()),
                device_id: Some(device.id.clone()),
                device_name: Some(device.name.clone()),
                household_name: Some(household.to_string()),
                member_name: member.map(str::to_string),
                owner_name: owner,
                discovery_pending: true,
                expected_tools: device.expected(),
                ..Meta::default()
            };
            g.seen = SeenState::default();
            g.cursors = Cursors::default();
            g.queue = EventQueue::default();
            g.sign_in = None;
            g.sched.run_soon(Task::Heartbeat);
            g.sched.run_soon(Task::Fast);
            self.save_all(&g);
        }
        log::info!("enrolled with {base}");
        self.status_changed();
        self.status()
    }

    fn self_enroll_start(&self, name: Option<String>, server_url: Option<&str>) -> Value {
        if let Err(v) = self.require_not_enrolled() {
            return v;
        }
        let base = Self::base_url_for(&self.lock(), server_url);
        let name = name.unwrap_or_else(|| self.deps.probe.computer_name());
        let result = self
            .client(&base, None)
            .and_then(|c| c.device_flow_start(client_label(), &name, config::VERSION));
        match result {
            Ok(s) => {
                self.lock().sign_in = Some(SignIn {
                    device_code: s.device_code,
                    base_url: base,
                    interval: s.interval,
                });
                ok_response(json!({
                    "userCode": s.user_code,
                    "verificationUri": s.verification_uri,
                    "verificationUriComplete": s.verification_uri_complete,
                    "expiresIn": s.expires_in,
                    "interval": s.interval,
                }))
            }
            Err(e) => map_api_error(&e),
        }
    }

    fn self_enroll_poll(&self) -> Value {
        let Some(sign_in) = self.lock().sign_in.clone() else {
            return error_response("no_sign_in", "Sign-in was not started.");
        };
        let client = match self.client(&sign_in.base_url, None) {
            Ok(c) => c,
            Err(e) => return map_api_error(&e),
        };
        match client.device_flow_poll(&sign_in.device_code) {
            Ok(DeviceFlowPoll::Pending { interval }) => {
                ok_response(json!({ "status": "pending", "interval": interval.max(sign_in.interval) }))
            }
            Ok(DeviceFlowPoll::Approved(a)) => {
                // The approval may not carry the device; the heartbeat does.
                let authed = match self.client(&sign_in.base_url, Some(&a.token)) {
                    Ok(c) => c,
                    Err(e) => return map_api_error(&e),
                };
                let hb = match authed.heartbeat(config::VERSION) {
                    Ok(hb) => hb,
                    Err(e) => return map_api_error(&e),
                };
                let done = self.finish_enrollment(
                    &sign_in.base_url,
                    &a.token,
                    &hb.device,
                    &hb.household_name,
                    hb.member_name.as_deref(),
                    None,
                );
                if done["ok"] == true {
                    ok_response(json!({ "status": "approved" }))
                } else {
                    done
                }
            }
            Err(ApiError::Http { code, .. }) if code == "denied" => {
                self.lock().sign_in = None;
                ok_response(json!({ "status": "denied" }))
            }
            Err(ApiError::Http { code, .. }) if code == "expired" || code == "not_found" => {
                self.lock().sign_in = None;
                ok_response(json!({ "status": "expired" }))
            }
            Err(e) => map_api_error(&e),
        }
    }

    fn check_url(&self, url: &str) -> Value {
        let Some((base, token)) = self.lock().creds.as_ref().map(|c| (c.base_url.clone(), c.token.clone())) else {
            return error_response("not_enrolled", "This computer is not connected to a household.");
        };
        match self.client(&base, Some(&token)).and_then(|c| c.check_url(url)) {
            Ok(r) => ok_response(json!({
                "rating": r.rating,
                "domain": r.domain,
                "reasons": r.reasons,
                "checkedAt": r.checked_at,
            })),
            Err(ApiError::Disconnected) => {
                self.handle_disconnect();
                map_api_error(&ApiError::Disconnected)
            }
            Err(e) => map_api_error(&e),
        }
    }

    fn unenroll(&self) -> Value {
        let Some((base, token)) = self.lock().creds.as_ref().map(|c| (c.base_url.clone(), c.token.clone())) else {
            return error_response("not_enrolled", "This computer is not connected to a household.");
        };
        match self.client(&base, Some(&token)).and_then(|c| c.unenroll()) {
            Ok(()) | Err(ApiError::Disconnected) => {
                self.clear_enrollment(false);
                ok_response(json!({}))
            }
            Err(_) => error_response(
                "server_unreachable",
                "Couldn't reach Neo, so the household owner can't be told. Try again.",
            ),
        }
    }

    /// Forgets the enrollment. `disconnected` marks it as removed by the server (401).
    fn clear_enrollment(&self, disconnected: bool) {
        if let Err(e) = self.deps.secrets.clear() {
            log::error!("could not remove the device token: {e}");
        }
        {
            let mut g = self.lock();
            let base_url = g.meta.base_url.clone();
            g.creds = None;
            g.meta = Meta {
                base_url,
                disconnected,
                ..Meta::default()
            };
            g.seen = SeenState::default();
            g.cursors = Cursors::default();
            g.queue = EventQueue::default();
            g.sign_in = None;
            g.warned.clear();
            self.save_all(&g);
        }
        self.status_changed();
    }

    /// The server answered 401: the device was removed or the member left. Detection stops.
    fn handle_disconnect(&self) {
        log::warn!("the server no longer accepts this device: disconnected");
        self.clear_enrollment(true);
    }

    // ---- the loop ---------------------------------------------------------------------------

    /// One pass of the service loop; call about once a second.
    pub fn tick(&self) {
        let now = self.deps.clock.now();
        let ts = now.unix_timestamp();
        let (due, enrolled, discovery) = {
            let mut g = self.lock();
            (g.sched.due(ts), g.creds.is_some(), g.meta.discovery_pending)
        };
        if due.contains(&Task::UpdateCheck) {
            self.check_updates();
        }
        if !enrolled {
            return;
        }
        if due.contains(&Task::Heartbeat) {
            self.heartbeat(now);
            if self.lock().creds.is_none() {
                return;
            }
        }
        let fast = due.contains(&Task::Fast) || discovery;
        let slow = due.contains(&Task::Slow) || discovery;
        let eventlog = due.contains(&Task::EventLog) || discovery;
        if fast || slow || eventlog {
            self.scan(now, fast, slow, eventlog, discovery);
        }
        self.flush(now);
    }

    fn check_updates(&self) {
        match self.deps.updater.check(config::VERSION) {
            Ok(Some(update)) => {
                log::info!("update {} is available", update.version);
                {
                    let mut g = self.lock();
                    g.meta.update_available = Some(update.version.clone());
                    self.save_meta(&g);
                }
                if let Err(e) = self.deps.updater.apply(&update) {
                    log::error!("update {} was not installed: {e}", update.version);
                }
            }
            Ok(None) => {
                let mut g = self.lock();
                if g.meta.update_available.take().is_some() {
                    self.save_meta(&g);
                }
            }
            Err(crate::update::UpdateError::NotConfigured) => {}
            Err(e) => log::warn!("update check failed: {e}"),
        }
    }

    fn heartbeat(&self, now: OffsetDateTime) {
        let ts = now.unix_timestamp();
        let Some((base, token, etag, list_version)) = ({
            let g = self.lock();
            g.creds.as_ref().map(|c| {
                (
                    c.base_url.clone(),
                    c.token.clone(),
                    g.meta.lists_etag.clone(),
                    g.meta.lists_version.clone(),
                )
            })
        }) else {
            return;
        };
        let client = match self.client(&base, Some(&token)) {
            Ok(c) => c,
            Err(e) => {
                log::error!("heartbeat: {e}");
                return;
            }
        };
        match client.heartbeat(config::VERSION) {
            Ok(hb) => {
                let mut fetched = None;
                if list_version.as_deref() != Some(hb.lists_version.as_str()) {
                    match client.lists(etag.as_deref()) {
                        Ok(neo_agent_core::api::ListsFetch::Updated { lists, etag }) => fetched = Some((lists, etag)),
                        Ok(neo_agent_core::api::ListsFetch::NotModified) => {}
                        Err(e) => log::warn!("lists fetch failed: {e}"),
                    }
                }
                let mut g = self.lock();
                g.meta.last_heartbeat = Some(ts);
                g.meta.device_name = Some(hb.device.name.clone());
                g.meta.household_name = Some(hb.household_name);
                g.meta.member_name = hb.member_name;
                g.meta.expected_tools = hb.device.expected();
                if let Some((lists, etag)) = fetched {
                    if let Ok(text) = serde_json::to_string(&*lists) {
                        let _ = self.dir.write_atomic(LISTS_FILE, &text);
                    }
                    let compiled = CompiledLists::compile(&lists);
                    log::info!("lists updated: {} tools", compiled.tools.len());
                    g.lists = Arc::new(compiled);
                    g.meta.lists_etag = etag;
                    g.meta.lists_version = Some(hb.lists_version);
                } else if g.meta.lists_version.is_none() {
                    g.meta.lists_version = Some(hb.lists_version);
                }
                self.save_meta(&g);
                drop(g);
                self.status_changed();
            }
            Err(ApiError::Disconnected) => self.handle_disconnect(),
            Err(e) => {
                log::warn!("heartbeat failed: {e}");
                self.lock().sched.set_next(Task::Heartbeat, ts + HEARTBEAT_RETRY_SECS);
            }
        }
    }

    /// Reads the sources that are due, runs detection, queues the events and warns.
    fn scan(&self, now: OffsetDateTime, fast: bool, slow: bool, eventlog: bool, discovery: bool) {
        let probe = &*self.deps.probe;
        let (lists, mut cursors, expected) = {
            let g = self.lock();
            (g.lists.clone(), g.cursors.clone(), g.meta.expected_tools.clone())
        };
        let mut snap = Snapshot {
            env: probe.path_env(),
            ..Snapshot::default()
        };
        if fast || slow {
            snap.processes = probe.processes();
        }
        if slow {
            snap.uninstall_entries = probe.uninstall_entries();
            snap.services = probe.services();
            snap.app_bundles = probe.app_bundles();
        }
        if fast {
            let history = if discovery { History::Skip } else { History::Read };
            let targets = lists.log_targets(&snap.env);
            let watched: Vec<String> = targets.iter().map(|t| t.path.trim().to_lowercase()).collect();
            cursors.retain_logs(|k| watched.iter().any(|w| w == k));
            for t in &targets {
                let Some(stat) = probe.file_stat(&t.path) else { continue };
                let cursor = cursors.log_cursor(&t.path, stat.len, history);
                let Some(range) = cursor.plan_read(stat.len, stat.token.as_deref()) else {
                    continue;
                };
                match probe.read_range(&t.path, range.start, range.len) {
                    Ok(bytes) => {
                        let lines = cursor.consume(&range, &bytes);
                        if !lines.is_empty() {
                            snap.log_chunks.push(neo_agent_core::snapshot::LogChunk {
                                path: t.path.clone(),
                                lines,
                            });
                        }
                    }
                    Err(e) => log::debug!("log read failed for {}: {}", t.tool_id, e.kind()),
                }
            }
        }
        if eventlog {
            for (_tool, channel, ids) in lists.eventlog_targets() {
                match cursors.event_bookmark(channel) {
                    // First look at this channel: old records are not events.
                    None => cursors.set_event_bookmark(channel, now.unix_timestamp()),
                    Some(since) => {
                        let records = probe.event_records(channel, ids, since);
                        if let Some(newest) = records.iter().map(|r| r.time.unix_timestamp()).max() {
                            cursors.set_event_bookmark(channel, newest.max(since));
                        }
                        snap.event_records
                            .extend(records.into_iter().filter(|r| r.time.unix_timestamp() > since));
                    }
                }
            }
            // macOS: the unified log (the same 30-second cadence) and the TCC database. Both are
            // empty on Windows. Overlapping `log show` windows are harmless: a session is one event
            // per tool and peer per 30 minutes.
            let mut predicates: Vec<String> = lists.unifiedlog_targets().into_iter().map(|t| t.predicate).collect();
            predicates.sort();
            predicates.dedup();
            if !predicates.is_empty() {
                snap.unified_log_records = probe.unified_log(&predicates);
            }
            if self.refresh_fda(now.unix_timestamp(), false) == Some(true) {
                snap.tcc = probe.tcc();
            }
        }
        if slow {
            let hints: Vec<ExeHint> = {
                let g = self.lock();
                detect::exe_hints(&g.seen, &snap.uninstall_entries)
            };
            let hints: Vec<ExeHint> = hints.into_iter().take(MAX_EXE_HINTS_PER_SCAN).collect();
            if !hints.is_empty() {
                snap.exe_facts = probe.exe_facts(&hints);
            }
            let bundles: Vec<String> = {
                let g = self.lock();
                detect::bundle_exe_hints(&g.seen, &snap.app_bundles)
            };
            let bundles: Vec<String> = bundles.into_iter().take(MAX_EXE_HINTS_PER_SCAN).collect();
            if !bundles.is_empty() {
                snap.exe_facts.extend(probe.bundle_exe_facts(&bundles));
            }
        }

        let mut warnings = Vec::new();
        {
            let mut g = self.lock();
            let events = detect::detect(&lists, &mut g.seen, &snap, now, discovery);
            for e in &events {
                log::info!("event: {}", describe(e));
                if let Some(kind) = decide_with_lists(e, &expected, &lists) {
                    warnings.push(self.warning_for(e, kind, &lists, &g.meta, &expected));
                }
            }
            g.cursors = cursors;
            g.queue.push(events, now);
            if discovery {
                g.meta.discovery_pending = false;
                log::info!("baseline scan finished");
            }
            if !warnings.is_empty() {
                g.meta.last_warning = Some(now.unix_timestamp());
            }
            for w in &warnings {
                g.warned.insert(w.event_id.clone(), w.clone());
            }
            if g.warned.len() > MAX_REMEMBERED_WARNINGS {
                let keep: Vec<String> = g.warned.keys().take(MAX_REMEMBERED_WARNINGS).cloned().collect();
                g.warned.retain(|k, _| keep.contains(k));
            }
            self.save_all(&g);
        }
        for w in &warnings {
            self.dispatch(w);
        }
    }

    fn warning_for(&self, e: &SignalEvent, kind: WarningKind, lists: &CompiledLists, meta: &Meta, expected: &[ExpectedTool]) -> Warning {
        let mut service = None;
        let (tool_name, peer_id, severity) = match &e.body {
            EventBody::RemoteAccessTool { name, .. } => (name.clone(), None, "high"),
            EventBody::RemoteAccessSession { tool_id, peer_id, .. } => {
                let sev = if expected.iter().any(|x| &x.tool_id == tool_id) {
                    "high"
                } else {
                    "critical"
                };
                (lists.tool_name(tool_id).unwrap_or(tool_id).to_string(), peer_id.clone(), sev)
            }
            EventBody::UnwantedSoftware { name, .. } => (name.clone(), None, "medium"),
            EventBody::TccGrant { app, service: svc, .. } => {
                service = Some(svc.as_str());
                (app.clone(), None, "critical")
            }
        };
        Warning {
            event_id: e.id.clone(),
            kind,
            tool_name,
            peer_id,
            severity,
            owner_name: meta.owner_name.clone().unwrap_or_else(|| DEFAULT_OWNER.to_string()),
            owner_told: false,
            service,
        }
    }

    /// Pushes a warning to the tray apps; with nobody subscribed, a session or tool warning falls
    /// back to a message box in the active console session.
    fn dispatch(&self, w: &Warning) {
        let delivered = self.hub.broadcast(&w.push());
        log::info!("warning {:?} for {} shown to {delivered} subscriber(s)", w.kind, w.tool_name);
        if delivered == 0 && matches!(w.kind, WarningKind::Session | WarningKind::Tool | WarningKind::Permission) {
            let (title, body) = fallback_text(w.kind, &w.tool_name, w.service);
            self.deps.notifier.fallback_warning(&title, &body);
        }
    }

    /// Sends queued events. Each result may refresh the expected tools (`low`) or tell an open
    /// warning window that the owner was told.
    fn flush(&self, now: OffsetDateTime) {
        for _ in 0..4 {
            let Some((base, token, batch)) = ({
                let mut g = self.lock();
                let creds = g.creds.as_ref().map(|c| (c.base_url.clone(), c.token.clone()));
                creds.and_then(|(b, t)| g.queue.next_batch(now).map(|batch| (b, t, batch)))
            }) else {
                return;
            };
            let client = match self.client(&base, Some(&token)) {
                Ok(c) => c,
                Err(_) => return,
            };
            match client.post_signals(&batch) {
                Ok(results) => {
                    let (settled, told) = {
                        let mut g = self.lock();
                        let settled = g.queue.on_results(&batch, &results, now);
                        let mut told = Vec::new();
                        for (event, result) in &settled {
                            if result.severity.as_deref() == Some("low") {
                                g.sched.run_soon(Task::Heartbeat);
                            }
                            if let Some(w) = g.warned.get_mut(&event.id)
                                && owner_was_told(result)
                                && !w.owner_told
                            {
                                w.owner_told = true;
                                told.push(w.clone());
                            }
                        }
                        let _ = self.dir.write_atomic(QUEUE_FILE, &g.queue.to_json());
                        (settled.len(), told)
                    };
                    for w in &told {
                        self.hub.broadcast(&w.push());
                    }
                    log::debug!("sent {settled} event(s)");
                }
                Err(ApiError::Disconnected) => {
                    self.handle_disconnect();
                    return;
                }
                Err(e) => {
                    log::warn!("could not send events: {e}");
                    let mut g = self.lock();
                    g.queue.on_failure(now, e.retry_after_secs().map(|s| Duration::seconds(s as i64)));
                    let _ = self.dir.write_atomic(QUEUE_FILE, &g.queue.to_json());
                    return;
                }
            }
        }
    }

    /// The expected tools last heard from the server (for the tray's status and tests).
    pub fn expected_tools(&self) -> Vec<ExpectedTool> {
        self.lock().meta.expected_tools.clone()
    }

    /// For `--unenroll`: tell the server this device is gone, whatever the outcome, and forget
    /// everything. Never fails the uninstall.
    pub fn unenroll_for_uninstall(&self) {
        let creds = self.lock().creds.clone();
        match creds {
            Some(c) => match self.client(&c.base_url, Some(&c.token)).and_then(|cl| cl.unenroll()) {
                Ok(()) => log::info!("unenrolled before uninstall"),
                Err(e) => log::warn!("could not tell the server about the uninstall: {e}"),
            },
            None => log::info!("not enrolled; nothing to tell the server"),
        }
        self.clear_enrollment(false);
    }
}

/// Owner emails go out for medium and above (`low` is recorded only).
fn owner_was_told(r: &SignalResult) -> bool {
    r.status == SignalStatus::Accepted && matches!(r.severity.as_deref(), Some("medium" | "high" | "critical"))
}

/// Event type and tool id only, never anything from the user's folders.
fn describe(e: &SignalEvent) -> String {
    match &e.body {
        EventBody::RemoteAccessTool { tool_id, discovery, .. } => format!("remote_access_tool {tool_id} {discovery:?}"),
        EventBody::RemoteAccessSession { tool_id, .. } => format!("remote_access_session {tool_id}"),
        EventBody::UnwantedSoftware { reason, .. } => format!("unwanted_software {reason:?}"),
        EventBody::TccGrant { service, .. } => format!("tcc_grant {service:?}"),
    }
}
