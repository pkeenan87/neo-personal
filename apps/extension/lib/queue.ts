/**
 * Event queue: local dedupe, the 100-event/23h-stale queue, exponential backoff and the pending-
 * verdict polling schedule (`_specs/browser-extension.md` "Background"). Pure state transitions;
 * `entrypoints/background.ts` owns the network calls and timers.
 */
import { MAX_SIGNAL_BATCH, type SignalEvent } from "@neo/verdict";
import type { ExtensionState, PendingPoll, QueuedEvent } from "./types.js";

export const MAX_QUEUE = 100;
export const MAX_BATCH = MAX_SIGNAL_BATCH;
export const STALE_MS = 23 * 60 * 60 * 1000;
export const DEDUPE_MS = 60 * 60 * 1000;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

/** `web_blocked` repeats (same domain and category) are one event for this long (`_specs/v2-m2-child.md` section 6)... */
export const WEB_BLOCKED_COALESCE_MS = 10 * 60 * 1000;
/** ...except `self_harm`, which the server counts (3 blocks in an hour raise an incident), so it coalesces for a minute only. */
export const SELF_HARM_COALESCE_MS = 60 * 1000;

/**
 * What an event is deduped on, and for how long. Most detectors: `(detector, domain)` for an hour.
 * `web_blocked`: `(domain, category)`. `tamper_detected` has no domain: one per `reason` per hour, so a
 * bad bundle on every tick is one event, not a flood. Events with neither are never deduped here.
 */
function dedupe(event: SignalEvent): { key: string; windowMs: number } | undefined {
  if (event.detector === "web_blocked") {
    return { key: `web_blocked:${event.domain}:${event.category}`, windowMs: event.category === "self_harm" ? SELF_HARM_COALESCE_MS : WEB_BLOCKED_COALESCE_MS };
  }
  if (event.detector === "tamper_detected") return { key: `tamper_detected:${event.reason}`, windowMs: DEDUPE_MS };
  if ("domain" in event && event.domain) return { key: `${event.detector}:${event.domain}`, windowMs: DEDUPE_MS };
  return undefined;
}

/** True when an equivalent event was queued or sent within its window. */
export function isDeduped(state: ExtensionState, event: SignalEvent, now: number): boolean {
  const d = dedupe(event);
  if (!d) return false;
  const last = state.dedupe[d.key];
  return last !== undefined && now - last < d.windowMs;
}

/**
 * Adds an event to the queue unless it is deduped, dropping the oldest entries first if the
 * 100-event cap is exceeded. Returns the event unchanged: sending is `entrypoints/background.ts`'s
 * job.
 */
export function enqueueEvent(state: ExtensionState, event: SignalEvent, now: number): { state: ExtensionState; enqueued: boolean } {
  if (isDeduped(state, event, now)) return { state, enqueued: false };

  const item: QueuedEvent = { event, queuedAt: now, attempts: 0 };
  let queue = [...state.queue, item];
  if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);

  const d = dedupe(event);
  // Entries older than the longest window can never dedupe anything again: drop them so the record stays small.
  const kept = Object.fromEntries(Object.entries(state.dedupe).filter(([, at]) => now - at < DEDUPE_MS));
  const nextDedupe = d ? { ...kept, [d.key]: now } : kept;

  return { state: { ...state, queue, dedupe: nextDedupe }, enqueued: true };
}

/** Drops events queued more than 23h ago (the server would reject them as `stale` at 24h). */
export function dropStaleEvents(state: ExtensionState, now: number): ExtensionState {
  const queue = state.queue.filter((q) => now - q.queuedAt < STALE_MS);
  return queue.length === state.queue.length ? state : { ...state, queue };
}

/** The next batch to send (oldest first), at most `MAX_BATCH` events. */
export function nextBatch(state: ExtensionState): QueuedEvent[] {
  return state.queue.slice(0, MAX_BATCH);
}

/** True when the queue may be flushed now (no backoff in effect, or it has elapsed). */
export function canFlushNow(state: ExtensionState, now: number): boolean {
  return state.queueNextAttemptAt === null || now <= 0 || state.queueNextAttemptAt <= now;
}

/** Removes the given events from the queue (they were sent, whatever the per-event result). */
export function removeSent(state: ExtensionState, sent: QueuedEvent[]): ExtensionState {
  const sentIds = new Set(sent.map((q) => q.event.id));
  return { ...state, queue: state.queue.filter((q) => !sentIds.has(q.event.id)) };
}

/** Applies a failed batch send: bumps every sent event's `attempts` and sets backoff. */
export function applySendFailure(state: ExtensionState, sent: QueuedEvent[], now: number, retryAfterSeconds?: number): ExtensionState {
  const sentIds = new Set(sent.map((q) => q.event.id));
  const queue = state.queue.map((q) => (sentIds.has(q.event.id) ? { ...q, attempts: q.attempts + 1 } : q));
  const attempt = state.queueAttempt + 1;
  const backoffMs = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  return { ...state, queue, queueAttempt: attempt, queueNextAttemptAt: now + backoffMs };
}

/** Clears backoff after a successful send. */
export function applySendSuccess(state: ExtensionState): ExtensionState {
  return { ...state, queueAttempt: 0, queueNextAttemptAt: null };
}

// ---- Pending-verdict polling (`GET /api/signals/status`) ----------------

const PENDING_INITIAL_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const PENDING_STEADY_DELAY_MS = 30_000;
/** `_specs/browser-extension.md`: "then every 30 seconds up to 90 seconds in total". */
export const PENDING_WINDOW_MS = 90_000;

function delayForStep(step: number): number {
  return PENDING_INITIAL_DELAYS_MS[step] ?? PENDING_STEADY_DELAY_MS;
}

export function schedulePending(
  context: { id: string; domain: string; brand?: string; tabId?: number; originalUrl: string },
  now: number,
): PendingPoll {
  return { ...context, detector: "lookalike_login", startedAt: now, nextPollAt: now + delayForStep(0), step: 0 };
}

/** The pending ids whose next poll is due. */
export function duePending(state: ExtensionState, now: number): PendingPoll[] {
  return state.pending.filter((p) => p.nextPollAt <= now);
}

/** Advances a polled id to its next step, or drops it once the 90s window elapsed (gives up: no warning). */
export function advancePending(pending: PendingPoll, now: number): PendingPoll | null {
  if (now - pending.startedAt >= PENDING_WINDOW_MS) return null;
  const step = pending.step + 1;
  return { ...pending, step, nextPollAt: now + delayForStep(step) };
}

/** Removes ids the caller has resolved (a verdict came back, or the poll gave up). */
export function removePending(state: ExtensionState, ids: readonly string[]): ExtensionState {
  const idSet = new Set(ids);
  return { ...state, pending: state.pending.filter((p) => !idSet.has(p.id)) };
}

export function addPending(state: ExtensionState, poll: PendingPoll): ExtensionState {
  return { ...state, pending: [...state.pending.filter((p) => p.id !== poll.id), poll] };
}

export function updatePending(state: ExtensionState, poll: PendingPoll): ExtensionState {
  return { ...state, pending: state.pending.map((p) => (p.id === poll.id ? poll : p)) };
}
