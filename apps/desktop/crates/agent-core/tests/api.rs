//! The API client against JSON fixtures shaped like the real responses (no network).

mod common;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

/// The platform a build of agent-core enrolls as (macOS builds say "macos", every other build "windows").
const BUILD_PLATFORM: &str = if cfg!(target_os = "macos") { "macos" } else { "windows" };

use common::t0;
use neo_agent_core::api::*;
use neo_agent_core::events::SignalEvent;
use serde_json::Value;

#[derive(Clone, Default)]
struct Mock {
    responses: Rc<RefCell<VecDeque<HttpResponse>>>,
    seen: Rc<RefCell<Vec<HttpRequest>>>,
}

impl Mock {
    fn with(fixtures: &[&str]) -> Self {
        let m = Mock::default();
        for f in fixtures {
            m.responses.borrow_mut().push_back(load(f));
        }
        m
    }
    fn last(&self) -> HttpRequest {
        self.seen.borrow().last().cloned().expect("a request was made")
    }
}

impl Transport for Mock {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        self.seen.borrow_mut().push(req.clone());
        self.responses
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| TransportError("no more fixtures".into()))
    }
}

fn load(name: &str) -> HttpResponse {
    let v: Value = serde_json::from_str(&common::fixture_text(&format!("http/{name}.json"))).unwrap();
    let headers = v["headers"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect();
    let body = match &v["body"] {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    HttpResponse {
        status: v["status"].as_u64().unwrap() as u16,
        headers,
        body,
    }
}

fn client(m: &Mock) -> ApiClient<Mock> {
    ApiClient::new("https://neo.test/", m.clone()).unwrap().with_token("neo_dt_tok")
}

fn body(r: &HttpRequest) -> Value {
    serde_json::from_str(r.body.as_deref().unwrap()).unwrap()
}

#[test]
fn base_url_rules() {
    let m = Mock::default();
    assert!(ApiClient::new("https://www.neoshield.dev", m.clone()).is_ok());
    assert!(ApiClient::new("http://localhost:3000", m.clone()).is_ok());
    assert!(ApiClient::new("http://127.0.0.1:3000/", m.clone()).is_ok());
    assert!(ApiClient::new("http://neoshield.dev", m.clone()).is_err());
    assert!(ApiClient::new("http://localhost.evil.com", m.clone()).is_err());
    assert!(ApiClient::new("ftp://x", m).is_err());
}

#[test]
fn enroll_preview_and_enroll_send_no_token() {
    let m = Mock::with(&["enroll_preview", "enroll"]);
    let c = client(&m);
    let p = c.enroll_preview("ABCD-1234").unwrap();
    assert_eq!((p.household_name.as_str(), p.owner_name.as_deref()), ("The Keenans", Some("Pat")));
    let r = m.last();
    assert_eq!(r.url, "https://neo.test/api/devices/enroll/preview");
    assert!(r.header("authorization").is_none());
    assert_eq!(body(&r)["code"], "ABCD-1234");

    let e = c.enroll("ABCD-1234", "GRANDMA-PC", "0.1.0").unwrap();
    assert_eq!(e.token, "neo_dt_fixturetoken");
    assert_eq!(e.device.expected()[0].peer_ids, ["123456789"]);
    let b = body(&m.last());
    assert_eq!(
        (
            b["kind"].as_str(),
            b["platform"].as_str(),
            b["name"].as_str(),
            b["clientVersion"].as_str()
        ),
        (Some("desktop_agent"), Some(BUILD_PLATFORM), Some("GRANDMA-PC"), Some("0.1.0"))
    );
    assert!(m.last().header("authorization").is_none());
}

#[test]
fn device_flow_start_and_poll() {
    let m = Mock::with(&["device_start", "device_poll_pending", "device_poll_approved", "device_poll_denied"]);
    let c = client(&m);
    let s = c.device_flow_start("Neo", "GRANDMA-PC", "0.1.0").unwrap();
    assert_eq!(s.user_code, "ABCD-EFGH");
    let r = m.last();
    assert_eq!(r.url, "https://neo.test/api/desktop/device");
    assert_eq!(body(&r)["device"]["kind"], "desktop_agent");
    assert_eq!(body(&r)["device"]["platform"], BUILD_PLATFORM);

    assert_eq!(c.device_flow_poll(&s.device_code).unwrap(), DeviceFlowPoll::Pending { interval: 5 });
    assert_eq!(m.last().url, "https://neo.test/api/desktop/device/token");
    assert_eq!(body(&m.last())["deviceCode"], "dc-secret");
    match c.device_flow_poll(&s.device_code).unwrap() {
        DeviceFlowPoll::Approved(a) => {
            assert_eq!(a.token, "neo_dt_fromflow");
            assert!(a.device.is_some());
            assert!(a.scopes.contains(&"signals:write".to_string()));
        }
        other => panic!("{other:?}"),
    }
    let err = c.device_flow_poll(&s.device_code).unwrap_err();
    assert_eq!(err.code(), Some("denied"));
}

#[test]
fn heartbeat_parses_expected_tools_and_ignores_unknown_fields() {
    let m = Mock::with(&["heartbeat"]);
    let h = client(&m).heartbeat("0.1.0").unwrap();
    assert_eq!(h.lists_version, "fixture0000000001");
    assert_eq!(h.heartbeat_seconds, 3600);
    assert_eq!(h.device.expected_tools[0].tool_id, "anydesk");
    let r = m.last();
    assert_eq!(r.header("authorization"), Some("Bearer neo_dt_tok"));
    assert_eq!(r.url, "https://neo.test/api/devices/heartbeat");
    assert_eq!(body(&r)["clientVersion"], "0.1.0");
}

#[test]
fn lists_with_etag_and_304() {
    let m = Mock::with(&["lists", "lists_304"]);
    let c = client(&m);
    match c.lists(None).unwrap() {
        ListsFetch::Updated { lists, etag } => {
            assert_eq!(lists.version, "fixture0000000001");
            assert_eq!(etag.as_deref(), Some("\"fixture0000000001\""));
            assert_eq!(lists.remote_access_tools.len(), 5);
        }
        other => panic!("{other:?}"),
    }
    assert!(m.last().header("if-none-match").is_none());
    assert_eq!(c.lists(Some("\"fixture0000000001\"")).unwrap(), ListsFetch::NotModified);
    assert_eq!(m.last().header("if-none-match"), Some("\"fixture0000000001\""));
}

#[test]
fn post_signals_sends_events_and_parses_results() {
    let m = Mock::with(&["signals_ingest"]);
    let evs = vec![
        SignalEvent::remote_session(t0(), "anydesk", Some("1")),
        SignalEvent::remote_session(t0(), "anydesk", None),
    ];
    let res = client(&m).post_signals(&evs).unwrap();
    assert_eq!(res.len(), 3);
    assert_eq!(res[0].status, SignalStatus::Accepted);
    assert_eq!(res[0].severity.as_deref(), Some("high"));
    assert_eq!(res[1].reason.as_deref(), Some("stale"));
    assert_eq!(res[2].id, None);
    let b = body(&m.last());
    assert_eq!(b["events"].as_array().unwrap().len(), 2);
    assert_eq!(b["events"][0]["detector"], "remote_access_session");
}

#[test]
fn post_signals_refuses_empty_and_oversize_batches() {
    let m = Mock::default();
    let c = client(&m);
    assert!(c.post_signals(&[]).is_err());
    let many: Vec<_> = (0..51).map(|_| SignalEvent::remote_session(t0(), "a", None)).collect();
    assert!(c.post_signals(&many).is_err());
    assert!(m.seen.borrow().is_empty());
}

#[test]
fn status_check_url_and_unenroll() {
    let m = Mock::with(&["signals_status", "check_url", "no_content"]);
    let c = client(&m);
    let s = c
        .signals_status(&["11111111-1111-4111-8111-111111111111".into(), "b".into()])
        .unwrap();
    assert!(s[0].alerted);
    assert_eq!(
        m.last().url,
        "https://neo.test/api/signals/status?ids=11111111-1111-4111-8111-111111111111,b"
    );
    assert_eq!(m.last().method, Method::Get);
    let u = c.check_url("http://examp1e.com/").unwrap();
    assert_eq!(u.rating, "suspicious");
    assert_eq!(body(&m.last())["url"], "http://examp1e.com/");
    c.unenroll().unwrap();
    assert_eq!(m.last().method, Method::Delete);
    assert_eq!(m.last().url, "https://neo.test/api/devices/self");
}

#[test]
fn error_mapping() {
    let m = Mock::with(&["unauthorized", "insufficient_scope", "rate_limited", "device_limit"]);
    let c = client(&m);
    assert!(matches!(c.heartbeat("1").unwrap_err(), ApiError::Disconnected));
    assert!(matches!(c.heartbeat("1").unwrap_err(), ApiError::InsufficientScope));
    let e = c.heartbeat("1").unwrap_err();
    assert!(matches!(
        e,
        ApiError::RateLimited {
            retry_after_secs: Some(120)
        }
    ));
    assert_eq!(e.retry_after_secs(), Some(120));
    let e = c.enroll("c", "n", "v").unwrap_err();
    assert!(matches!(&e, ApiError::Http { status: 409, .. }));
    assert_eq!(e.code(), Some("device_limit"));
}

#[test]
fn authed_calls_without_a_token_are_disconnected_and_transport_errors_surface() {
    let m = Mock::default();
    let c = ApiClient::new("https://neo.test", m.clone()).unwrap();
    assert!(matches!(c.heartbeat("1"), Err(ApiError::Disconnected)));
    assert!(m.seen.borrow().is_empty());
    let c = client(&m);
    assert!(matches!(c.heartbeat("1"), Err(ApiError::Transport(_))));
}

#[test]
fn garbage_success_body_is_a_decode_error() {
    let m = Mock::default();
    m.responses.borrow_mut().push_back(HttpResponse {
        status: 200,
        headers: vec![],
        body: "<html>".into(),
    });
    assert!(matches!(client(&m).heartbeat("1"), Err(ApiError::Decode(_))));
}
