/**
 * Child-mode orchestration (`_specs/v2-m2-child.md` sections 4 to 6): fetch and verify the signed
 * policy bundle, keep the last valid one, download the category lists, install the DNR rules, and
 * answer "is this host blocked?". `lib/sync.ts` calls in from the heartbeat, the alarms and the
 * message router; nothing here imports it (the way to report an event is passed in).
 *
 * Trust: a bundle is applied only after `verifyPolicyEnvelope` passes against the keys pinned at
 * build time (`keys.ts`). A bundle that fails keeps the previous one in force and is reported as
 * `tamper_detected { reason: "bad_policy_signature" }`.
 */
import { browser } from "wxt/browser";
import { registrableDomain } from "@neo/tools/browser";
import { verifyPolicyEnvelope, type PolicyBundle, type PolicyEnvelope, type PolicyPublicJwk, type SignalEvent } from "@neo/verdict";
import * as api from "../api.js";
import { getState, updateState } from "../state.js";
import type { TrackedRequest } from "../types.js";
import { createPrefixLookup, syncCategoryLists, type FetchBytes } from "./categories.js";
import { policyKeys } from "./keys.js";
import { decideHost, type BlockDecision } from "./match.js";
import { buildDnrRules, type DnrRule } from "./rules.js";
import type { BinStore } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_REQUESTS = 10;

/** The slice of `declarativeNetRequest` this module needs; tests pass a fake. */
export interface DnrApi {
  getDynamicRules(): Promise<{ id: number }[]>;
  updateDynamicRules(options: { removeRuleIds: number[]; addRules: DnrRule[] }): Promise<void>;
}

export interface PolicyContext {
  serverUrl: string;
  token: string;
  /** Queues a signal event; resolves true when it was queued (false when deduped). */
  report: (event: SignalEvent) => Promise<boolean>;
  keys?: PolicyPublicJwk[];
  now?: () => number;
  store?: BinStore;
  fetchBytes?: FetchBytes;
  dnr?: DnrApi;
}

export type SyncOutcome = "updated" | "unchanged" | "rejected" | "unavailable" | "unauthorized";

function realDnr(): DnrApi | null {
  const dnr = (browser as unknown as { declarativeNetRequest?: DnrApi }).declarativeNetRequest;
  return dnr && typeof dnr.updateDynamicRules === "function" ? dnr : null;
}

/** Replaces every dynamic rule with `rules` (all of them are ours). False when the browser has no DNR. */
export async function replaceDnrRules(rules: DnrRule[], dnr: DnrApi | null = realDnr()): Promise<boolean> {
  if (!dnr) return false;
  const existing = await dnr.getDynamicRules();
  await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
  return true;
}

function tamper(now: number): SignalEvent {
  return { id: crypto.randomUUID(), type: "tamper", detector: "tamper_detected", observedAt: new Date(now).toISOString(), reason: "bad_policy_signature" };
}

/**
 * Fetches `GET /api/devices/policy` and applies the result. The `If-None-Match` is the stored
 * `ETag`, left out within a day of the stored bundle's `expiresAt` (the ETag does not change when
 * only the timestamps do, so a fresh signature has to be asked for).
 */
export async function syncPolicy(ctx: PolicyContext): Promise<SyncOutcome> {
  const now = (ctx.now ?? Date.now)();
  const state = await getState();
  const stored = state.policy;
  const nearExpiry = stored ? Date.parse(stored.envelope.bundle.expiresAt) - now < DAY_MS : false;
  const result = await api.fetchPolicy(ctx.serverUrl, ctx.token, stored && !nearExpiry ? stored.etag : null);

  if (!result.ok) return result.status === 401 ? "unauthorized" : "unavailable"; // 404 on an older server, 503 unsigned, a network error: keep what we have.
  if (result.status === 304) {
    if (stored && state.policyApplied !== stored.envelope.bundle.policyVersion) await applyStoredPolicy(ctx);
    return "unchanged";
  }

  const verified = await verifyPolicyEnvelope(result.data, ctx.keys ?? policyKeys());
  if (!verified.ok) {
    // A response this build cannot parse (`malformed`) is most likely a newer server; only a signature or key problem is tamper.
    if (verified.reason !== "malformed") await ctx.report(tamper(now));
    return "rejected";
  }
  if (state.deviceId && verified.bundle.deviceId !== state.deviceId) {
    await ctx.report(tamper(now));
    return "rejected";
  }
  // A validly signed but older bundle is a rollback (e.g. a replayed looser policy): keep the newer one.
  if (stored && Date.parse(verified.bundle.issuedAt) < Date.parse(stored.envelope.bundle.issuedAt)) {
    await ctx.report(tamper(now));
    return "rejected";
  }
  await updateState((s) => ({ ...s, policy: { envelope: result.data as PolicyEnvelope, etag: result.etag ?? null, fetchedAt: now } }));
  await applyStoredPolicy(ctx);
  return "updated";
}

