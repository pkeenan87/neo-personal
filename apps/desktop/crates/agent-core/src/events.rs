//! Wire events for `POST /api/signals` (`packages/verdict/src/signals.ts`).
//!
//! Only the three detectors a desktop agent can produce are modelled. The schema on the server is
//! `.strict()`, so the key set here is exact: `id`, `type`, `detector`, `observedAt` plus the
//! variant's own fields. Optional fields are omitted, never `null`.

use serde::{Deserialize, Serialize, Serializer};
use time::OffsetDateTime;
use uuid::Uuid;

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
}

impl EventBody {
    /// The wire `type` for this detector.
    pub fn wire_type(&self) -> &'static str {
        match self {
            EventBody::RemoteAccessTool { .. } | EventBody::UnwantedSoftware { .. } => "software",
            EventBody::RemoteAccessSession { .. } => "remote_session",
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

    /// The tool id, for tool and session events.
    pub fn tool_id(&self) -> Option<&str> {
        match &self.body {
            EventBody::RemoteAccessTool { tool_id, .. } | EventBody::RemoteAccessSession { tool_id, .. } => Some(tool_id),
            EventBody::UnwantedSoftware { .. } => None,
        }
    }
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
