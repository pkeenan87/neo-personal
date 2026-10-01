//! Matching: turns a [`Snapshot`] into [`SignalEvent`]s, comparing with [`SeenState`].
//!
//! Events are produced only for something new. Events never carry paths. See
//! `_specs/desktop-agent.md` "Detection".

use std::collections::BTreeMap;

use time::OffsetDateTime;

use crate::events::{Discovery, SignalEvent, TccService, UnwantedReason, clean_peer_id};
use crate::lists::{CompiledLists, CompiledTool, norm_path, publisher_matches, same_path};
use crate::snapshot::{AppBundle, ExeFacts, Snapshot, TccRow, UninstallEntry};
use crate::state::{MAX_LINE_BYTES, SeenState, ToolSighting};

/// Bundle ids of Neo's own macOS apps (daemon bundle and tray); grants to them are never reported.
pub const NEO_BUNDLE_IDS: [&str; 2] = ["dev.neoshield.agent", "dev.neoshield.desktop"];

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

/// macOS: the bundles whose main executable has not been examined yet (hash and signature). The
/// service answers with [`ExeFacts`] whose `path` is the bundle path or its executable.
pub fn bundle_exe_hints(seen: &SeenState, bundles: &[AppBundle]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for b in bundles {
        if seen.program(&bundle_key(b)).is_some_and(|p| p.exe_checked) {
            continue;
        }
        if !out.contains(&b.path) {
            out.push(b.path.clone());
        }
    }
    out
}

fn bundle_key(b: &AppBundle) -> String {
    SeenState::program_key(&b.name, b.bundle_id.as_deref().or(b.team_id.as_deref()))
}

fn bundle_facts<'a>(b: &AppBundle, facts: &'a [ExeFacts]) -> Option<&'a ExeFacts> {
    let prefix = format!("{}/", b.path.trim_end_matches('/'));
    facts.iter().find(|f| f.path == b.path || f.path.starts_with(&prefix))
}

