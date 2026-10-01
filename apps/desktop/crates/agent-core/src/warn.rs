//! Local warnings, decided from the evidence itself without waiting for the server
//! (`_specs/desktop-agent.md` "When to warn").

use serde::{Deserialize, Serialize};

use crate::events::{Discovery, EventBody, SignalEvent};

/// A tool the owner marked expected on this device (heartbeat `device.expectedTools`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedTool {
    pub tool_id: String,
    #[serde(default)]
    pub peer_ids: Vec<String>,
}

/// What to show. Matches the pipe push `kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarningKind {
    /// Toast: a remote-access tool appeared.
    Tool,
    /// Critical window: someone is connected.
    Session,
    /// Toast: known unwanted software.
    Unwanted,
}

/// Whether to show the tool-appeared toast: not for a baseline discovery, not for a tool that is
/// expected on this device.
pub fn tool_toast(discovery: Discovery, tool_id: &str, expected: &[ExpectedTool]) -> bool {
    discovery != Discovery::Baseline && !expected.iter().any(|e| e.tool_id == tool_id)
}

/// Whether to show the critical session window: not when the tool is expected AND the peer is one
/// of its expected peers. A session with no peer id always warns (peer ids are compared exactly,
/// like the server does).
pub fn session_window(tool_id: &str, peer_id: Option<&str>, expected: &[ExpectedTool]) -> bool {
    let Some(peer) = peer_id else { return true };
    !expected
        .iter()
        .any(|e| e.tool_id == tool_id && e.peer_ids.iter().any(|p| p == peer))
}

/// The warning for `event`, if any. Unwanted software warns even for a baseline discovery (it is
/// known unwanted, not merely present).
pub fn decide(event: &SignalEvent, expected: &[ExpectedTool]) -> Option<WarningKind> {
    match &event.body {
        EventBody::RemoteAccessTool { tool_id, discovery, .. } => {
            tool_toast(discovery.unwrap_or(Discovery::New), tool_id, expected).then_some(WarningKind::Tool)
        }
        EventBody::RemoteAccessSession { tool_id, peer_id, .. } => {
            session_window(tool_id, peer_id.as_deref(), expected).then_some(WarningKind::Session)
        }
        EventBody::UnwantedSoftware { .. } => Some(WarningKind::Unwanted),
    }
}
