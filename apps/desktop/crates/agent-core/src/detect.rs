//! Matching: turns a [`Snapshot`] into [`SignalEvent`]s, comparing with [`SeenState`].
//!
//! Events are produced only for something new. Events never carry paths. See
//! `_specs/desktop-agent.md` "Detection".

use std::collections::BTreeMap;

use time::OffsetDateTime;

use crate::events::{Discovery, SignalEvent, UnwantedReason, clean_peer_id};
use crate::lists::{CompiledLists, CompiledTool, norm_path, publisher_matches, same_path};
use crate::snapshot::{ExeFacts, Snapshot, UninstallEntry};
use crate::state::{MAX_LINE_BYTES, SeenState, ToolSighting};

/// How to find a program's main executable (for [`ExeFacts`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExeHint {
    /// The `.exe` named by `DisplayIcon`.
    File(String),
    /// The first `.exe` in `InstallLocation`; the service picks it and reports its real path.
    FirstExeIn(String),
}

/// Which programs' executables the service should hash and check next: entries not yet examined.
/// Files outside a program's own install location are never examined.
pub fn exe_hints(seen: &SeenState, entries: &[UninstallEntry]) -> Vec<ExeHint> {
    let mut out: Vec<ExeHint> = Vec::new();
    for e in entries {
        let key = SeenState::program_key(&e.display_name, e.publisher.as_deref());
        if seen.program(&key).is_some_and(|p| p.exe_checked) {
            continue;
        }
        if let Some(h) = exe_hint(e)
            && !out.contains(&h)
        {
            out.push(h);
        }
    }
    out
}

/// The main-executable hint for one entry: `DisplayIcon` when it names an `.exe`, else the install
/// location.
pub fn exe_hint(e: &UninstallEntry) -> Option<ExeHint> {
    if let Some(icon) = e.display_icon.as_deref().and_then(icon_exe_path) {
        return Some(ExeHint::File(icon));
    }
    e.install_location
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| ExeHint::FirstExeIn(s.trim_matches('"').to_string()))
}

/// `"C:\x\a.exe",0` -> `C:\x\a.exe`; `None` unless it ends in `.exe`.
fn icon_exe_path(icon: &str) -> Option<String> {
    let t = icon.trim();
    let path = if let Some(rest) = t.strip_prefix('"') {
        rest.split('"').next().unwrap_or("")
    } else {
        // Strip a trailing `,<index>`.
        match t.rsplit_once(',') {
            Some((p, idx)) if idx.trim().trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) => p,
            _ => t,
        }
    };
    let path = path.trim();
    path.to_ascii_lowercase().ends_with(".exe").then(|| path.to_string())
}

fn find_facts<'a>(e: &UninstallEntry, facts: &'a [ExeFacts]) -> Option<&'a ExeFacts> {
    match exe_hint(e)? {
        ExeHint::File(p) => facts.iter().find(|f| same_path(&f.path, &p)),
        ExeHint::FirstExeIn(dir) => {
            let prefix = format!("{}\\", norm_path(&dir).trim_end_matches('\\'));
            facts.iter().find(|f| norm_path(&f.path).starts_with(&prefix))
        }
    }
}

#[derive(Default)]
struct Found {
    publisher: Option<String>,
    version: Option<String>,
}

fn eq_ci(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

fn tool_for_uninstall(t: &CompiledTool, e: &UninstallEntry) -> bool {
    t.display_name_patterns.iter().any(|r| r.is_match(&e.display_name))
        && (t.publishers.is_empty()
            || e.publisher
                .as_deref()
                .is_some_and(|p| t.publishers.iter().any(|l| publisher_matches(p, l))))
}

fn listed_publisher<'a>(t: &'a CompiledTool, signer: &str) -> Option<&'a str> {
    t.publishers.iter().find(|l| publisher_matches(signer, l)).map(String::as_str)
}