/// A macOS bundle id or Team ID names `t`.
fn mac_match(t: &CompiledTool, bundle_id: Option<&str>, team_id: Option<&str>) -> bool {
    bundle_id.is_some_and(|b| t.bundle_ids.iter().any(|l| eq_ci(l, b))) || team_id.is_some_and(|id| t.team_ids.iter().any(|l| eq_ci(l, id)))
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
        // macOS: bundle id, or the Team ID alone (a renamed copy keeps its signer).
        let by_mac = || {
            lists
                .tools
                .iter()
                .position(|t| mac_match(t, p.bundle_id.as_deref(), p.team_id.as_deref()))
        };
        if let Some(ti) = by_name.or_else(by_signer).or_else(by_mac) {
            let f = found.entry(ti).or_default();
            if f.publisher.is_none() {
                f.publisher = signer.and_then(|s| listed_publisher(&lists.tools[ti], s)).map(str::to_string);
            }
        }
    }
    let mut tool_bundles: Vec<bool> = vec![false; snapshot.app_bundles.len()];
    for (bi, b) in snapshot.app_bundles.iter().enumerate() {
        if let Some(ti) = lists
            .tools
            .iter()
            .position(|t| mac_match(t, b.bundle_id.as_deref(), b.team_id.as_deref()))
        {
            tool_bundles[bi] = true;
            let f = found.entry(ti).or_default();
            if f.publisher.is_none() {
                f.publisher = b.signer.clone().or_else(|| b.team_id.clone());
            }
            if f.version.is_none() {
                f.version = b.version.clone();
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
    let ul_targets = lists.unifiedlog_targets();
    for rec in &snapshot.unified_log_records {
        if rec.message.len() > MAX_LINE_BYTES {
            continue;
        }
        for target in ul_targets.iter().filter(|t| t.predicate == rec.predicate) {
            let Some(tool) = lists.tools.iter().find(|t| t.id == target.tool_id) else {
                continue;
            };
            let Some(caps) = tool.unifiedlog_evidence[target.evidence_index].pattern.captures(&rec.message) else {
                continue;
            };
            let peer = caps.name("peer").and_then(|m| clean_peer_id(m.as_str()));
            if seen.take_session_slot(&tool.id, peer.as_deref(), now) {
                events.push(SignalEvent::remote_session(now, &tool.id, peer.as_deref()));
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

    // ---- unwanted_software, macOS bundles ----
    for (bi, b) in snapshot.app_bundles.iter().enumerate() {
        let key = bundle_key(b);
        if b.name.trim().is_empty() || !handled.insert(key.clone()) {
            continue;
        }
        let is_new = seen.touch_program(&key, now, discovery_phase);
        let Some(prog) = seen.program(&key).copied() else { continue };
        let discovery = if prog.baseline { Discovery::Baseline } else { Discovery::New };
        let publisher = b.signer.as_deref().or(b.team_id.as_deref());
        if is_new {
            let hit = lists.pup_publishers.iter().any(|l| {
                l.publisher.as_deref().is_some_and(|lp| {
                    b.team_id.as_deref().is_some_and(|id| eq_ci(id, lp)) || b.signer.as_deref().is_some_and(|s| publisher_matches(s, lp))
                })
            });
            if hit {
                events.push(SignalEvent::unwanted_software(
                    now,
                    &b.name,
                    publisher,
                    b.version.as_deref(),
                    None,
                    UnwantedReason::PublisherList,
                    discovery,
                ));
            }
        }
        if prog.exe_checked {
            continue;
        }
        let Some(f) = bundle_facts(b, &snapshot.exe_facts) else { continue };
        seen.mark_exe_checked(&key);
        let sha = f.sha256.trim().to_ascii_lowercase();
        let hash_hit = lists
            .pup_publishers
            .iter()
            .any(|l| l.sha256.as_deref().is_some_and(|h| eq_ci(h, &sha)));
        if hash_hit {
            events.push(SignalEvent::unwanted_software(
                now,
                &b.name,
                publisher,
                b.version.as_deref(),
                Some(&sha),
                UnwantedReason::HashList,
                discovery,
            ));
        } else if !prog.baseline
            && !tool_bundles[bi]
            && !b.is_apple()
            && (b.team_id.is_none() || !f.signed_trusted)
            && seen.take_unsigned_slot(now)
        {
            events.push(SignalEvent::unwanted_software(
                now,
                &b.name,
                publisher,
                b.version.as_deref(),
                Some(&sha),
                UnwantedReason::UnsignedUnknown,
                Discovery::New,
            ));
        }
    }

    // ---- tcc_grant ----
    events.extend(detect_tcc(seen, snapshot.tcc.as_deref(), &snapshot.app_bundles, now));
    events
}

/// macOS permission grants. `rows` is the current TCC snapshot (`None` = unreadable: nothing
/// happens and the stored state is kept).
///
/// - The first readable snapshot is a silent baseline.
/// - Afterwards a `(db, client, service)` that was absent or not allowed and now has
///   `auth_value == 2` yields one `tcc_grant` (at most one per `(client, service)` per call).
///   Rows that stay allowed (Sequoia re-approvals touch them) yield nothing; a revoke followed by a
///   grant yields again. `last_modified` is deliberately not an input.
/// - Only `kTCCServiceScreenCapture`, `kTCCServiceAccessibility` and
///   `kTCCServiceSystemPolicyAllFiles` count; Neo's own bundle ids ([`NEO_BUNDLE_IDS`]) are ignored.
/// - `client_type` 0 is a bundle id (`bundleId` set; `app` is the installed bundle's name when
///   known, else the id); 1 is a path (`app` is its last component, no `bundleId`).
///
/// The service must return `Some` only when every database it could read was read: a database
/// that vanishes for one pass looks like revoked grants, and its return like new ones.
pub fn detect_tcc(seen: &mut SeenState, rows: Option<&[TccRow]>, bundles: &[AppBundle], now: OffsetDateTime) -> Vec<SignalEvent> {
    let Some(rows) = rows else { return Vec::new() };
    let mut current: BTreeMap<String, bool> = BTreeMap::new();
    let mut allowed_rows: Vec<(String, &TccRow, TccService)> = Vec::new();
    for r in rows {
        let Some(service) = TccService::from_tcc(&r.service) else {
            continue;
        };
        if r.client_type == 0 && NEO_BUNDLE_IDS.iter().any(|n| eq_ci(n, &r.client)) {
            continue;
        }
        let key = format!("{}\u{1f}{}\u{1f}{}", r.db, r.client, r.service);
        let allowed = r.auth_value == 2;
        let e = current.entry(key.clone()).or_insert(false);
        *e |= allowed;
        if allowed {
            allowed_rows.push((key, r, service));
        }
    }
    let (was_baselined, prev) = seen.swap_tcc(current);
    if !was_baselined {
        return Vec::new();
    }
    let mut events = Vec::new();
    let mut emitted: Vec<(&str, TccService)> = Vec::new();
    for (key, r, service) in allowed_rows {
        if prev.get(&key).copied().unwrap_or(false) || emitted.contains(&(r.client.as_str(), service)) {
            continue;
        }
        emitted.push((r.client.as_str(), service));
        let (app, bundle_id) = if r.client_type == 0 {
            let name = bundles
                .iter()
                .find(|b| b.bundle_id.as_deref().is_some_and(|id| eq_ci(id, &r.client)))
                .map(|b| b.name.as_str())
                .filter(|n| !n.trim().is_empty());
            (name.unwrap_or(&r.client), Some(r.client.as_str()))
        } else {
            (r.client.trim_end_matches('/').rsplit('/').next().unwrap_or(&r.client), None)
        };
        events.push(SignalEvent::tcc_grant(now, app, bundle_id, service));
    }
    events
}
