//! Blocking HTTP client for the device endpoints (`docs/contracts.md`).
//!
//! All I/O goes through [`Transport`] so tests replay recorded JSON; [`UreqTransport`] (feature
//! `http`, default on) is the real one. Every call is blocking and carries the device token as a
//! Bearer header where the endpoint needs one.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::events::SignalEvent;
use crate::lists::DetectionLists;
use crate::warn::ExpectedTool;

// ---- Transport ---------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Delete => "DELETE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// JSON text.
    pub body: Option<String>,
}

impl HttpRequest {
    /// Case-insensitive header lookup.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// The network failed (no response at all).
#[derive(Debug, thiserror::Error)]
#[error("transport error: {0}")]
pub struct TransportError(pub String);

/// Sends one HTTP request. Non-2xx statuses are responses, not errors.
pub trait Transport {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError>;
}

// ---- Errors ------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// 401: the device was removed or the member left. Stop detecting and clear the token.
    #[error("disconnected: the device is no longer enrolled")]
    Disconnected,
    /// 403 `insufficient_scope`.
    #[error("insufficient scope")]
    InsufficientScope,
    /// 429, with the `Retry-After` seconds when sent.
    #[error("rate limited")]
    RateLimited { retry_after_secs: Option<u64> },
    /// Any other error status, with the JSON `{ error, code }` body when there was one.
    #[error("server returned {status} ({code}): {message}")]
    Http { status: u16, code: String, message: String },
    #[error(transparent)]
    Transport(#[from] TransportError),
    /// A success status with a body that is not the documented shape.
    #[error("unexpected response: {0}")]
    Decode(String),
    /// The base URL is not usable (`https`, or `http` for localhost only).
    #[error("invalid server URL: {0}")]
    BadBaseUrl(String),
}

impl ApiError {
    /// The server's `code`, for `Http` errors.
    pub fn code(&self) -> Option<&str> {
        match self {
            ApiError::Http { code, .. } => Some(code),
            _ => None,
        }
    }

    /// Seconds to wait before retrying, when the server said.
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            ApiError::RateLimited { retry_after_secs } => *retry_after_secs,
            _ => None,
        }
    }
}

// ---- Wire types (only the fields the agent uses; unknown fields ignored) ----

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedToolItem {
    pub tool_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub peer_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub member_name: Option<String>,
    /// Who enrolled the device (the household owner, for a code enrollment).
    #[serde(default)]
    pub enrolled_by_name: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub expected_tools: Vec<ExpectedToolItem>,
}

impl Device {
    /// The expected tools in the form [`crate::warn`] takes.
    pub fn expected(&self) -> Vec<ExpectedTool> {
        self.expected_tools
            .iter()
            .map(|t| ExpectedTool {
                tool_id: t.tool_id.clone(),
                peer_ids: t.peer_ids.clone(),
            })
            .collect()
    }
}

/// `POST /api/devices/enroll/preview`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollPreview {
    pub household_name: String,
    #[serde(default)]
    pub member_name: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub expires_at: String,
}

/// `POST /api/devices/enroll` (201)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub token: String,
    #[serde(default)]
    pub token_id: String,
    pub device: Device,
    #[serde(default)]
    pub household_name: String,
    #[serde(default)]
    pub member_name: Option<String>,
}

/// `POST /api/desktop/device` (201)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// `POST /api/desktop/device/token`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceFlowPoll {
    /// 202: not decided yet; poll again after `interval` seconds.
    Pending {
        interval: u64,
    },
    Approved(Box<DeviceFlowApproved>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowApproved {
    pub token: String,
    #[serde(default)]
    pub token_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub device: Option<Device>,
}

/// `POST /api/devices/heartbeat`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub device: Device,
    #[serde(default)]
    pub household_name: String,
    #[serde(default)]
    pub member_name: Option<String>,
    #[serde(default)]
    pub heartbeat_seconds: u64,
    /// Refetch the lists when this differs from the cached `DetectionLists::version`.
    #[serde(default)]
    pub lists_version: String,
    #[serde(default)]
    pub uninstall_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalStatus {
    Accepted,
    Duplicate,
    Rejected,
}

/// One per-event ingest result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalResult {
    #[serde(default)]
    pub id: Option<String>,
    pub status: SignalStatus,
    #[serde(default)]
    pub reason: Option<String>,
    /// `low | medium | high | critical`.
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub verdict_id: Option<String>,
    #[serde(default)]
    pub pending: Option<bool>,
}

/// One `GET /api/signals/status` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalStatusItem {
    pub id: String,
    /// `pending | alerted | recorded | dismissed`.
    pub outcome: String,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub verdict_id: Option<String>,
    #[serde(default)]
    pub alerted: bool,
}