/// Runs every detector over `snapshot`.
///
/// - `discovery_phase`: the first full scan after enrollment. Everything found is marked
///   `baseline` and recorded in `seen`; later appearances are `new`.
/// - Tool events: one per tool, again only after 7 days absent.
/// - Session events: from verified evidence only, one per (tool, peer) per 30 minutes. A tool's
///   process merely running is never a session.
/// - Unwanted software: `publisher_list` and `hash_list` (also baseline), `unsigned_unknown`
///   only for non-baseline programs, at most 20 per UTC day.
///
/// Tool events come first, then session events, then unwanted software.
pub fn detect(
    lists: &CompiledLists,
    seen: &mut SeenState,
    snapshot: &Snapshot,
    now: OffsetDateTime,
    discovery_phase: bool,
) -> Vec<SignalEvent> {
    seen.prune(now);
    let mut events = Vec::new();
    let tool_discovery = if discovery_phase { Discovery::Baseline } else { Discovery::New };

    // ---- remote_access_tool ----
    let mut found: BTreeMap<usize, Found> = BTreeMap::new();
    let mut tool_entries: Vec<bool> = vec![false; snapshot.uninstall_entries.len()];
    for (ei, e) in snapshot.uninstall_entries.iter().enumerate() {
        for (ti, t) in lists.tools.iter().enumerate() {
            if tool_for_uninstall(t, e) {
                tool_entries[ei] = true;
                let f = found.entry(ti).or_default();
                if f.publisher.is_none() {
                    f.publisher = e.publisher.clone();
                }
                if f.version.is_none() {
                    f.version = e.version.clone();
                }
            }
        }
    }
    for s in &snapshot.services {
        for (ti, t) in lists.tools.iter().enumerate() {
            if t.service_names.iter().any(|n| eq_ci(n, &s.name)) {
                found.entry(ti).or_default();
            }
        }
    }
    for p in &snapshot.processes {
        let signer = p.signer.as_deref();
        let by_name = lists.tools.iter().position(|t| {
            t.process_names.iter().any(|n| eq_ci(n, &p.image_name))
                && (t.publishers.is_empty() || signer.is_some_and(|s| listed_publisher(t, s).is_some()))
        });
        // A renamed binary: the signer is some tool's publisher whatever the file is called.
        let by_signer = || signer.and_then(|s| lists.tools.iter().position(|t| listed_publisher(t, s).is_some()));
        if let Some(ti) = by_name.or_else(by_signer) {
            let f = found.entry(ti).or_default();
            if f.publisher.is_none() {
                f.publisher = signer.and_then(|s| listed_publisher(&lists.tools[ti], s)).map(str::to_string);
            }
        }
    }
    for (ti, f) in &found {
        let t = &lists.tools[*ti];
        match seen.touch_tool(&t.id, now) {
            ToolSighting::Known => {}
            ToolSighting::First | ToolSighting::Returned => {
                events.push(SignalEvent::remote_access_tool(
                    now,
                    &t.id,
                    &t.name,
                    f.publisher.as_deref(),
                    f.version.as_deref(),
                    tool_discovery,
                ));
            }
        }
    }

    // ---- remote_access_session ----
    let targets = lists.log_targets(&snapshot.env);
    for chunk in &snapshot.log_chunks {
        for target in targets.iter().filter(|t| same_path(&t.path, &chunk.path)) {
            let Some(tool) = lists.tools.iter().find(|t| t.id == target.tool_id) else {
                continue;
            };
            let evidence = &tool.log_evidence[target.evidence_index];
            for line in chunk.lines.iter().filter(|l| l.len() <= MAX_LINE_BYTES) {
                let Some(caps) = evidence.pattern.captures(line) else { continue };
                let peer = caps.name("peer").and_then(|m| clean_peer_id(m.as_str()));
                if seen.take_session_slot(&tool.id, peer.as_deref(), now) {
                    events.push(SignalEvent::remote_session(now, &tool.id, peer.as_deref()));
                }
            }
        }
    }
    for t in &lists.tools {
        let running = snapshot
            .processes
            .iter()
            .any(|p| t.process_evidence.iter().any(|n| eq_ci(n, &p.image_name)));
        if running && seen.take_session_slot(&t.id, None, now) {
            events.push(SignalEvent::remote_session(now, &t.id, None));
        }
        let hit = snapshot.event_records.iter().any(|r| {
            t.eventlog_evidence
                .iter()
                .any(|e| eq_ci(&e.channel, &r.channel) && e.event_ids.contains(&r.event_id))
        });
        if hit && seen.take_session_slot(&t.id, None, now) {
            events.push(SignalEvent::remote_session(now, &t.id, None));
        }
    }

    // ---- unwanted_software ----
    let mut handled = std::collections::HashSet::new();
    for (ei, e) in snapshot.uninstall_entries.iter().enumerate() {
        let key = SeenState::program_key(&e.display_name, e.publisher.as_deref());
        if e.display_name.trim().is_empty() || !handled.insert(key.clone()) {
            continue;
        }
        let is_new = seen.touch_program(&key, now, discovery_phase);
        let Some(prog) = seen.program(&key).copied() else { continue };
        let discovery = if prog.baseline { Discovery::Baseline } else { Discovery::New };
        if is_new {
            let hit = e.publisher.as_deref().is_some_and(|p| {
                lists
                    .pup_publishers
                    .iter()
                    .any(|l| l.publisher.as_deref().is_some_and(|lp| publisher_matches(p, lp)))
            });
            if hit {
                events.push(SignalEvent::unwanted_software(
                    now,
                    &e.display_name,
                    e.publisher.as_deref(),
                    e.version.as_deref(),
                    None,
                    UnwantedReason::PublisherList,
                    discovery,
                ));
            }
        }
        if prog.exe_checked {
            continue;
        }
        let Some(f) = find_facts(e, &snapshot.exe_facts) else { continue };
        seen.mark_exe_checked(&key);
        let sha = f.sha256.trim().to_ascii_lowercase();
        let hash_hit = lists
            .pup_publishers
            .iter()
            .any(|l| l.sha256.as_deref().is_some_and(|h| eq_ci(h, &sha)));
        if hash_hit {
            events.push(SignalEvent::unwanted_software(
                now,
                &e.display_name,
                e.publisher.as_deref(),
                e.version.as_deref(),
                Some(&sha),
                UnwantedReason::HashList,
                discovery,
            ));
        } else if !prog.baseline && !tool_entries[ei] && !f.signed_trusted && seen.take_unsigned_slot(now) {
            events.push(SignalEvent::unwanted_software(
                now,
                &e.display_name,
                e.publisher.as_deref(),
                e.version.as_deref(),
                Some(&sha),
                UnwantedReason::UnsignedUnknown,
                Discovery::New,
            ));
        }
    }
    events
}
