//! Fakes for driving the whole agent on Linux: probe, secrets, notifier, clock, HTTP server and
//! updater. HTTP responses come from the recorded fixtures in `agent-core`.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use neo_agent::actuator::{Actuator, Target};
use neo_agent::agent::{Agent, Clock, Deps, DynTransport, Notifier};
use neo_agent::clocks::Clocks;
use neo_agent::persist::DataDir;
use neo_agent::probe::{FileStat, SystemProbe};
use neo_agent::secrets::{Credentials, SecretStore};
use neo_agent::update::{Available, UpdateError, Updater};
use neo_agent_core::api::{HttpRequest, HttpResponse, Transport, TransportError};
use neo_agent_core::detect::ExeHint;
use neo_agent_core::enforce::Exclusions;
use neo_agent_core::ledger::Console;
use neo_agent_core::lists::PathEnv;
use neo_agent_core::snapshot::{AppBundle, EventLogRecord, ExeFacts, ProcessInfo, ServiceInfo, Snapshot, TccSnapshot, UninstallEntry};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

pub fn http_fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/../agent-core/tests/fixtures/http/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn response(fixture: &Value) -> HttpResponse {
    HttpResponse {
        status: fixture["status"].as_u64().unwrap() as u16,
        headers: fixture["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
            .collect(),
        body: match &fixture["body"] {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        },
    }
}

#[derive(Clone, Default)]
pub struct FakeProbe {
    pub snap: Arc<Mutex<Snapshot>>,
    pub files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    /// macOS fake: `Some` makes this probe a Mac whose Full Disk Access state is the value.
    pub fda: Arc<Mutex<Option<bool>>>,
    /// How many times the TCC database was read.
    pub tcc_reads: Arc<std::sync::atomic::AtomicUsize>,
    /// Child mode: the console session and the monotonic clocks.
    pub console: Arc<Mutex<Console>>,
    pub clocks: Arc<Mutex<Clocks>>,
    pub exclusions: Arc<Mutex<Exclusions>>,
}

impl FakeProbe {
    pub fn new() -> Self {
        let p = FakeProbe::default();
        *p.console.lock().unwrap() = Console {
            present: true,
            locked: false,
            idle_secs: Some(0),
        };
        *p.clocks.lock().unwrap() = Clocks {
            boot_secs: 100_000,
            awake_secs: 90_000,
        };
        *p.exclusions.lock().unwrap() = Exclusions {
            own_pids: vec![4242],
            windir: r"C:\Windows".into(),
            own_dirs: vec![r"C:\Program Files\Neo".into()],
        };
        p.snap.lock().unwrap().env = PathEnv {
            vars: HashMap::from([("ProgramData".to_string(), r"C:\ProgramData".to_string())]),
            app_data: vec![r"C:\Users\Gran\AppData\Roaming".to_string()],
            ..Default::default()
        };
        p
    }
    pub fn set_processes(&self, p: Vec<ProcessInfo>) {
        self.snap.lock().unwrap().processes = p;
    }
    pub fn set_uninstall(&self, u: Vec<UninstallEntry>) {
        self.snap.lock().unwrap().uninstall_entries = u;
    }
    pub fn set_bundles(&self, b: Vec<AppBundle>) {
        self.snap.lock().unwrap().app_bundles = b;
    }
    pub fn set_tcc(&self, t: Option<TccSnapshot>) {
        self.snap.lock().unwrap().tcc = t;
    }
    pub fn set_fda(&self, v: Option<bool>) {
        *self.fda.lock().unwrap() = v;
    }
    pub fn write_file(&self, path: &str, text: &str) {
        self.files.lock().unwrap().insert(path.to_lowercase(), text.as_bytes().to_vec());
    }
    pub fn append_file(&self, path: &str, text: &str) {
        self.files
            .lock()
            .unwrap()
            .entry(path.to_lowercase())
            .or_default()
            .extend_from_slice(text.as_bytes());
    }
}

impl SystemProbe for FakeProbe {
    fn computer_name(&self) -> String {
        "GRANDMA-PC".into()
    }
    fn path_env(&self) -> PathEnv {
        self.snap.lock().unwrap().env.clone()
    }
    fn processes(&self) -> Vec<ProcessInfo> {
        self.snap.lock().unwrap().processes.clone()
    }
    fn uninstall_entries(&self) -> Vec<UninstallEntry> {
        self.snap.lock().unwrap().uninstall_entries.clone()
    }
    fn services(&self) -> Vec<ServiceInfo> {
        self.snap.lock().unwrap().services.clone()
    }
    fn file_stat(&self, path: &str) -> Option<FileStat> {
        self.files.lock().unwrap().get(&path.to_lowercase()).map(|b| FileStat {
            len: b.len() as u64,
            token: Some("t1".into()),
        })
    }
    fn read_range(&self, path: &str, start: u64, len: u64) -> io::Result<Vec<u8>> {
        let files = self.files.lock().unwrap();
        let b = files
            .get(&path.to_lowercase())
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        Ok(b[start as usize..(start + len) as usize].to_vec())
    }
    fn event_records(&self, _c: &str, _i: &[u32], _s: i64) -> Vec<EventLogRecord> {
        Vec::new()
    }
    fn exe_facts(&self, _h: &[ExeHint]) -> Vec<ExeFacts> {
        self.snap.lock().unwrap().exe_facts.clone()
    }
    fn platform(&self) -> &'static str {
        if self.fda.lock().unwrap().is_some() { "macos" } else { "windows" }
    }
    fn app_bundles(&self) -> Vec<AppBundle> {
        self.snap.lock().unwrap().app_bundles.clone()
    }
    fn bundle_exe_facts(&self, _p: &[String]) -> Vec<ExeFacts> {
        self.snap.lock().unwrap().exe_facts.clone()
    }
    fn full_disk_access(&self) -> Option<bool> {
        *self.fda.lock().unwrap()
    }
    fn tcc(&self) -> Option<TccSnapshot> {
        self.tcc_reads.fetch_add(1, Ordering::SeqCst);
        self.snap.lock().unwrap().tcc.clone()
    }
    fn clocks(&self) -> Clocks {
        *self.clocks.lock().unwrap()
    }
    fn console(&self) -> Console {
        *self.console.lock().unwrap()
    }
    fn exclusions(&self) -> Exclusions {
        self.exclusions.lock().unwrap().clone()
    }
}

