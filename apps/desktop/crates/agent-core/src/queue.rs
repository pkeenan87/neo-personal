//! The outgoing event queue (`queue.json`): bounded, age-limited, with exponential backoff.

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::api::{SignalResult, SignalStatus};
use crate::events::{MAX_BATCH, SignalEvent};

/// At most this many events are kept; the oldest are dropped first.
pub const MAX_QUEUED: usize = 200;
/// Events older than this are dropped (the server rejects them as `stale` at 24 hours).
pub const MAX_AGE: Duration = Duration::hours(23);
/// First retry delay.
pub const BACKOFF_BASE: Duration = Duration::seconds(30);
/// Longest retry delay.
pub const BACKOFF_MAX: Duration = Duration::hours(1);

/// Persistent event queue.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EventQueue {
    events: Vec<SignalEvent>,
    /// Consecutive failures since the last success.
    failures: u32,
    /// Unix seconds before which nothing is sent.
    #[serde(default)]
    retry_at: Option<i64>,
}

impl EventQueue {
    pub fn from_json(s: &str) -> Self {
        serde_json::from_str(s).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn events(&self) -> &[SignalEvent] {
        &self.events
    }

    /// Adds events, then enforces the age and size limits.
    pub fn push(&mut self, new: impl IntoIterator<Item = SignalEvent>, now: OffsetDateTime) {
        self.events.extend(new);
        self.prune(now);
    }

    /// Drops events older than 23 hours, then the oldest beyond 200.
    pub fn prune(&mut self, now: OffsetDateTime) {
        self.events.retain(|e| now - e.observed_at <= MAX_AGE);
        if self.events.len() > MAX_QUEUED {
            let excess = self.events.len() - MAX_QUEUED;
            self.events.drain(..excess);
        }
    }

    /// The next batch (at most 50, oldest first) when one is due: `None` when empty or still backing off.
    pub fn next_batch(&mut self, now: OffsetDateTime) -> Option<Vec<SignalEvent>> {
        self.prune(now);
        if self.events.is_empty() || self.retry_at.is_some_and(|t| now.unix_timestamp() < t) {
            return None;
        }
        Some(self.events.iter().take(MAX_BATCH).cloned().collect())
    }

    /// When the next send may happen, if the queue is backing off.
    pub fn retry_at(&self) -> Option<OffsetDateTime> {
        self.retry_at.and_then(|t| OffsetDateTime::from_unix_timestamp(t).ok())
    }

    /// The whole request failed (network, 5xx, 429): back off. `retry_after` (the server's
    /// `Retry-After`) is honoured when longer than the exponential delay.
    pub fn on_failure(&mut self, now: OffsetDateTime, retry_after: Option<Duration>) {
        self.failures = self.failures.saturating_add(1);
        let exp = BACKOFF_BASE * 2i32.saturating_pow((self.failures - 1).min(16));
        let mut delay = exp.min(BACKOFF_MAX);
        if let Some(ra) = retry_after {
            delay = delay.max(ra);
        }
        self.retry_at = Some((now + delay).unix_timestamp());
    }

    /// The server answered with per-event results for `sent` (the batch from [`Self::next_batch`]).
    /// Accepted, duplicate and permanently rejected events leave the queue; events with no result,
    /// or rejected as `rate_limited`, stay for a later try. Returns the settled `(event, result)`
    /// pairs (so the caller can warn or refresh expected tools).
    pub fn on_results(&mut self, sent: &[SignalEvent], results: &[SignalResult], now: OffsetDateTime) -> Vec<(SignalEvent, SignalResult)> {
        let mut settled = Vec::new();
        let mut keep_retry = false;
        for e in sent {
            let r = results.iter().find(|r| r.id.as_deref() == Some(e.id.as_str()));
            match r {
                Some(r) if r.status == SignalStatus::Rejected && r.reason.as_deref() == Some("rate_limited") => keep_retry = true,
                Some(r) => {
                    self.events.retain(|q| q.id != e.id);
                    settled.push((e.clone(), r.clone()));
                }
                None => keep_retry = true,
            }
        }
        if keep_retry {
            self.on_failure(now, None);
        } else {
            self.failures = 0;
            self.retry_at = None;
        }
        settled
    }
}
