//! Local working state (`seen.json`, `cursors.json`). Never sent anywhere.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// Entries not seen for this long are forgotten.
pub const PRUNE_AFTER_DAYS: i64 = 30;
/// A tool is reported again only after it has been absent this long.
pub const TOOL_RESEND_AFTER_DAYS: i64 = 7;
/// One session event per (tool, peer) in this window.
pub const SESSION_DEDUPE_SECS: i64 = 30 * 60;
/// Local cap on `unsigned_unknown` events per UTC day.
pub const UNSIGNED_UNKNOWN_DAILY_CAP: u32 = 20;

const DAY: i64 = 86_400;

/// When a tool or program was first and last seen (unix seconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub first_seen: i64,
    pub last_seen: i64,
}

/// A program (uninstall entry) already known. Keyed by name and publisher, never by path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProgramSeen {
    pub first_seen: i64,
    pub last_seen: i64,
    /// Present at the first full scan after enrollment.
    pub baseline: bool,
    /// Its main executable has been examined (hash and signature).
    #[serde(default)]
    pub exe_checked: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct DayCount {
    /// `YYYY-MM-DD` (UTC).
    day: String,
    count: u32,
}

/// What `seen.json` holds: names only, with first and last times.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeenState {
    tools: BTreeMap<String, Span>,
    programs: BTreeMap<String, ProgramSeen>,
    /// `"<tool>\u{1f}<peer>"` -> unix seconds of the last session event.
    sessions: BTreeMap<String, i64>,
    unsigned_unknown: DayCount,
    /// macOS: `"<db>\u{1f}<client>\u{1f}<service>"` -> allowed (`auth_value == 2`) in the last
    /// readable TCC snapshot, for the three reported services only.
    #[serde(default)]
    tcc: BTreeMap<String, bool>,
    /// A readable TCC snapshot has been taken (it was the silent baseline).
    #[serde(default)]
    tcc_baselined: bool,
}

/// Result of recording a tool sighting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolSighting {
    /// Never seen (or pruned): report it.
    First,
    /// Seen before but absent for 7 days or more: report it again.
    Returned,
    /// Present continuously (or recently): do not report.
    Known,
}

impl SeenState {
    /// Parses `seen.json`; an unreadable file starts fresh (the next scan is then a baseline only
    /// if the service says so).
    pub fn from_json(s: &str) -> Self {
        serde_json::from_str(s).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// Forgets tools and programs not seen for 30 days and session dedupe entries older than a day.
    pub fn prune(&mut self, now: OffsetDateTime) {
        let cutoff = now.unix_timestamp() - PRUNE_AFTER_DAYS * DAY;
        self.tools.retain(|_, s| s.last_seen >= cutoff);
        self.programs.retain(|_, p| p.last_seen >= cutoff);
        let session_cutoff = now.unix_timestamp() - DAY;
        self.sessions.retain(|_, t| *t >= session_cutoff);
    }

    /// Records that `tool_id` is present now.
    pub fn touch_tool(&mut self, tool_id: &str, now: OffsetDateTime) -> ToolSighting {
        let t = now.unix_timestamp();
        match self.tools.get_mut(tool_id) {
            None => {
                self.tools.insert(
                    tool_id.to_string(),
                    Span {
                        first_seen: t,
                        last_seen: t,
                    },
                );
                ToolSighting::First
            }
            Some(s) => {
                let absent = t - s.last_seen;
                s.last_seen = t;
                if absent >= TOOL_RESEND_AFTER_DAYS * DAY {
                    ToolSighting::Returned
                } else {
                    ToolSighting::Known
                }
            }
        }
    }

    pub fn tool_span(&self, tool_id: &str) -> Option<Span> {
        self.tools.get(tool_id).copied()
    }

    /// Key for a program: lowercase `name` and `publisher`.
    pub fn program_key(display_name: &str, publisher: Option<&str>) -> String {
        format!(
            "{}\u{1f}{}",
            display_name.trim().to_lowercase(),
            publisher.unwrap_or("").trim().to_lowercase()
        )
    }

    pub fn program(&self, key: &str) -> Option<&ProgramSeen> {
        self.programs.get(key)
    }

    /// Records a program sighting. Returns `true` when it was new.
    pub fn touch_program(&mut self, key: &str, now: OffsetDateTime, baseline: bool) -> bool {
        let t = now.unix_timestamp();
        match self.programs.get_mut(key) {
            Some(p) => {
                p.last_seen = t;
                false
            }
            None => {
                self.programs.insert(
                    key.to_string(),
                    ProgramSeen {
                        first_seen: t,
                        last_seen: t,
                        baseline,
                        exe_checked: false,
                    },
                );
                true
            }
        }
    }

    pub fn mark_exe_checked(&mut self, key: &str) {
        if let Some(p) = self.programs.get_mut(key) {
            p.exe_checked = true;
        }
    }

    /// Whether a session event for (`tool_id`, `peer`) may be sent now; records it when so.
    pub fn take_session_slot(&mut self, tool_id: &str, peer: Option<&str>, now: OffsetDateTime) -> bool {
        let key = format!("{tool_id}\u{1f}{}", peer.unwrap_or(""));
        let t = now.unix_timestamp();
        if let Some(last) = self.sessions.get(&key)
            && t - *last < SESSION_DEDUPE_SECS
        {
            return false;
        }
        self.sessions.insert(key, t);
        true
    }

    /// Whether one more `unsigned_unknown` event fits under today's cap; counts it when so.
    pub fn take_unsigned_slot(&mut self, now: OffsetDateTime) -> bool {
        let u = now.to_offset(time::UtcOffset::UTC);
        let day = format!("{:04}-{:02}-{:02}", u.year(), u8::from(u.month()), u.day());
        if self.unsigned_unknown.day != day {
            self.unsigned_unknown = DayCount { day, count: 0 };
        }
        if self.unsigned_unknown.count >= UNSIGNED_UNKNOWN_DAILY_CAP {
            return false;
        }
        self.unsigned_unknown.count += 1;
        true
    }

    /// Whether the first readable TCC snapshot has been recorded.
    pub fn tcc_baselined(&self) -> bool {
        self.tcc_baselined
    }

    /// Replaces the stored TCC state with `current` and returns the previous one. The first call
    /// is the baseline (the caller sends nothing for it).
    pub fn swap_tcc(&mut self, current: BTreeMap<String, bool>) -> (bool, BTreeMap<String, bool>) {
        let was_baselined = self.tcc_baselined;
        self.tcc_baselined = true;
        (was_baselined, std::mem::replace(&mut self.tcc, current))
    }

    pub fn tool_count(&self) -> usize {
        self.tools.len()
    }

    pub fn program_count(&self) -> usize {
        self.programs.len()
    }
}

// ---- Log cursors -------------------------------------------------------

/// At most this many bytes are read from a log per poll.
pub const MAX_READ_BYTES: u64 = 64 * 1024;
/// Lines longer than this are ignored.
pub const MAX_LINE_BYTES: usize = 4 * 1024;

/// Whether a log never seen before is read from its start or only from its end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum History {
    /// Start at the current end: old lines are not events. Use for files that already existed when
    /// the service first looked.
    Skip,
    /// Start at 0. Use for files that appeared after the service was already watching.
    Read,
}