/// Records what the service closes and locks, in order with the notices (`log`).
#[derive(Clone, Default)]
pub struct FakeActuator {
    pub terminated: Arc<Mutex<Vec<Target>>>,
    pub locks: Arc<std::sync::atomic::AtomicUsize>,
    pub fail_terminate: Arc<AtomicBool>,
    /// "notice: title", "terminate: pid", "lock", in the order they happened.
    pub log: Arc<Mutex<Vec<String>>>,
}

impl Actuator for FakeActuator {
    fn terminate(&self, t: &Target) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("terminate: {}", t.pid));
        if self.fail_terminate.load(Ordering::SeqCst) {
            return Err("refused".into());
        }
        self.terminated.lock().unwrap().push(t.clone());
        Ok(())
    }
    fn lock_session(&self) -> Result<(), String> {
        self.log.lock().unwrap().push("lock".into());
        self.locks.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct MemSecrets(pub Arc<Mutex<Option<Credentials>>>);

impl SecretStore for MemSecrets {
    fn load(&self) -> io::Result<Option<Credentials>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, c: &Credentials) -> io::Result<()> {
        *self.0.lock().unwrap() = Some(c.clone());
        Ok(())
    }
    fn clear(&self) -> io::Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct RecNotifier(pub Arc<Mutex<Vec<(String, String)>>>, pub Arc<Mutex<Vec<String>>>);

impl Notifier for RecNotifier {
    fn fallback_warning(&self, title: &str, text: &str) {
        self.1.lock().unwrap().push(format!("notice: {title}"));
        self.0.lock().unwrap().push((title.into(), text.into()));
    }
}

#[derive(Clone)]
pub struct TestClock(pub Arc<Mutex<OffsetDateTime>>);

impl TestClock {
    pub fn new() -> Self {
        TestClock(Arc::new(Mutex::new(OffsetDateTime::now_utc())))
    }
    pub fn advance(&self, secs: i64) {
        let mut t = self.0.lock().unwrap();
        *t += Duration::seconds(secs);
    }
    pub fn set(&self, unix: i64) {
        *self.0.lock().unwrap() = OffsetDateTime::from_unix_timestamp(unix).unwrap();
    }
}

impl Clock for TestClock {
    fn now(&self) -> OffsetDateTime {
        *self.0.lock().unwrap()
    }
}

#[derive(Clone, Default)]
pub struct FakeUpdater {
    pub available: Arc<Mutex<Option<Available>>>,
    pub applied: Arc<Mutex<Vec<String>>>,
}

impl Updater for FakeUpdater {
    fn check(&self, _current: &str) -> Result<Option<Available>, UpdateError> {
        Ok(self.available.lock().unwrap().clone())
    }
    fn apply(&self, u: &Available) -> Result<(), UpdateError> {
        self.applied.lock().unwrap().push(u.version.clone());
        Ok(())
    }
}

/// A fake Neo server.
#[derive(Default)]
pub struct Server {
    pub requests: Mutex<Vec<HttpRequest>>,
    /// No answer at all.
    pub offline: AtomicBool,
    /// 401 for every authenticated call.
    pub unauthorized: AtomicBool,
    /// Whether the fixture's expected tool (AnyDesk, peer 123456789) is on the device.
    pub expected: AtomicBool,
    /// Severity returned for every accepted event.
    pub severity: Mutex<String>,
    /// Serve the macOS detection lists (`lists-macos.json`) instead of the Windows-era fixture.
    pub macos_lists: AtomicBool,
    /// Child mode: the signed envelope `GET /api/devices/policy` serves, and the version the
    /// heartbeat advertises.
    pub policy: Mutex<Option<Value>>,
    pub policy_version: Mutex<Option<String>>,
    /// The `Date` header of every answer (an HTTP date), when set.
    pub date: Mutex<Option<String>>,
    /// The device's requests, newest first, as `GET /api/devices/requests` lists them.
    pub requests_list: Mutex<Vec<Value>>,
    /// What `POST /api/devices/requests` answers (default 201 pending).
    pub request_reply: Mutex<Option<(u16, Value)>>,
    /// `extensionEnrolled` in the heartbeat, when set.
    pub extension_enrolled: Mutex<Option<bool>>,
}

impl Server {
    pub fn new() -> Arc<Server> {
        let s = Server::default();
        *s.severity.lock().unwrap() = "high".into();
        Arc::new(s)
    }

    pub fn paths(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| {
                format!(
                    "{} {}",
                    r.method.as_str(),
                    r.url
                        .split_once("://")
                        .map(|x| x.1)
                        .unwrap()
                        .split_once('/')
                        .map(|x| format!("/{}", x.1))
                        .unwrap()
                )
            })
            .collect()
    }

    pub fn count(&self, needle: &str) -> usize {
        self.paths().iter().filter(|p| p.contains(needle)).count()
    }

    pub fn posted_events(&self) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.url.ends_with("/api/signals") && r.method.as_str() == "POST")
            .flat_map(|r| {
                serde_json::from_str::<Value>(r.body.as_deref().unwrap()).unwrap()["events"]
                    .as_array()
                    .unwrap()
                    .clone()
            })
            .collect()
    }

    fn fixture(&self, name: &str) -> Value {
        let mut v: Value = serde_json::from_str(&http_fixture(name)).unwrap();
        if name == "lists" && self.macos_lists.load(Ordering::SeqCst) {
            let path = format!("{}/../agent-core/tests/fixtures/lists-macos.json", env!("CARGO_MANIFEST_DIR"));
            v["body"] = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        }
        if !self.expected.load(Ordering::SeqCst)
            && let Some(d) = v["body"].get_mut("device")
        {
            d["expectedTools"] = json!([]);
        }
        if name == "heartbeat" {
            if let Some(ver) = self.policy_version.lock().unwrap().clone() {
                v["body"]["policyVersion"] = json!(ver);
            }
            if let Some(e) = *self.extension_enrolled.lock().unwrap() {
                v["body"]["extensionEnrolled"] = json!(e);
            }
        }
        v
    }
}