/**
 * Brings the device in line with the stored bundle: category files downloaded and checked, DNR rules
 * rebuilt (removed when the mode is not Child). `policyApplied` (what the heartbeat reports) is set
 * only when everything the bundle needs is in place.
 */
export async function applyStoredPolicy(ctx: Pick<PolicyContext, "now" | "store" | "fetchBytes" | "dnr">): Promise<void> {
  const now = (ctx.now ?? Date.now)();
  const state = await getState();
  const bundle = state.policy?.envelope.bundle;
  if (!bundle) return;
  const child = bundle.mode === "child";
  const lists = await syncCategoryLists(state.lists?.categoryLists, child ? bundle.web.categories : [], { store: ctx.store, fetchBytes: ctx.fetchBytes });
  const built = buildDnrRules(bundle, now);
  let rulesInstalled = true;
  try {
    // No DNR in this browser is not a failure: the content script still enforces.
    await replaceDnrRules(built.rules, ctx.dnr ?? realDnr());
  } catch (err) {
    rulesInstalled = false;
    console.warn("Neo: could not install the filtering rules", err);
  }
  await updateState((s) => ({
    ...s,
    categoryData: lists.data,
    rulesRebuildAt: built.rebuildAt,
    policyApplied: lists.complete && rulesInstalled ? bundle.policyVersion : s.policyApplied,
  }));
}

/** Removes every rule and downloaded list (stop protecting, or the device left Child mode for good). */
export async function clearEnforcement(ctx: Pick<PolicyContext, "store" | "dnr"> = {}): Promise<void> {
  try {
    await replaceDnrRules([], ctx.dnr ?? realDnr());
  } catch {
    /* nothing to remove */
  }
  await syncCategoryLists(undefined, [], { store: ctx.store });
}

/** The bundle in force, or null. */
export async function currentBundle(): Promise<PolicyBundle | null> {
  return (await getState()).policy?.envelope.bundle ?? null;
}

/** Is this hostname blocked by the bundle in force? Allow lists first, then the block list, then the categories. */
export async function checkHost(hostname: string, opts: { now?: number; store?: BinStore } = {}): Promise<BlockDecision> {
  const state = await getState();
  const bundle = state.policy?.envelope.bundle;
  if (!bundle || bundle.mode !== "child") return { blocked: false };
  return decideHost(hostname, bundle, createPrefixLookup(state.categoryData, opts.store), opts.now ?? Date.now());
}

/** The `web_blocked` event for a block of `domain` (registrable domain only; never the URL). Null for the parent's own list or an unusable host. */
export function webBlockedEvent(domain: string, category: BlockDecision["category"], now: number): SignalEvent | null {
  if (!category) return null;
  const info = registrableDomain(domain);
  if (!info || info.isIp) return null;
  return { id: crypto.randomUUID(), type: "page", detector: "web_blocked", observedAt: new Date(now).toISOString(), domain: info.registrable, category };
}

// ---- Child requests ---------------------------------------------------------

export async function trackRequest(request: TrackedRequest): Promise<void> {
  await updateState((s) => ({ ...s, trackedRequests: [...s.trackedRequests.filter((r) => r.id !== request.id), request].slice(-MAX_TRACKED_REQUESTS) }));
}

export async function settleRequest(id: string): Promise<void> {
  await updateState((s) => ({ ...s, trackedRequests: s.trackedRequests.map((r) => (r.id === id ? { ...r, settled: true } : r)) }));
}

export async function untrackRequest(id: string): Promise<void> {
  await updateState((s) => ({ ...s, trackedRequests: s.trackedRequests.filter((r) => r.id !== id) }));
}

/** Requests still pending as far as this device knows (drops the expired ones). */
export async function pendingRequests(now: number): Promise<TrackedRequest[]> {
  const state = await getState();
  const live = state.trackedRequests.filter((r) => Date.parse(r.expiresAt) > now);
  if (live.length !== state.trackedRequests.length) await updateState((s) => ({ ...s, trackedRequests: live }));
  return live;
}