/// Where the next read of one log starts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogCursor {
    pub offset: u64,
    /// Identity of the file (e.g. creation time or file index) so a rotation to a larger file is
    /// noticed.
    #[serde(default)]
    pub file_token: Option<String>,
    /// Inside an over-long line: drop bytes up to the next newline.
    #[serde(default)]
    pub skipping: bool,
}

/// A byte range to read from a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadRange {
    pub start: u64,
    pub len: u64,
}

impl LogCursor {
    /// Decides what to read given the file's current length. Resets to the start when the file
    /// shrank (truncation or rotation) or its `file_token` changed. Reads at most 64 KB from the
    /// offset; a bigger backlog is caught up over successive polls. `None` when there is nothing to read.
    pub fn plan_read(&mut self, file_len: u64, file_token: Option<&str>) -> Option<ReadRange> {
        if let (Some(old), Some(new)) = (self.file_token.as_deref(), file_token)
            && old != new
        {
            self.offset = 0;
            self.skipping = false;
        }
        if file_token.is_some() {
            self.file_token = file_token.map(str::to_string);
        }
        if file_len < self.offset {
            self.offset = 0;
            self.skipping = false;
        }
        if file_len == self.offset {
            return None;
        }
        Some(ReadRange {
            start: self.offset,
            len: (file_len - self.offset).min(MAX_READ_BYTES),
        })
    }

    /// Takes the bytes read for `range` and returns the new complete lines. A trailing partial
    /// line stays unread for the next poll (unless it is already over 4 KB, then it is dropped).
    /// Lines over 4 KB are ignored; `\r` is trimmed; invalid UTF-8 is replaced.
    pub fn consume(&mut self, range: &ReadRange, bytes: &[u8]) -> Vec<String> {
        let mut data = bytes;
        let mut consumed = 0usize;
        if self.skipping {
            match data.iter().position(|b| *b == b'\n') {
                Some(i) => {
                    data = &data[i + 1..];
                    consumed = i + 1;
                    self.skipping = false;
                }
                None => {
                    self.offset = range.start + bytes.len() as u64;
                    self.skipping = true;
                    return Vec::new();
                }
            }
        }
        let mut lines = Vec::new();
        let mut rest = data;
        while let Some(i) = rest.iter().position(|b| *b == b'\n') {
            let line = &rest[..i];
            if line.len() <= MAX_LINE_BYTES {
                let text = String::from_utf8_lossy(line);
                let text = text.trim_end_matches('\r');
                if !text.trim().is_empty() {
                    lines.push(text.to_string());
                }
            }
            consumed += i + 1;
            rest = &rest[i + 1..];
        }
        if rest.len() > MAX_LINE_BYTES {
            // An unterminated line already too long: ignore it and its continuation.
            consumed += rest.len();
            self.skipping = true;
        }
        self.offset = range.start + consumed as u64;
        lines
    }
}

/// `cursors.json`: log offsets and event-log bookmarks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursors {
    logs: BTreeMap<String, LogCursor>,
    /// Channel -> unix seconds of the newest record already handled.
    event_bookmarks: BTreeMap<String, i64>,
}

impl Cursors {
    pub fn from_json(s: &str) -> Self {
        serde_json::from_str(s).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// The cursor for `path` (case-insensitive), created with `history` when new: `Skip` starts at
    /// `file_len`.
    pub fn log_cursor(&mut self, path: &str, file_len: u64, history: History) -> &mut LogCursor {
        self.logs.entry(path.trim().to_lowercase()).or_insert_with(|| LogCursor {
            offset: if history == History::Skip { file_len } else { 0 },
            file_token: None,
            skipping: false,
        })
    }

    /// Forgets cursors for paths no longer watched.
    pub fn retain_logs(&mut self, keep: impl Fn(&str) -> bool) {
        self.logs.retain(|k, _| keep(k));
    }

    pub fn event_bookmark(&self, channel: &str) -> Option<i64> {
        self.event_bookmarks.get(&channel.to_lowercase()).copied()
    }

    pub fn set_event_bookmark(&mut self, channel: &str, unix_secs: i64) {
        self.event_bookmarks.insert(channel.to_lowercase(), unix_secs);
    }
}
