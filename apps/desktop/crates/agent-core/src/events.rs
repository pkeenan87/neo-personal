//! Wire events for `POST /api/signals` (`packages/verdict/src/signals.ts`).
//!
//! Only the four detectors a desktop agent can produce are modelled. The schema on the server is
//! `.strict()`, so the key set here is exact: `id`, `type`, `detector`, `observedAt` plus the
//! variant's own fields. Optional fields are omitted, never `null`.

use serde::{Deserialize, Serialize, Serializer};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::policy::AppRef;

/// The wire `MAX_SIGNAL_BATCH`.
pub const MAX_BATCH: usize = 50;

/// Maximum length of `name`, `publisher` and `version` (server `BoundedTextSchema`).
const MAX_TEXT: usize = 128;
/// Maximum length of a `peerId`.
pub const MAX_PEER_ID: usize = 64;

/// `discovery` on `remote_access_tool` and `unwanted_software`. Absent on the wire means `new`, so
/// [`Discovery::New`] is never serialized (this also keeps the agent working against a server that
/// predates the field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Discovery {
    /// Already present when the device enrolled.
    Baseline,
    /// Appeared after enrollment.
    New,
}

impl Discovery {
    fn is_new(d: &Option<Discovery>) -> bool {
        matches!(d, None | Some(Discovery::New))
    }
}

/// Why a program is reported as `unwanted_software`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnwantedReason {
    PublisherList,
    HashList,
    UnsignedUnknown,
}

/// The `service` of a `tcc_grant` event (macOS permission that lets an app see or control the Mac).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TccService {
    /// `kTCCServiceScreenCapture`.
    ScreenRecording,
    /// `kTCCServiceAccessibility`.
    Accessibility,
    /// `kTCCServiceSystemPolicyAllFiles`.
    FullDiskAccess,
}

impl TccService {
    /// The wire name (`screen_recording`, `accessibility`, `full_disk_access`).
    pub fn as_str(self) -> &'static str {
        match self {
            TccService::ScreenRecording => "screen_recording",
            TccService::Accessibility => "accessibility",
            TccService::FullDiskAccess => "full_disk_access",
        }
    }

    /// Maps a raw TCC `service` string; `None` for every service the agent does not report.
    pub fn from_tcc(service: &str) -> Option<Self> {
        match service {
            "kTCCServiceScreenCapture" => Some(TccService::ScreenRecording),
            "kTCCServiceAccessibility" => Some(TccService::Accessibility),
            "kTCCServiceSystemPolicyAllFiles" => Some(TccService::FullDiskAccess),
            _ => None,
        }
    }
}

/// The `reason` of a `tamper_detected` event (Child mode).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TamperReason {
    BrowserWithoutExtension,
    VpnApp,
    ClockChanged,
    AgentServiceStopped,
    BadPolicySignature,
}

impl TamperReason {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            TamperReason::BrowserWithoutExtension => "browser_without_extension",
            TamperReason::VpnApp => "vpn_app",
            TamperReason::ClockChanged => "clock_changed",
            TamperReason::AgentServiceStopped => "agent_service_stopped",
            TamperReason::BadPolicySignature => "bad_policy_signature",
        }
    }
}

/// The `outcome` of a `command_result`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandOutcome {
    /// The command was carried out (or there was nothing left to do).
    Done,
    /// The person at the computer said no, or did not answer in time.
    Declined,
    /// It could not be carried out.
    Failed,
    /// The command had expired before it could be acted on.
    Expired,
}

impl CommandOutcome {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            CommandOutcome::Done => "done",
            CommandOutcome::Declined => "declined",
            CommandOutcome::Failed => "failed",
            CommandOutcome::Expired => "expired",
        }
    }
}