/// `POST /api/devices/check-url`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckUrlResponse {
    /// `dangerous | suspicious | no_known_problems | unknown`.
    pub rating: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub checked_at: String,
}

/// `GET /api/signals/lists`
#[derive(Debug, Clone, PartialEq)]
pub enum ListsFetch {
    /// 304: the cached copy is current.
    NotModified,
    Updated {
        lists: Box<DetectionLists>,
        etag: Option<String>,
    },
}

// ---- Client ------------------------------------------------------------

/// Device name and version sent at enrollment.
const KIND: &str = "desktop_agent";
const PLATFORM: &str = "windows";

/// Client for one server. Holds the Bearer token once enrolled.
pub struct ApiClient<T: Transport> {
    base: String,
    token: Option<String>,
    transport: T,
}

impl<T: Transport> ApiClient<T> {
    /// `base_url` must be `https://...` (or `http://` for localhost, for development).
    pub fn new(base_url: &str, transport: T) -> Result<Self, ApiError> {
        let base = base_url.trim().trim_end_matches('/').to_string();
        let ok = base.starts_with("https://")
            || ["http://localhost", "http://127.0.0.1", "http://[::1]"].iter().any(|p| {
                base.strip_prefix(p)
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with(':') || rest.starts_with('/'))
            });
        if !ok || base.contains(char::is_whitespace) {
            return Err(ApiError::BadBaseUrl(base));
        }
        Ok(ApiClient {
            base,
            token: None,
            transport,
        })
    }

    pub fn set_token(&mut self, token: Option<String>) {
        self.token = token;
    }

    pub fn with_token(mut self, token: &str) -> Self {
        self.token = Some(token.to_string());
        self
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        authed: bool,
        extra: &[(&str, &str)],
    ) -> Result<HttpResponse, ApiError> {
        let mut headers = vec![("Accept".to_string(), "application/json".to_string())];
        if body.is_some() {
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
        }
        if authed {
            let token = self.token.as_deref().ok_or(ApiError::Disconnected)?;
            headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        for (k, v) in extra {
            headers.push((k.to_string(), v.to_string()));
        }
        let req = HttpRequest {
            method,
            url: format!("{}{}", self.base, path),
            headers,
            body: body.map(|b| b.to_string()),
        };
        let resp = self.transport.send(&req)?;
        match resp.status {
            200..=299 | 304 => Ok(resp),
            401 => Err(ApiError::Disconnected),
            429 => Err(ApiError::RateLimited {
                retry_after_secs: resp.header("retry-after").and_then(|v| v.trim().parse().ok()),
            }),
            status => {
                let (code, message) = error_body(&resp.body);
                if status == 403 && code == "insufficient_scope" {
                    Err(ApiError::InsufficientScope)
                } else {
                    Err(ApiError::Http { status, code, message })
                }
            }
        }
    }

    fn json<R: DeserializeOwned>(&self, resp: &HttpResponse) -> Result<R, ApiError> {
        serde_json::from_str(&resp.body).map_err(|e| ApiError::Decode(e.to_string()))
    }

    /// `POST /api/devices/enroll/preview` (no token).
    pub fn enroll_preview(&self, code: &str) -> Result<EnrollPreview, ApiError> {
        let r = self.request(
            Method::Post,
            "/api/devices/enroll/preview",
            Some(json!({ "code": code })),
            false,
            &[],
        )?;
        self.json(&r)
    }

    /// `POST /api/devices/enroll` (no token). The caller stores `token` and calls [`Self::set_token`].
    pub fn enroll(&self, code: &str, name: &str, client_version: &str) -> Result<EnrollResponse, ApiError> {
        let body = json!({ "code": code, "kind": KIND, "platform": PLATFORM, "name": name, "clientVersion": client_version });
        let r = self.request(Method::Post, "/api/devices/enroll", Some(body), false, &[])?;
        self.json(&r)
    }

    /// `POST /api/desktop/device` with a monitoring `device` (no token).
    pub fn device_flow_start(&self, client_name: &str, device_name: &str, client_version: &str) -> Result<DeviceFlowStart, ApiError> {
        let body = json!({
            "clientName": client_name,
            "device": { "kind": KIND, "platform": PLATFORM, "name": device_name, "clientVersion": client_version },
        });
        let r = self.request(Method::Post, "/api/desktop/device", Some(body), false, &[])?;
        self.json(&r)
    }

    /// `POST /api/desktop/device/token`. 403 `denied`, 410 `expired`, 404 `not_found` and 409
    /// `device_limit` come back as [`ApiError::Http`] with that `code`.
    pub fn device_flow_poll(&self, device_code: &str) -> Result<DeviceFlowPoll, ApiError> {
        let r = self.request(
            Method::Post,
            "/api/desktop/device/token",
            Some(json!({ "deviceCode": device_code })),
            false,
            &[],
        )?;
        if r.status == 202 {
            #[derive(Deserialize)]
            struct Pending {
                #[serde(default)]
                interval: u64,
            }
            let p: Pending = self.json(&r)?;
            return Ok(DeviceFlowPoll::Pending {
                interval: p.interval.max(1),
            });
        }
        Ok(DeviceFlowPoll::Approved(Box::new(self.json(&r)?)))
    }

    /// `POST /api/devices/heartbeat`.
    pub fn heartbeat(&self, client_version: &str) -> Result<Heartbeat, ApiError> {
        let r = self.request(
            Method::Post,
            "/api/devices/heartbeat",
            Some(json!({ "clientVersion": client_version })),
            true,
            &[],
        )?;
        self.json(&r)
    }

    /// `GET /api/signals/lists` with `If-None-Match: <etag>`.
    pub fn lists(&self, etag: Option<&str>) -> Result<ListsFetch, ApiError> {
        let extra: Vec<(&str, &str)> = etag.map(|e| vec![("If-None-Match", e)]).unwrap_or_default();
        let r = self.request(Method::Get, "/api/signals/lists", None, true, &extra)?;
        if r.status == 304 {
            return Ok(ListsFetch::NotModified);
        }
        let lists: DetectionLists = self.json(&r)?;
        Ok(ListsFetch::Updated {
            lists: Box::new(lists),
            etag: r.header("etag").map(str::to_string),
        })
    }

    /// `POST /api/signals`. At most 50 events per call (extra events are an error here, not
    /// silently dropped).
    pub fn post_signals(&self, events: &[SignalEvent]) -> Result<Vec<SignalResult>, ApiError> {
        if events.is_empty() || events.len() > crate::events::MAX_BATCH {
            return Err(ApiError::Http {
                status: 400,
                code: "bad_request".into(),
                message: "a batch holds 1 to 50 events".into(),
            });
        }
        let r = self.request(Method::Post, "/api/signals", Some(json!({ "events": events })), true, &[])?;
        #[derive(Deserialize)]
        struct Out {
            results: Vec<SignalResult>,
        }
        Ok(self.json::<Out>(&r)?.results)
    }

    /// `GET /api/signals/status?ids=...` (1 to 50 ids).
    pub fn signals_status(&self, ids: &[String]) -> Result<Vec<SignalStatusItem>, ApiError> {
        let r = self.request(Method::Get, &format!("/api/signals/status?ids={}", ids.join(",")), None, true, &[])?;
        #[derive(Deserialize)]
        struct Out {
            results: Vec<SignalStatusItem>,
        }
        Ok(self.json::<Out>(&r)?.results)
    }

    /// `POST /api/devices/check-url`.
    pub fn check_url(&self, url: &str) -> Result<CheckUrlResponse, ApiError> {
        let r = self.request(Method::Post, "/api/devices/check-url", Some(json!({ "url": url })), true, &[])?;
        self.json(&r)
    }

    /// `DELETE /api/devices/self`: unenroll this device (the server alerts the owner).
    pub fn unenroll(&self) -> Result<(), ApiError> {
        self.request(Method::Delete, "/api/devices/self", None, true, &[])?;
        Ok(())
    }
}

