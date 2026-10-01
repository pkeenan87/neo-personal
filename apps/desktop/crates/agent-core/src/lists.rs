//! Detection lists (`GET /api/signals/lists`) and their compiled form.
//!
//! The raw types keep only the fields the agent needs and ignore everything else, so a server that
//! adds fields never breaks an older agent. Regexes are JavaScript-subset strings compiled with the
//! `regex` crate; one that does not compile is skipped and logged, never fatal.

use std::collections::HashMap;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

/// The lists payload (subset of `DetectionListsPayload`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionLists {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub remote_access_tools: Vec<RemoteAccessTool>,
    #[serde(default)]
    pub pup_publishers: Vec<PupPublisher>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessTool {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub windows: WindowsSignatures,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsSignatures {
    #[serde(default)]
    pub publishers: Vec<String>,
    #[serde(default)]
    pub display_name_patterns: Vec<String>,
    #[serde(default)]
    pub service_names: Vec<String>,
    #[serde(default)]
    pub process_names: Vec<String>,
    /// Absent in lists that predate session evidence.
    #[serde(default)]
    pub session_evidence: Vec<SessionEvidence>,
}

/// One way to see that a remote session is under way. Only `verified: true` entries are used.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SessionEvidence {
    /// A log file line matching `pattern` (optional named group `peer`).
    #[serde(rename_all = "camelCase")]
    Log {
        path: String,
        pattern: String,
        #[serde(default)]
        verified: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked: Option<String>,
    },
    /// A Windows event-log record.
    #[serde(rename_all = "camelCase")]
    Eventlog {
        channel: String,
        #[serde(default)]
        event_ids: Vec<u32>,
        #[serde(default)]
        verified: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked: Option<String>,
    },
    /// A process that exists only during a session.
    #[serde(rename_all = "camelCase")]
    Process {
        name: String,
        #[serde(default)]
        verified: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked: Option<String>,
    },
    /// A kind from a newer server; ignored.
    #[serde(other)]
    Unknown,
}

