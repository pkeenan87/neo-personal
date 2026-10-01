mod common;

use common::t0;
use neo_agent_core::api::{SignalResult, SignalStatus};
use neo_agent_core::events::SignalEvent;
use neo_agent_core::queue::{BACKOFF_MAX, EventQueue, MAX_QUEUED};
use time::{Duration, OffsetDateTime};

fn ev(at: OffsetDateTime) -> SignalEvent {
    SignalEvent::remote_session(at, "anydesk", Some("1"))
}

fn result(e: &SignalEvent, status: SignalStatus, reason: Option<&str>) -> SignalResult {
    SignalResult {
        id: Some(e.id.clone()),
        status,
        reason: reason.map(str::to_string),
        severity: Some("high".into()),
        verdict_id: None,
        pending: None,
    }
}

#[test]
fn drops_events_older_than_23_hours() {
    let mut q = EventQueue::default();
    q.push([ev(t0()), ev(t0() + Duration::hours(10))], t0() + Duration::hours(10));
    assert_eq!(q.len(), 2);
    q.prune(t0() + Duration::hours(23) + Duration::seconds(1));
    assert_eq!(q.len(), 1);
    q.prune(t0() + Duration::hours(34));
    assert!(q.is_empty());
}

#[test]
fn keeps_at_most_200_dropping_oldest() {
    let mut q = EventQueue::default();
    let evs: Vec<_> = (0..230).map(|i| ev(t0() + Duration::seconds(i))).collect();
    let newest = evs.last().unwrap().id.clone();
    q.push(evs, t0() + Duration::minutes(10));
    assert_eq!(q.len(), MAX_QUEUED);
    assert_eq!(q.events().last().unwrap().id, newest);
}

#[test]
fn batches_of_at_most_50_oldest_first() {
    let mut q = EventQueue::default();
    let evs: Vec<_> = (0..120).map(|i| ev(t0() + Duration::seconds(i))).collect();
    let first = evs[0].id.clone();
    q.push(evs, t0() + Duration::minutes(5));
    let b = q.next_batch(t0() + Duration::minutes(5)).unwrap();
    assert_eq!(b.len(), 50);
    assert_eq!(b[0].id, first);
}

#[test]
fn backoff_doubles_caps_and_honours_retry_after() {
    let now = t0();
    let mut q = EventQueue::default();
    q.push([ev(now)], now);
    q.on_failure(now, None);
    assert_eq!(q.retry_at(), Some(now + Duration::seconds(30)));
    assert!(q.next_batch(now + Duration::seconds(29)).is_none());
    assert!(q.next_batch(now + Duration::seconds(30)).is_some());
    q.on_failure(now, None);
    assert_eq!(q.retry_at(), Some(now + Duration::seconds(60)));
    q.on_failure(now, None);
    assert_eq!(q.retry_at(), Some(now + Duration::seconds(120)));
    // Retry-After wins when longer than the computed delay.
    q.on_failure(now, Some(Duration::seconds(900)));
    assert_eq!(q.retry_at(), Some(now + Duration::seconds(900)));
    for _ in 0..30 {
        q.on_failure(now, None);
    }
    assert_eq!(q.retry_at(), Some(now + BACKOFF_MAX));
}

#[test]
fn settled_events_leave_and_success_resets_backoff() {
    let now = t0();
    let mut q = EventQueue::default();
    let (a, b, c, d) = (ev(now), ev(now), ev(now), ev(now));
    q.push([a.clone(), b.clone(), c.clone(), d.clone()], now);
    q.on_failure(now, None);
    let sent = q.next_batch(now + Duration::minutes(1)).unwrap();
    let results = vec![
        result(&a, SignalStatus::Accepted, None),
        result(&b, SignalStatus::Duplicate, None),
        result(&c, SignalStatus::Rejected, Some("stale")),
        result(&d, SignalStatus::Rejected, Some("rate_limited")),
    ];
    let settled = q.on_results(&sent, &results, now + Duration::minutes(1));
    assert_eq!(settled.len(), 3);
    assert_eq!(q.len(), 1, "rate_limited stays for a later try");
    assert!(q.retry_at().is_some());
    let sent = q.next_batch(now + Duration::minutes(10)).unwrap();
    q.on_results(&sent, &[result(&d, SignalStatus::Accepted, None)], now + Duration::minutes(10));
    assert!(q.is_empty());
    assert!(q.retry_at().is_none());
}

#[test]
fn missing_result_keeps_the_event() {
    let now = t0();
    let mut q = EventQueue::default();
    let a = ev(now);
    q.push([a.clone()], now);
    let sent = q.next_batch(now).unwrap();
    assert!(q.on_results(&sent, &[], now).is_empty());
    assert_eq!(q.len(), 1);
}

#[test]
fn queue_roundtrips_as_json() {
    let mut q = EventQueue::default();
    q.push([ev(t0())], t0());
    q.on_failure(t0(), None);
    assert_eq!(EventQueue::from_json(&q.to_json()), q);
}
