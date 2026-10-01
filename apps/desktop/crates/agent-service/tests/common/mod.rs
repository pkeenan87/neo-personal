//! Fakes for driving the whole agent on Linux: probe, secrets, notifier, clock, HTTP server and
//! updater. HTTP responses come from the recorded fixtures in `agent-core`.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use neo_agent::agent::{Agent, Clock, Deps, DynTransport, Notifier};
use neo_agent::persist::DataDir;
use neo_agent::probe::{FileStat, SystemProbe};
use neo_agent::secrets::{Credentials, SecretStore};
use neo_agent::update::{Available, UpdateError, Updater};
use neo_agent_core::api::{HttpRequest, HttpResponse, Transport, TransportError};
use neo_agent_core::detect::ExeHint;
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
}

impl FakeProbe {
    pub fn new() -> Self {
        let p = FakeProbe::default();
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
pub struct RecNotifier(pub Arc<Mutex<Vec<(String, String)>>>);

impl Notifier for RecNotifier {
    fn fallback_warning(&self, title: &str, text: &str) {
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
        v
    }
}

impl Transport for Server {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
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
        let dir = DataDir::new(tmp.path());
        let agent = Arc::new(Agent::new(
            Deps {
                probe: Box::new(probe.clone()),
                secrets: Box::new(secrets.clone()),
                notifier: Box::new(notifier.clone()),
                clock: Box::new(clock.clone()),
                transport: DynTransport(server.clone()),
                updater: Box::new(updater.clone()),
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
            dir,
            _tmp: tmp,
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
