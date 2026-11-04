//! The Child-mode calls of the API client: policy fetch with `If-None-Match`, the heartbeat's
//! `policyVersion` both ways, and the device's own requests. No network.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use neo_agent_core::api::{ApiClient, ApiError, HttpRequest, HttpResponse, PolicyFetch, Transport, TransportError};
use serde_json::{Value, json};

#[derive(Clone, Default)]
struct Mock {
    responses: Rc<RefCell<VecDeque<HttpResponse>>>,
    seen: Rc<RefCell<Vec<HttpRequest>>>,
}

impl Mock {
    fn push(&self, status: u16, headers: &[(&str, &str)], body: Value) -> &Self {
        self.responses.borrow_mut().push_back(HttpResponse {
            status,
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: if body.is_null() { String::new() } else { body.to_string() },
        });
        self
    }
    fn last(&self) -> HttpRequest {
        self.seen.borrow().last().cloned().unwrap()
    }
}

impl Transport for Mock {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        self.seen.borrow_mut().push(req.clone());
        self.responses
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| TransportError("no more responses".into()))
    }
}

fn client(m: &Mock) -> ApiClient<Mock> {
    ApiClient::new("https://neo.test", m.clone()).unwrap().with_token("neo_dt_tok")
}

fn body(r: &HttpRequest) -> Value {
    serde_json::from_str(r.body.as_deref().unwrap()).unwrap()
}

fn heartbeat_body() -> Value {
    let mut v: Value = serde_json::from_str(include_str!("fixtures/http/heartbeat.json")).unwrap();
    v["body"].take()
}

#[test]
fn heartbeat_sends_the_applied_policy_version_and_reads_the_current_one() {
    let m = Mock::default();
    let mut hb = heartbeat_body();
    hb["policyVersion"] = json!("ab".repeat(32));
    hb["extensionEnrolled"] = json!(false);
    m.push(200, &[("Date", "Wed, 04 Nov 2026 00:48:25 GMT")], hb);
    let h = client(&m).heartbeat_with("0.2.0", Some(&"cd".repeat(32))).unwrap();
    assert_eq!(body(&m.last())["policyVersion"], "cd".repeat(32));
    assert_eq!(h.policy_version.as_deref(), Some("ab".repeat(32).as_str()));
    assert_eq!(h.extension_enrolled, Some(false));
    assert_eq!(h.server_date, Some(1_793_753_305));

    // An older server: neither field, no Date header. Nothing is invented.
    let m = Mock::default();
    m.push(200, &[], heartbeat_body());
    let h = client(&m).heartbeat_with("0.2.0", None).unwrap();
    assert!(body(&m.last()).get("policyVersion").is_none());
    assert_eq!((h.policy_version, h.extension_enrolled, h.server_date), (None, None, None));

    // `null` from a server that could not compute the version.
    let m = Mock::default();
    let mut hb = heartbeat_body();
    hb["policyVersion"] = Value::Null;
    m.push(200, &[], hb);
    assert_eq!(client(&m).heartbeat("1").unwrap().policy_version, None);
}

#[test]
fn only_a_valid_policy_version_is_sent() {
    for bad in ["", "   ", "not hex!", &"a".repeat(65)] {
        let m = Mock::default();
        m.push(200, &[], heartbeat_body());
        client(&m).heartbeat_with("1", Some(bad)).unwrap();
        assert!(body(&m.last()).get("policyVersion").is_none(), "{bad:?}");
    }
}

#[test]
fn policy_fetch_with_etag_and_304() {
    let vector: Value = serde_json::from_str(include_str!("fixtures/policy-vector.json")).unwrap();
    let m = Mock::default();
    m.push(
        200,
        &[("ETag", "\"abc\""), ("Date", "Wed, 04 Nov 2026 00:48:25 GMT")],
        vector["envelope"].clone(),
    );
    m.push(304, &[("Date", "Wed, 04 Nov 2026 00:49:25 GMT")], Value::Null);
    let c = client(&m);
    match c.policy(None).unwrap() {
        PolicyFetch::Updated {
            envelope,
            etag,
            server_date,
        } => {
            assert_eq!(envelope, vector["envelope"]);
            assert_eq!(etag.as_deref(), Some("\"abc\""));
            assert_eq!(server_date, Some(1_793_753_305));
        }
        other => panic!("{other:?}"),
    }
    let r = m.last();
    assert_eq!(r.url, "https://neo.test/api/devices/policy");
    assert_eq!(r.header("authorization"), Some("Bearer neo_dt_tok"));
    assert!(
        r.header("if-none-match").is_none(),
        "a first fetch, or one near expiry, is unconditional"
    );
    assert_eq!(
        c.policy(Some("\"abc\"")).unwrap(),
        PolicyFetch::NotModified {
            server_date: Some(1_793_753_365)
        }
    );
    assert_eq!(m.last().header("if-none-match"), Some("\"abc\""));
}

#[test]
fn policy_errors_map_like_the_other_calls() {
    let m = Mock::default();
    m.push(401, &[], json!({ "error": "no", "code": "unauthorized" }));
    m.push(503, &[], json!({ "error": "no signer", "code": "policy_signing_unavailable" }));
    m.push(429, &[("Retry-After", "30")], json!({}));
    m.push(200, &[], json!("not an envelope object"));
    let c = client(&m);
    assert!(matches!(c.policy(None), Err(ApiError::Disconnected)));
    assert_eq!(c.policy(None).unwrap_err().code(), Some("policy_signing_unavailable"));
    assert_eq!(c.policy(None).unwrap_err().retry_after_secs(), Some(30));
    // A string body decodes as a Value, but the verifier then refuses it as malformed.
    assert!(matches!(c.policy(None), Ok(PolicyFetch::Updated { .. })));
}

#[test]
fn more_time_request_and_the_device_request_list() {
    let m = Mock::default();
    m.push(
        201,
        &[],
        json!({ "id": "r-1", "status": "pending", "expiresAt": "2026-11-04T05:00:00.000Z" }),
    );
    m.push(409, &[], json!({ "error": "Not in Child mode.", "code": "not_child_mode" }));
    m.push(
        200,
        &[],
        json!({ "requests": [
            { "id": "r-2", "kind": "more_time", "status": "approved", "detail": { "minutes": 30 }, "createdAt": "2026-11-03T20:00:00.000Z", "expiresAt": "2026-11-04T05:00:00.000Z", "decidedAt": "2026-11-03T20:01:00.000Z", "grant": { "minutes": 30 } },
            { "id": "r-1", "kind": "more_time", "status": "pending", "detail": { "minutes": 15 }, "createdAt": "2026-11-03T19:00:00.000Z", "expiresAt": null, "decidedAt": null, "grant": null }
        ] }),
    );
    let c = client(&m);
    let r = c.request_more_time(15).unwrap();
    assert_eq!((r.id.as_str(), r.status.as_str()), ("r-1", "pending"));
    let sent = m.last();
    assert_eq!(sent.url, "https://neo.test/api/devices/requests");
    assert_eq!(body(&sent), json!({ "kind": "more_time", "detail": { "minutes": 15 } }));
    assert_eq!(c.request_more_time(15).unwrap_err().code(), Some("not_child_mode"));
    let list = c.list_requests(false).unwrap();
    assert_eq!(m.last().url, "https://neo.test/api/devices/requests");
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].status, "approved");
    assert_eq!(list[1].decided_at, None);
    m.push(200, &[], json!({ "requests": [] }));
    assert!(c.list_requests(true).unwrap().is_empty());
    assert_eq!(m.last().url, "https://neo.test/api/devices/requests?status=pending");
}