/// The detector-specific part of an event (the `detector` discriminant is the serde tag).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "detector", rename_all = "snake_case")]
pub enum EventBody {
    #[serde(rename_all = "camelCase")]
    RemoteAccessTool {
        tool_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        publisher: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Discovery::is_new")]
        discovery: Option<Discovery>,
    },
    #[serde(rename_all = "camelCase")]
    UnwantedSoftware {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        publisher: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        reason: UnwantedReason,
        #[serde(default, skip_serializing_if = "Discovery::is_new")]
        discovery: Option<Discovery>,
    },
    #[serde(rename_all = "camelCase")]
    RemoteAccessSession {
        tool_id: String,
        /// Always `"incoming"` from this agent (outgoing sessions are not reported).
        direction: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        peer_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TccGrant {
        app: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bundle_id: Option<String>,
        service: TccService,
    },
    /// Child mode: a new app appeared. Names only, never a path.
    #[serde(rename_all = "camelCase")]
    AppInstalled {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signer: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bundle_id: Option<String>,
    },
    /// Child mode: an app was closed because the policy blocks it (or it waits for approval).
    #[serde(rename_all = "camelCase")]
    AppBlocked {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signer: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bundle_id: Option<String>,
    },
    /// Child mode: the daily budget ran out, or downtime began. Carries nothing but the time.
    ScreenTimeExhausted {},
    /// Child mode: protection on the device was weakened.
    TamperDetected { reason: TamperReason },
    /// The answer to a command in the policy bundle (`end_session`): what became of it.
    #[serde(rename_all = "camelCase")]
    CommandResult {
        command_id: String,
        outcome: CommandOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

impl EventBody {
    /// The wire `type` for this detector.
    pub fn wire_type(&self) -> &'static str {
        match self {
            EventBody::RemoteAccessTool { .. } | EventBody::UnwantedSoftware { .. } => "software",
            EventBody::RemoteAccessSession { .. } => "remote_session",
            EventBody::TccGrant { .. } => "permission",
            EventBody::AppInstalled { .. } | EventBody::AppBlocked { .. } => "software",
            EventBody::ScreenTimeExhausted {} => "usage",
            EventBody::TamperDetected { .. } => "tamper",
            EventBody::CommandResult { .. } => "command",
        }
    }
}

/// One event, as sent in `{ events: [...] }`.
#[derive(Debug, Clone, PartialEq)]
pub struct SignalEvent {
    /// uuid v4, also the idempotency key.
    pub id: String,
    /// Whole seconds, UTC.
    pub observed_at: OffsetDateTime,
    pub body: EventBody,
}

#[derive(Serialize)]
struct WireOut<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    ty: &'static str,
    #[serde(rename = "observedAt", with = "time::serde::rfc3339")]
    observed_at: OffsetDateTime,
    #[serde(flatten)]
    body: &'a EventBody,
}

#[derive(Deserialize)]
struct WireIn {
    id: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(rename = "observedAt", with = "time::serde::rfc3339")]
    observed_at: OffsetDateTime,
    #[serde(flatten)]
    body: EventBody,
}

impl Serialize for SignalEvent {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        WireOut {
            id: &self.id,
            ty: self.body.wire_type(),
            observed_at: self.observed_at,
            body: &self.body,
        }
        .serialize(s)
    }
}

impl<'de> Deserialize<'de> for SignalEvent {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let w = WireIn::deserialize(d)?;
        if w.ty != w.body.wire_type() {
            return Err(serde::de::Error::custom("type does not match detector"));
        }
        Ok(SignalEvent {
            id: w.id,
            observed_at: w.observed_at,
            body: w.body,
        })
    }
}

impl SignalEvent {
    /// A new event with a fresh uuid v4 id.
    pub fn new(observed_at: OffsetDateTime, body: EventBody) -> Self {
        SignalEvent {
            id: Uuid::new_v4().to_string(),
            observed_at: truncate_secs(observed_at),
            body,
        }
    }

    /// `remote_access_tool`. `name`, `publisher` and `version` are trimmed and bounded to the
    /// server's 1-128 characters (empty optionals are dropped).
    pub fn remote_access_tool(
        now: OffsetDateTime,
        tool_id: &str,
        name: &str,
        publisher: Option<&str>,
        version: Option<&str>,
        discovery: Discovery,
    ) -> Self {
        Self::new(
            now,
            EventBody::RemoteAccessTool {
                tool_id: tool_id.to_string(),
                name: bounded(name).unwrap_or_else(|| tool_id.to_string()),
                publisher: publisher.and_then(bounded),
                version: version.and_then(bounded),
                discovery: Some(discovery),
            },
        )
    }

    /// `unwanted_software`. `sha256` is kept only when it is 64 hex characters (lowercased).
    pub fn unwanted_software(
        now: OffsetDateTime,
        name: &str,
        publisher: Option<&str>,
        version: Option<&str>,
        sha256: Option<&str>,
        reason: UnwantedReason,
        discovery: Discovery,
    ) -> Self {
        Self::new(
            now,
            EventBody::UnwantedSoftware {
                name: bounded(name).unwrap_or_else(|| "Unknown program".to_string()),
                publisher: publisher.and_then(bounded),
                version: version.and_then(bounded),
                sha256: sha256.and_then(normalize_sha256),
                reason,
                discovery: Some(discovery),
            },
        )
    }

    /// An incoming `remote_access_session`. `peer_id` is cleaned with [`clean_peer_id`].
    pub fn remote_session(now: OffsetDateTime, tool_id: &str, peer_id: Option<&str>) -> Self {
        Self::new(
            now,
            EventBody::RemoteAccessSession {
                tool_id: tool_id.to_string(),
                direction: "incoming".to_string(),
                peer_id: peer_id.and_then(clean_peer_id),
            },
        )
    }

    /// `tcc_grant`. `app` is bounded to 1-128 characters (falling back to the bundle id, then
    /// `Unknown app`); `bundle_id` is dropped unless it passes [`valid_bundle_id`].
    pub fn tcc_grant(now: OffsetDateTime, app: &str, bundle_id: Option<&str>, service: TccService) -> Self {
        let bundle_id = bundle_id.map(str::trim).filter(|b| valid_bundle_id(b)).map(str::to_string);
        Self::new(
            now,
            EventBody::TccGrant {
                app: bounded(app)
                    .or_else(|| bundle_id.as_deref().and_then(bounded))
                    .unwrap_or_else(|| "Unknown app".to_string()),
                bundle_id,
                service,
            },
        )
    }