impl SessionEvidence {
    /// Whether the verification task has confirmed this entry on a real install.
    pub fn is_verified(&self) -> bool {
        match self {
            SessionEvidence::Log { verified, .. }
            | SessionEvidence::Eventlog { verified, .. }
            | SessionEvidence::Process { verified, .. } => *verified,
            SessionEvidence::Unknown => false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PupPublisher {
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub reason: String,
}

/// A verified log evidence entry with its compiled pattern and path template.
#[derive(Debug, Clone)]
pub struct CompiledLog {
    pub path_template: String,
    pub pattern: Regex,
}

/// A verified event-log evidence entry.
#[derive(Debug, Clone)]
pub struct CompiledEventLog {
    pub channel: String,
    pub event_ids: Vec<u32>,
}

/// A tool with its regexes compiled and its unverified evidence dropped.
#[derive(Debug, Clone)]
pub struct CompiledTool {
    pub id: String,
    pub name: String,
    pub publishers: Vec<String>,
    /// Matched case-insensitively.
    pub display_name_patterns: Vec<Regex>,
    pub service_names: Vec<String>,
    pub process_names: Vec<String>,
    pub log_evidence: Vec<CompiledLog>,
    pub eventlog_evidence: Vec<CompiledEventLog>,
    /// Names of processes that exist only during a session.
    pub process_evidence: Vec<String>,
}

/// Lists ready for matching. Build with [`CompiledLists::compile`].
#[derive(Debug, Clone, Default)]
pub struct CompiledLists {
    pub version: String,
    pub tools: Vec<CompiledTool>,
    pub pup_publishers: Vec<PupPublisher>,
    /// Human-readable notes about entries that were skipped (also sent to `log::warn!`).
    pub warnings: Vec<String>,
}

impl CompiledLists {
    /// Compiles `lists`. `displayNamePatterns` are case-insensitive (like `installerPatterns`);
    /// session log `pattern`s are case-sensitive. Uncompilable patterns are skipped. Evidence with
    /// `verified: false` is parsed but not used.
    pub fn compile(lists: &DetectionLists) -> Self {
        let mut warnings = Vec::new();
        let tools = lists.remote_access_tools.iter().map(|t| compile_tool(t, &mut warnings)).collect();
        for w in &warnings {
            log::warn!("{w}");
        }
        CompiledLists {
            version: lists.version.clone(),
            tools,
            pup_publishers: lists.pup_publishers.clone(),
            warnings,
        }
    }

    /// Display name for a tool id.
    pub fn tool_name(&self, tool_id: &str) -> Option<&str> {
        self.tools.iter().find(|t| t.id == tool_id).map(|t| t.name.as_str())
    }

    /// Every publisher of every tool (used for the renamed-binary signer check).
    pub fn all_publishers(&self) -> impl Iterator<Item = &str> {
        self.tools.iter().flat_map(|t| t.publishers.iter().map(String::as_str))
    }

    /// The log files to tail: one entry per verified log evidence and expanded path.
    pub fn log_targets(&self, env: &PathEnv) -> Vec<LogTarget> {
        let mut out = Vec::new();
        for t in &self.tools {
            for (i, e) in t.log_evidence.iter().enumerate() {
                for path in env.expand(&e.path_template) {
                    out.push(LogTarget {
                        tool_id: t.id.clone(),
                        evidence_index: i,
                        path,
                    });
                }
            }
        }
        out
    }

    /// The event-log channels to query: `(tool id, channel, event ids)` for verified evidence.
    pub fn eventlog_targets(&self) -> Vec<(&str, &str, &[u32])> {
        self.tools
            .iter()
            .flat_map(|t| {
                t.eventlog_evidence
                    .iter()
                    .map(move |e| (t.id.as_str(), e.channel.as_str(), e.event_ids.as_slice()))
            })
            .collect()
    }
}

/// A log file the service should tail (and hand back as a `LogChunk` with this `path`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogTarget {
    pub tool_id: String,
    pub evidence_index: usize,
    pub path: String,
}

fn compile_tool(t: &RemoteAccessTool, warnings: &mut Vec<String>) -> CompiledTool {
    let w = &t.windows;
    let mut display_name_patterns = Vec::new();
    for p in &w.display_name_patterns {
        match RegexBuilder::new(p).case_insensitive(true).build() {
            Ok(r) => display_name_patterns.push(r),
            Err(_) => warnings.push(format!("skipped uncompilable displayNamePattern for tool {}", t.id)),
        }
    }
    let mut log_evidence = Vec::new();
    let mut eventlog_evidence = Vec::new();
    let mut process_evidence = Vec::new();
    for e in w.session_evidence.iter().filter(|e| e.is_verified()) {
        match e {
            SessionEvidence::Log { path, pattern, .. } => match Regex::new(pattern) {
                Ok(r) => log_evidence.push(CompiledLog {
                    path_template: path.clone(),
                    pattern: r,
                }),
                Err(_) => warnings.push(format!("skipped uncompilable session log pattern for tool {}", t.id)),
            },
            SessionEvidence::Eventlog { channel, event_ids, .. } if !event_ids.is_empty() => {
                eventlog_evidence.push(CompiledEventLog {
                    channel: channel.clone(),
                    event_ids: event_ids.clone(),
                });
            }
            SessionEvidence::Process { name, .. } if !name.trim().is_empty() => process_evidence.push(name.clone()),
            _ => {}
        }
    }
    CompiledTool {
        id: t.id.clone(),
        name: t.name.clone(),
        publishers: w.publishers.clone(),
        display_name_patterns,
        service_names: w.service_names.clone(),
        process_names: w.process_names.clone(),
        log_evidence,
        eventlog_evidence,
        process_evidence,
    }
}

/// Environment for expanding `%ProgramData%`, `%ProgramFiles%`, `%ProgramFiles(x86)%` and
/// `%AppData%` in session-log paths. The service fills it from the OS.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathEnv {
    /// Machine tokens, keyed by name without percent signs (`ProgramData`, `ProgramFiles`,
    /// `ProgramFiles(x86)`); lookups ignore case.
    #[serde(default)]
    pub vars: HashMap<String, String>,
    /// Each loaded profile's `%AppData%` (one entry per user).
    #[serde(default)]
    pub app_data: Vec<String>,
}

impl PathEnv {
    /// Expands `template`. `%AppData%` yields one path per profile; a template whose token is
    /// unknown (or `%AppData%` with no profiles) yields nothing. Duplicates are removed.
    pub fn expand(&self, template: &str) -> Vec<String> {
        let mut results = vec![String::new()];
        let mut rest = template;
        while let Some(start) = rest.find('%') {
            let (head, tail) = rest.split_at(start);
            for r in &mut results {
                r.push_str(head);
            }
            match tail[1..].find('%') {
                Some(end) => {
                    let token = &tail[1..1 + end];
                    let values: Vec<&str> = if token.eq_ignore_ascii_case("AppData") {
                        self.app_data.iter().map(String::as_str).collect()
                    } else {
                        self.vars
                            .iter()
                            .filter(|(k, _)| k.eq_ignore_ascii_case(token))
                            .map(|(_, v)| v.as_str())
                            .take(1)
                            .collect()
                    };
                    if values.is_empty() {
                        return Vec::new();
                    }
                    results = results
                        .iter()
                        .flat_map(|r| values.iter().map(move |v| format!("{r}{}", v.trim_end_matches('\\'))))
                        .collect();
                    rest = &tail[end + 2..];
                }
                None => {
                    // A lone percent sign is literal.
                    for r in &mut results {
                        r.push_str(tail);
                    }
                    rest = "";
                }
            }
        }
        for r in &mut results {
            r.push_str(rest);
        }
        results.sort();
        results.dedup();
        results
    }
}

/// Whether two Windows paths are the same file: ignores case and `/` versus `\`.
pub fn same_path(a: &str, b: &str) -> bool {
    norm_path(a) == norm_path(b)
}

pub(crate) fn norm_path(p: &str) -> String {
    p.trim().trim_matches('"').replace('/', "\\").to_ascii_lowercase()
}

/// Whether `signer` (an Authenticode subject or an uninstall `Publisher`) names `listed`.
///
/// Case-insensitive. Either the whole strings are equal, or `listed` appears inside `signer`
/// delimited on both sides (start/end, a non-alphanumeric before it, and `,` `;` `"` `/` or the end
/// after it), so `CN=AnyDesk Software GmbH, O=...` matches `AnyDesk Software GmbH` but
/// `AnyDesk Software GmbH Fake` does not.
pub fn publisher_matches(signer: &str, listed: &str) -> bool {
    let s = signer.trim().to_lowercase();
    let l = listed.trim().to_lowercase();
    if l.is_empty() {
        return false;
    }
    if s == l {
        return true;
    }
    let mut from = 0;
    while let Some(pos) = s[from..].find(&l) {
        let start = from + pos;
        let end = start + l.len();
        let before_ok = s[..start].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
        let after_ok = s[end..].chars().next().is_none_or(|c| matches!(c, ',' | ';' | '"' | '/'));
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}