impl Transport for Server {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        let mut resp = self.answer(req)?;
        if let Some(d) = self.date.lock().unwrap().clone() {
            resp.headers.push(("Date".into(), d));
        }
        Ok(resp)
    }
}

impl Server {
    fn answer(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        self.requests.lock().unwrap().push(req.clone());
        if self.offline.load(Ordering::SeqCst) {
            return Err(TransportError("offline".into()));
        }
        let path = req
            .url
            .split_once("://")
            .unwrap()
            .1
            .split_once('/')
            .map(|x| format!("/{}", x.1))
            .unwrap();
        let authed = req.header("Authorization").is_some();
        if authed && self.unauthorized.load(Ordering::SeqCst) {
            return Ok(response(&serde_json::from_str(&http_fixture("unauthorized")).unwrap()));
        }
        let key = format!("{} {}", req.method.as_str(), path);
        Ok(match key.as_str() {
            "POST /api/devices/enroll/preview" => response(&self.fixture("enroll_preview")),
            "POST /api/devices/enroll" => response(&self.fixture("enroll")),
            "POST /api/devices/heartbeat" => response(&self.fixture("heartbeat")),
            "GET /api/signals/lists" => response(&self.fixture("lists")),
            "POST /api/devices/check-url" => response(&self.fixture("check_url")),
            "GET /api/devices/policy" => match self.policy.lock().unwrap().clone() {
                None => HttpResponse {
                    status: 503,
                    headers: vec![],
                    body: r#"{"error":"no signer","code":"policy_signing_unavailable"}"#.into(),
                },
                Some(env) => {
                    let version = env["bundle"]["policyVersion"].as_str().unwrap_or("").to_string();
                    let etag = format!("\"{version}\"");
                    if req.header("If-None-Match") == Some(etag.as_str()) {
                        HttpResponse {
                            status: 304,
                            headers: vec![],
                            body: String::new(),
                        }
                    } else {
                        HttpResponse {
                            status: 200,
                            headers: vec![("ETag".into(), etag)],
                            body: env.to_string(),
                        }
                    }
                }
            },
            "POST /api/devices/requests" => {
                let (status, body) = self.request_reply.lock().unwrap().clone().unwrap_or((
                    201,
                    json!({ "id": "req-1", "status": "pending", "expiresAt": "2026-11-04T05:00:00.000Z" }),
                ));
                HttpResponse {
                    status,
                    headers: vec![],
                    body: body.to_string(),
                }
            }
            "GET /api/devices/requests" | "GET /api/devices/requests?status=pending" => HttpResponse {
                status: 200,
                headers: vec![],
                body: json!({ "requests": self.requests_list.lock().unwrap().clone() }).to_string(),
            },
            "POST /api/desktop/device" => response(&self.fixture("device_start")),
            "POST /api/desktop/device/token" => {
                let body: Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
                match body["deviceCode"].as_str() {
                    Some("pending") => response(&self.fixture("device_poll_pending")),
                    Some("denied") => response(&self.fixture("device_poll_denied")),
                    _ => response(&self.fixture("device_poll_approved")),
                }
            }
            "DELETE /api/devices/self" => HttpResponse {
                status: 204,
                headers: vec![],
                body: String::new(),
            },
            "POST /api/signals" => {
                let body: Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
                let sev = self.severity.lock().unwrap().clone();
                let results: Vec<Value> = body["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| json!({ "id": e["id"], "status": "accepted", "severity": sev }))
                    .collect();
                HttpResponse {
                    status: 200,
                    headers: vec![],
                    body: json!({ "results": results }).to_string(),
                }
            }
            other => HttpResponse {
                status: 404,
                headers: vec![],
                body: format!(r#"{{"error":"no route {other}","code":"not_found"}}"#),
            },
        })
    }
}

pub struct Harness {
    pub agent: Arc<Agent>,
    pub probe: FakeProbe,
    pub secrets: MemSecrets,
    pub notifier: RecNotifier,
    pub clock: TestClock,
    pub server: Arc<Server>,
    pub updater: FakeUpdater,
    pub actuator: FakeActuator,
    pub dir: DataDir,
    pub _tmp: tempfile::TempDir,
}

impl Harness {
    pub fn new() -> Harness {
        let tmp = tempfile::tempdir().unwrap();
        Self::in_dir(tmp, Server::new())
    }

    pub fn in_dir(tmp: tempfile::TempDir, server: Arc<Server>) -> Harness {
        let probe = FakeProbe::new();
        let secrets = MemSecrets::default();
        let notifier = RecNotifier::default();
        let clock = TestClock::new();
        let updater = FakeUpdater::default();
        let actuator = FakeActuator::default();
        // One shared log, so a test can check the message came before the program was closed.
        let notifier = RecNotifier(notifier.0.clone(), actuator.log.clone());
        let dir = DataDir::new(tmp.path());
        let agent = Arc::new(Agent::new(
            Deps {
                probe: Box::new(probe.clone()),
                secrets: Box::new(secrets.clone()),
                notifier: Box::new(notifier.clone()),
                clock: Box::new(clock.clone()),
                transport: DynTransport(server.clone()),
                updater: Box::new(updater.clone()),
                actuator: Box::new(actuator.clone()),
                policy_keys: policy_keys(),
            },
            dir.clone(),
        ));
        Harness {
            agent,
            probe,
            secrets,
            notifier,
            clock,
            server,
            updater,
            actuator,
            dir,
            _tmp: tmp,
        }
    }

    /// A new agent process on the same data directory (a restart or a reboot): same disk, same
    /// server, same fakes.
    pub fn restart(&self) -> Arc<Agent> {
        Arc::new(Agent::new(
            Deps {
                probe: Box::new(self.probe.clone()),
                secrets: Box::new(self.secrets.clone()),
                notifier: Box::new(self.notifier.clone()),
                clock: Box::new(self.clock.clone()),
                transport: DynTransport(self.server.clone()),
                updater: Box::new(self.updater.clone()),
                actuator: Box::new(self.actuator.clone()),
                policy_keys: policy_keys(),
            },
            self.dir.clone(),
        ))
    }

    /// Moves the wall clock and both monotonic clocks by `secs` (the computer was awake).
    pub fn advance(&self, secs: i64) {
        self.clock.advance(secs);
        let mut c = self.probe.clocks.lock().unwrap();
        c.boot_secs += secs as u64;
        c.awake_secs += secs as u64;
    }

    /// `secs` seconds, one tick per second.
    pub fn run(&self, secs: i64) {
        self.run_with(&self.agent, secs);
    }

    pub fn run_with(&self, agent: &Agent, secs: i64) {
        for _ in 0..secs {
            self.advance(1);
            agent.tick();
        }
    }

    pub fn enroll(&self) -> Value {
        self.agent.handle(neo_agent::protocol::Request::Enroll {
            code: "ABCD".into(),
            name: None,
            server_url: Some("http://127.0.0.1:3007".into()),
        })
    }
}

pub fn process(name: &str, signer: Option<&str>) -> ProcessInfo {
    ProcessInfo {
        pid: 100,
        image_name: name.into(),
        image_path: format!(r"C:\Users\Gran\Downloads\{name}"),
        signer: signer.map(str::to_string),
        ..Default::default()
    }
}

pub fn drain(rx: &std::sync::mpsc::Receiver<String>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(l) = rx.try_recv() {
        out.push(serde_json::from_str(&l).unwrap());
    }
    out
}

// ---- Child mode: a signer whose key the agent trusts ----------------------------------------------

use neo_agent_core::policy::{TrustedKey, canonical_json, parse_trusted_keys};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use sha2::{Digest, Sha256};

/// The kid the test key is published under.
pub const TEST_KID: &str = "test-key-1";

/// A throwaway signing key made from a label, so no key material is written in the source.
pub fn signing_key(label: &str) -> SigningKey {
    SigningKey::from_slice(&Sha256::digest(label.as_bytes())).expect("a valid scalar")
}

fn jwk(sk: &SigningKey, kid: &str) -> Value {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    let point = sk.verifying_key().to_sec1_point(false);
    json!({
        "kty": "EC", "crv": "P-256", "kid": kid, "alg": "ES256", "use": "sig",
        "x": B64.encode(point.x().unwrap()), "y": B64.encode(point.y().unwrap()),
    })
}

/// The keys the test agent is built with.
pub fn policy_keys() -> Vec<TrustedKey> {
    parse_trusted_keys(&json!([jwk(&signing_key("neo test policy key"), TEST_KID)]).to_string())
}

/// Signs `bundle` as the server would: ES256 over the canonical JSON, raw `r || s`.
pub fn sign_with(sk: &SigningKey, kid: &str, bundle: &Value) -> Value {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    let sig: Signature = sk.sign(canonical_json(bundle).unwrap().as_bytes());
    json!({ "bundle": bundle, "sig": B64.encode(sig.to_bytes()), "keyId": kid, "alg": "ES256" })
}

pub fn sign(bundle: &Value) -> Value {
    sign_with(&signing_key("neo test policy key"), TEST_KID, bundle)
}

/// The device id the enrollment fixture gives the device.
pub const DEVICE_ID: &str = "d0000000-0000-4000-8000-000000000001";

/// Tuesday 3 November 2026, 10:00 in New York (15:00Z).
pub const T0: i64 = 1_793_718_000;

/// A Child bundle for the fixture device; `edit` changes it before the version is computed.
pub fn child_bundle(edit: impl FnOnce(&mut Value)) -> Value {
    let mut b = json!({
        "v": 1,
        "deviceId": DEVICE_ID,
        "memberId": "22222222-2222-4222-8222-222222222222",
        "timeZone": "America/New_York",
        "mode": "child",
        "web": { "categories": [], "safeSearch": false, "youtubeRestricted": "off", "allow": [], "block": [] },
        "apps": { "block": [], "requireApproval": false, "approved": [] },
        "screenTime": {
            "dailyMinutes": { "mon": null, "tue": null, "wed": null, "thu": null, "fri": null, "sat": null, "sun": null },
            "downtime": [], "warnMinutes": 10, "allowDuringDowntime": [], "grants": []
        },
    });
    edit(&mut b);
    let mut body = b.clone();
    for k in ["issuedAt", "expiresAt", "policyVersion"] {
        body.as_object_mut().unwrap().remove(k);
    }
    let version: String = Sha256::digest(canonical_json(&body).unwrap().as_bytes())
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect();
    b["policyVersion"] = json!(version);
    b["issuedAt"] = json!("2026-11-03T14:00:00.000Z");
    b["expiresAt"] = json!("2026-11-10T14:00:00.000Z");
    b
}

impl Harness {
    /// Serves `bundle` (signed) and advertises its version in the heartbeat.
    pub fn serve_policy(&self, bundle: &Value) {
        *self.server.policy.lock().unwrap() = Some(sign(bundle));
        *self.server.policy_version.lock().unwrap() = bundle["policyVersion"].as_str().map(str::to_string);
    }

    /// An enrolled device at `unix`, with `bundle` ready to be fetched: the first `tick` is the
    /// heartbeat on start (which fetches it) and the baseline scan, so set up the machine first.
    pub fn child_at(bundle: &Value, unix: i64) -> Harness {
        let h = Harness::new();
        h.clock.set(unix);
        h.enroll();
        h.serve_policy(bundle);
        h
    }

    pub fn child(bundle: &Value) -> Harness {
        Self::child_at(bundle, T0)
    }

    /// The events the server has received, as `detector` or `detector:reason` strings.
    pub fn sent(&self) -> Vec<String> {
        self.server
            .posted_events()
            .iter()
            .map(|e| match e["reason"].as_str() {
                Some(r) => format!("{}:{r}", e["detector"].as_str().unwrap()),
                None => e["detector"].as_str().unwrap().to_string(),
            })
            .collect()
    }

    pub fn status(&self) -> Value {
        self.agent.handle(neo_agent::protocol::Request::PolicyStatus)
    }
}