    /// The tool id, for tool and session events.
    pub fn tool_id(&self) -> Option<&str> {
        match &self.body {
            EventBody::RemoteAccessTool { tool_id, .. } | EventBody::RemoteAccessSession { tool_id, .. } => Some(tool_id),
            EventBody::UnwantedSoftware { .. }
            | EventBody::TccGrant { .. }
            | EventBody::AppInstalled { .. }
            | EventBody::AppBlocked { .. }
            | EventBody::ScreenTimeExhausted {}
            | EventBody::TamperDetected { .. }
            | EventBody::CommandResult { .. } => None,
        }
    }

    /// `app_installed`. The app is named by `name` and by whichever of `signer`, `image` and
    /// `bundle_id` the policy can match; each is cleaned to the server's bounds (a path in `image`
    /// is cut down to its file name, an invalid bundle id is dropped).
    pub fn app_installed(now: OffsetDateTime, name: &str, app: &AppRef) -> Self {
        let (name, signer, image, bundle_id) = app_fields(name, app);
        Self::new(
            now,
            EventBody::AppInstalled {
                name,
                signer,
                image,
                bundle_id,
            },
        )
    }

    /// `app_blocked`, same fields as [`Self::app_installed`].
    pub fn app_blocked(now: OffsetDateTime, name: &str, app: &AppRef) -> Self {
        let (name, signer, image, bundle_id) = app_fields(name, app);
        Self::new(
            now,
            EventBody::AppBlocked {
                name,
                signer,
                image,
                bundle_id,
            },
        )
    }

    /// `screen_time_exhausted`.
    pub fn screen_time_exhausted(now: OffsetDateTime) -> Self {
        Self::new(now, EventBody::ScreenTimeExhausted {})
    }

    /// `tamper_detected`.
    pub fn tamper_detected(now: OffsetDateTime, reason: TamperReason) -> Self {
        Self::new(now, EventBody::TamperDetected { reason })
    }

    /// `command_result`. `detail` is a short code (`[a-z0-9_]`, at most 64 characters); anything else is dropped.
    pub fn command_result(now: OffsetDateTime, command_id: &str, outcome: CommandOutcome, detail: Option<&str>) -> Self {
        let detail = detail
            .filter(|d| !d.is_empty() && d.len() <= 64 && d.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
            .map(str::to_string);
        Self::new(
            now,
            EventBody::CommandResult {
                command_id: command_id.to_string(),
                outcome,
                detail,
            },
        )
    }
}

type AppFields = (String, Option<String>, Option<String>, Option<String>);

/// `name`, `signer`, `image` and `bundle_id` of an app event, each cleaned to the server's bounds.
fn app_fields(name: &str, app: &AppRef) -> AppFields {
    let image = app
        .image
        .as_deref()
        .map(|i| i.rsplit(['/', '\\']).next().unwrap_or(i))
        .and_then(bounded);
    let bundle_id = app
        .bundle_id
        .as_deref()
        .map(str::trim)
        .filter(|b| valid_bundle_id(b))
        .map(str::to_string);
    let name = bounded(name)
        .or_else(|| image.clone())
        .or_else(|| bundle_id.clone())
        .unwrap_or_else(|| "Unknown app".to_string());
    (name, app.signer.as_deref().and_then(bounded), image, bundle_id)
}

fn truncate_secs(t: OffsetDateTime) -> OffsetDateTime {
    t.to_offset(time::UtcOffset::UTC).replace_nanosecond(0).unwrap_or(t)
}

/// Trim and cap at 128 characters; `None` when empty.
fn bounded(s: &str) -> Option<String> {
    let t: String = s.trim().chars().take(MAX_TEXT).collect();
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

fn normalize_sha256(s: &str) -> Option<String> {
    let l = s.trim().to_ascii_lowercase();
    (l.len() == 64 && l.bytes().all(|b| b.is_ascii_hexdigit())).then_some(l)
}

/// Cleans a peer id to the server's charset `[A-Za-z0-9 _.@-]`, at most 64 characters. Other
/// characters are removed. `None` when nothing is left.
pub fn clean_peer_id(raw: &str) -> Option<String> {
    let kept: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '.' | '@' | '-'))
        .collect();
    let kept: String = kept.trim().chars().take(MAX_PEER_ID).collect();
    let kept = kept.trim().to_string();
    (!kept.is_empty()).then_some(kept)
}

/// The server's `BundleIdSchema`: `^[A-Za-z0-9]+(\.[A-Za-z0-9-]+)+$`, 1-255 characters.
pub fn valid_bundle_id(s: &str) -> bool {
    if s.is_empty() || s.len() > 255 {
        return false;
    }
    let mut parts = s.split('.');
    let first_ok = parts
        .next()
        .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric()));
    let mut rest = 0;
    let rest_ok = parts.all(|p| {
        rest += 1;
        !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    });
    first_ok && rest_ok && rest >= 1
}
