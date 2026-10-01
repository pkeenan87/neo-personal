//! Scenario fixtures shared by the `simulate` example and the tests: a sequence of timed
//! snapshots, with optional expected event descriptions per step.
#![allow(dead_code)]

use std::path::Path;

use neo_agent_core::detect::detect;
use neo_agent_core::events::{Discovery, EventBody, SignalEvent, UnwantedReason};
use neo_agent_core::lists::{CompiledLists, DetectionLists};
use neo_agent_core::snapshot::Snapshot;
use neo_agent_core::state::SeenState;
use neo_agent_core::warn::ExpectedTool;
use serde::Deserialize;
use time::{Duration, OffsetDateTime};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Path of the lists file, relative to the scenario file.
    pub lists: String,
    #[serde(default)]
    pub expected_tools: Vec<ExpectedTool>,
    pub steps: Vec<Step>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub at_seconds: i64,
    #[serde(default)]
    pub discovery_phase: bool,
    pub snapshot: Snapshot,
    /// `describe()` strings the step must produce, in order.
    #[serde(default)]
    pub expect: Option<Vec<String>>,
}

pub struct Loaded {
    pub scenario: Scenario,
    pub lists: CompiledLists,
}

pub fn load(path: &Path) -> Result<Loaded, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let scenario: Scenario = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let lists_path = path.parent().unwrap_or(Path::new(".")).join(&scenario.lists);
    let lists_text = std::fs::read_to_string(&lists_path).map_err(|e| format!("{}: {e}", lists_path.display()))?;
    let lists: DetectionLists = serde_json::from_str(&lists_text).map_err(|e| format!("{}: {e}", lists_path.display()))?;
    Ok(Loaded {
        scenario,
        lists: CompiledLists::compile(&lists),
    })
}

/// Runs every step in order against one `SeenState`. Step `i` happens at `start + atSeconds`.
pub fn run(loaded: &Loaded, start: OffsetDateTime) -> Vec<(i64, Vec<SignalEvent>)> {
    let mut seen = SeenState::default();
    loaded
        .scenario
        .steps
        .iter()
        .map(|s| {
            let now = start + Duration::seconds(s.at_seconds);
            (s.at_seconds, detect(&loaded.lists, &mut seen, &s.snapshot, now, s.discovery_phase))
        })
        .collect()
}

/// A short stable description, e.g. `remote_access_session:anydesk:peer=123456789`.
pub fn describe(e: &SignalEvent) -> String {
    let disc = |d: &Option<Discovery>| {
        if matches!(d, Some(Discovery::Baseline)) {
            "baseline"
        } else {
            "new"
        }
    };
    match &e.body {
        EventBody::RemoteAccessTool { tool_id, discovery, .. } => format!("remote_access_tool:{tool_id}:{}", disc(discovery)),
        EventBody::RemoteAccessSession { tool_id, peer_id, .. } => {
            format!("remote_access_session:{tool_id}:peer={}", peer_id.as_deref().unwrap_or("none"))
        }
        EventBody::UnwantedSoftware { reason, discovery, .. } => {
            let r = match reason {
                UnwantedReason::PublisherList => "publisher_list",
                UnwantedReason::HashList => "hash_list",
                UnwantedReason::UnsignedUnknown => "unsigned_unknown",
            };
            format!("unwanted_software:{r}:{}", disc(discovery))
        }
    }
}