fn error_body(body: &str) -> (String, String) {
    #[derive(Deserialize)]
    struct E {
        #[serde(default)]
        error: String,
        #[serde(default)]
        code: String,
    }
    match serde_json::from_str::<E>(body) {
        Ok(e) => (e.code, e.error),
        Err(_) => (String::new(), String::new()),
    }
}

// ---- ureq transport ----------------------------------------------------

/// The real transport: `ureq` with rustls, 20 s timeout, no redirects (the Bearer token must not
/// follow one), no status-as-error.
#[cfg(feature = "http")]
#[derive(Clone)]
pub struct UreqTransport {
    agent: ureq::Agent,
}

#[cfg(feature = "http")]
impl UreqTransport {
    pub fn new(user_agent: &str) -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(std::time::Duration::from_secs(20)))
            .user_agent(user_agent)
            .build();
        UreqTransport {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

#[cfg(feature = "http")]
impl Transport for UreqTransport {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        let err = |e: &dyn std::fmt::Display| TransportError(e.to_string());
        let mut b = ureq::http::Request::builder().method(req.method.as_str()).uri(&req.url);
        for (k, v) in &req.headers {
            b = b.header(k, v);
        }
        let mut resp = match &req.body {
            Some(body) => self.agent.run(b.body(body.clone()).map_err(|e| err(&e))?),
            None => self.agent.run(b.body(()).map_err(|e| err(&e))?),
        }
        .map_err(|e| err(&e))?;
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
            .collect();
        let body = resp.body_mut().read_to_string().map_err(|e| err(&e))?;
        Ok(HttpResponse { status, headers, body })
    }
}
