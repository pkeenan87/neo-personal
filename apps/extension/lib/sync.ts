/**
 * Background orchestration: enrollment, heartbeat, lists, the event queue and pending-verdict
 * polling, and showing the warning page (`_specs/browser-extension.md` "Background"). Kept
 * separate from `entrypoints/background.ts` so it can be unit-tested with `wxt/testing`'s
 * `fakeBrowser` and a mocked `fetch`, without needing a real service-worker environment.
 */
import { browser } from "wxt/browser";
import type { LookalikeIndicator, SignalEvent, TechSupportIndicator } from "@neo/verdict";
import type { DetectionListsPayload } from "@neo/tools/browser";
import * as api from "./api.js";
import { defaultBaseUrl, isValidServerUrl, normalizeBaseUrl } from "./config.js";
import { matchDownload } from "./detectors/downloads.js";
import { listsSnapshot } from "./listsSnapshot.js";
import { clientVersion, defaultDeviceName, detectPlatform } from "./platform.js";
import * as q from "./queue.js";
import { getState, updateState } from "./state.js";
import { DEFAULT_STATE, type DeviceInfo, type ExtensionState, type HouseholdInfo, type WarningRecord } from "./types.js";

const HEARTBEAT_ALARM = "neo-heartbeat";
const TICK_ALARM = "neo-tick";
const WARNING_WINDOW_MS = 60 * 60 * 1000;
const BYPASS_SUPPRESS_MS = 60 * 60 * 1000;

// ---- Server URL and device identity ---------------------------------------

/** The popup and options page are part of the same extension: they read the full state directly. */
export function getStateForClient(): Promise<ExtensionState> {
  return getState();
}

export async function resolveServerUrl(): Promise<string> {
  const state = await getState();
  return normalizeBaseUrl(state.serverUrl || defaultBaseUrl());
}

/** The options page's "Advanced: server" field. Only accepted before enrollment. */
export async function setServerUrl(url: string): Promise<{ ok: boolean; error?: "already_enrolled" | "invalid_url" }> {
  const state = await getState();
  if (state.connection === "enrolled") return { ok: false, error: "already_enrolled" };
  if (!isValidServerUrl(url)) return { ok: false, error: "invalid_url" };
  await updateState((s) => ({ ...s, serverUrl: normalizeBaseUrl(url) }));
  return { ok: true };
}

export function buildDeviceInfo(nameOverride?: string): DeviceInfo {
  const platform = detectPlatform();
  return { kind: "browser_extension", platform, name: nameOverride?.trim() || defaultDeviceName(platform), clientVersion: clientVersion() };
}

// ---- Enrollment ------------------------------------------------------------

export function previewCode(code: string): Promise<api.ApiResult<api.EnrollmentPreviewResponse>> {
  return resolveServerUrl().then((serverUrl) => api.previewEnrollment(serverUrl, code));
}

async function applyEnrollment(token: string, deviceId: string, device: DeviceInfo, household: HouseholdInfo | null): Promise<void> {
  await updateState((s) => ({ ...s, connection: "enrolled", token, deviceId, device, household, signIn: null }));
  await scheduleAlarms();
  await runHeartbeat();
}

export async function enrollWithCode(code: string, deviceName?: string): Promise<api.ApiResult<api.EnrollDeviceResponse>> {
  const serverUrl = await resolveServerUrl();
  const device = buildDeviceInfo(deviceName);
  const result = await api.enrollWithCode(serverUrl, code, device);
  if (result.ok) {
    await applyEnrollment(result.data.token, result.data.device.id, device, {
      householdName: result.data.householdName,
      memberName: result.data.memberName,
      ownerName: null,
    });
  }
  return result;
}

export async function startSignIn(deviceName?: string): Promise<api.ApiResult<api.DeviceAuthStartResponse>> {
  const serverUrl = await resolveServerUrl();
  const device = buildDeviceInfo(deviceName);
  const result = await api.startDeviceSignIn(serverUrl, device);
  if (result.ok) {
    await updateState((s) => ({
      ...s,
      connection: "enrolling",
      signIn: {
        deviceCode: result.data.deviceCode,
        interval: result.data.interval,
        verificationUri: result.data.verificationUriComplete,
        userCode: result.data.userCode,
        device,
      },
    }));
  }
  return result;
}

export async function cancelSignIn(): Promise<void> {
  await updateState((s) => (s.connection === "enrolling" ? { ...s, connection: "unenrolled", signIn: null } : s));
}

export type SignInPollResult = "pending" | "approved" | "error";

/** Polls `/api/desktop/device/token` once. The caller (options page / background timer) repeats it. */
export async function pollSignIn(): Promise<SignInPollResult> {
  const state = await getState();
  if (!state.signIn) return "error";
  const serverUrl = await resolveServerUrl();
  const result = await api.pollDeviceSignIn(serverUrl, state.signIn.deviceCode);
  if (!result.ok) {
    if (result.status === 403 || result.status === 410 || result.status === 404) {
      await updateState((s) => ({ ...s, connection: "unenrolled", signIn: null }));
      return "error";
    }
    return "pending"; // 429 or a network blip: keep polling.
  }
  if (result.data.status === "pending") return "pending";
  await applyEnrollment(result.data.token, result.data.device?.id ?? "", state.signIn.device, null);
  return "approved";
}

/** "Stop protecting this browser": revokes the token server-side (best effort) and resets state. */
export async function stopProtecting(): Promise<void> {
  const state = await getState();
  if (state.token) {
    const serverUrl = await resolveServerUrl();
    await api.unenrollSelf(serverUrl, state.token);
  }
  await clearAlarms();
  await updateState(() => ({ ...DEFAULT_STATE }));
  await updateBadge();
}

async function disconnect(): Promise<void> {
  await updateState((s) => ({ ...s, connection: "disconnected", token: null }));
  await updateBadge();
}

// ---- Heartbeat and lists ----------------------------------------------------

export async function runHeartbeat(): Promise<void> {
  const state = await getState();
  if (!state.token) return;
  const serverUrl = await resolveServerUrl();
  const result = await api.heartbeat(serverUrl, state.token, clientVersion());
  if (!result.ok) {
    if (result.status === 401) await disconnect();
    return; // 403 insufficient_scope or a transient error: logged elsewhere, never retried in a loop.
  }
  const data = result.data;
  const previousListsVersion = state.listsVersion;
  await updateState((s) => ({
    ...s,
    connection: "enrolled",
    household: { householdName: data.householdName, memberName: data.memberName, ownerName: s.household?.ownerName ?? null },
    lastHeartbeatAt: new Date().toISOString(),
    heartbeatSeconds: data.heartbeatSeconds,
    uninstallUrl: data.uninstallUrl ?? s.uninstallUrl,
  }));
  if (data.uninstallUrl) {
    try {
      await browser.runtime.setUninstallURL(data.uninstallUrl);
    } catch {
      /* not supported (e.g. under test, or a very old Firefox) */
    }
  }
  if (data.listsVersion !== previousListsVersion) await refreshLists();
  await updateBadge();
}

export async function refreshLists(): Promise<void> {
  const state = await getState();
  if (!state.token) return;
  const serverUrl = await resolveServerUrl();
  const result = await api.fetchLists(serverUrl, state.token, state.listsEtag);
  if (!result.ok) {
    if (result.status === 401) await disconnect();
    return;
  }
  if (result.status === 304) return;
  const lists = result.data;
  await updateState((s) => ({ ...s, lists, listsVersion: lists.version, listsEtag: result.etag ?? s.listsEtag, listsIsSnapshot: false }));
}

/** The bundled snapshot until the first successful fetch (`_specs/browser-extension.md`). */
export async function effectiveLists(): Promise<DetectionListsPayload> {
  const state = await getState();
  return state.lists ?? listsSnapshot;
}

// ---- Queue ------------------------------------------------------------------

async function enqueue(event: SignalEvent, context: { tabId?: number; originalUrl?: string } = {}): Promise<boolean> {
  const now = Date.now();
  let enqueued = false;
  await updateState((s) => {
    const r = q.enqueueEvent(s, event, now);
    enqueued = r.enqueued;
    if (!enqueued) return s;
    if (context.tabId === undefined && context.originalUrl === undefined) return r.state;
    return {
      ...r.state,
      queue: r.state.queue.map((item) => (item.event.id === event.id ? { ...item, ...context } : item)),
    };
  });
  if (enqueued) void flushQueue();
  return enqueued;
}

/**
 * Every mutation below is applied as an incremental `updateState` mutator keyed by event/pending
 * id, run against whatever the *current* state is when it executes — never a whole-state snapshot
 * captured before an `await` (a network call, most often). `showWarning` and other concurrent
 * callers (e.g. the immediate tech-support warning) each make their own `updateState` call in
 * between; replacing the entire state with a stale local copy here would silently erase theirs.
 */
export async function flushQueue(): Promise<void> {
  const now = Date.now();
  const snapshot = await getState();
  const afterStaleDrop = q.dropStaleEvents(snapshot, now);
  if (afterStaleDrop.queue.length !== snapshot.queue.length) {
    await updateState((s) => q.dropStaleEvents(s, now));
  }
  if (!snapshot.token || afterStaleDrop.queue.length === 0 || !q.canFlushNow(afterStaleDrop, now)) return;

  const batch = q.nextBatch(afterStaleDrop);
  const serverUrl = await resolveServerUrl();
  const result = await api.postSignals(serverUrl, snapshot.token, batch.map((b) => b.event));

  if (!result.ok) {
    if (result.status === 401) {
      await disconnect();
      return;
    }
    await updateState((s) => q.applySendFailure(s, batch, now, result.retryAfterSeconds));
    return;
  }

  const pendingToAdd: Parameters<typeof q.schedulePending>[0][] = [];
  const results = result.data.results;
  for (let i = 0; i < batch.length; i++) {
    const item = batch[i]!;
    const r = results[i];
    if (r?.pending && item.event.detector === "lookalike_login") {
      pendingToAdd.push({
        id: item.event.id,
        domain: item.event.domain,
        brand: item.event.brand,
        tabId: item.tabId,
        originalUrl: item.originalUrl ?? `https://${item.event.domain}/`,
      });
    }
  }

  let addedPending = false;
  await updateState((s) => {
    let next = q.applySendSuccess(s);
    next = q.removeSent(next, batch);
    for (const context of pendingToAdd) next = q.addPending(next, q.schedulePending(context, now));
    addedPending = pendingToAdd.length > 0;
    return next;
  });
  if (addedPending) void pumpPending();
}

// ---- Pending-verdict polling -------------------------------------------------

export async function pumpPending(): Promise<void> {
  const now = Date.now();
  const snapshot = await getState();
  const due = q.duePending(snapshot, now);
  if (due.length === 0 || !snapshot.token) return;

  const serverUrl = await resolveServerUrl();
  const result = await api.getSignalsStatus(serverUrl, snapshot.token, due.map((d) => d.id));

  if (!result.ok) {
    if (result.status === 401) {
      await disconnect();
      return;
    }
    await updateState((s) => {
      let next = s;
      for (const p of due) {
        const current = next.pending.find((x) => x.id === p.id);
        if (!current) continue; // already resolved concurrently
        const advanced = q.advancePending(current, now);
        next = advanced ? q.updatePending(next, advanced) : q.removePending(next, [p.id]);
      }
      return next;
    });
    return;
  }

  const byId = new Map(result.data.results.map((r) => [r.id, r]));
  const toWarn: (Omit<WarningRecord, "shownAt"> & { ownerNotified: boolean })[] = [];
  await updateState((s) => {
    let next = s;
    for (const p of due) {
      const current = next.pending.find((x) => x.id === p.id);
      if (!current) continue; // already resolved concurrently
      const r = byId.get(p.id);
      if (r && r.outcome !== "pending") {
        next = q.removePending(next, [p.id]);
        if (r.outcome === "alerted") {
          toWarn.push({ id: p.id, domain: current.domain, detector: current.detector, brand: current.brand, tabId: current.tabId, originalUrl: current.originalUrl, ownerNotified: r.alerted });
        }
        continue;
      }
      const advanced = q.advancePending(current, now);
      next = advanced ? q.updatePending(next, advanced) : q.removePending(next, [p.id]); // gave up: fails open, no warning
    }
    return next;
  });
  for (const w of toWarn) await showWarning(w);
}

// ---- Showing the warning page ------------------------------------------------

function isSuppressed(state: ExtensionState, domain: string, now: number): boolean {
  const until = state.suppressUntil[domain];
  return until !== undefined && now < until;
}

export async function showWarning(record: Omit<WarningRecord, "shownAt">): Promise<void> {
  const warning: WarningRecord = { ...record, shownAt: Date.now() };
  await updateState((s) => ({ ...s, warnings: [...s.warnings.filter((w) => w.id !== warning.id), warning] }));
  if (record.tabId !== undefined) {
    const url = browser.runtime.getURL(`/warning.html?e=${encodeURIComponent(record.id)}`);
    try {
      await browser.tabs.update(record.tabId, { url });
    } catch {
      // The scam page's beforeunload blocked navigation, or the tab is gone: close and reopen.
      try {
        await browser.tabs.remove(record.tabId);
      } catch {
        /* already gone */
      }
      await browser.tabs.create({ url });
    }
  }
  await updateBadge();
}

// ---- Detector entry points (called from content-script messages) -----------

export async function reportTechSupportHit(
  input: { domain: string; pageUrl: string; indicators: TechSupportIndicator[]; phone?: string },
  tabId?: number,
): Promise<void> {
  const now = Date.now();
  const state = await getState();
  if (isSuppressed(state, input.domain, now)) return;

  const event: SignalEvent = {
    id: crypto.randomUUID(),
    type: "page",
    detector: "tech_support_scam",
    observedAt: new Date(now).toISOString(),
    domain: input.domain,
    indicators: input.indicators,
    ...(input.phone ? { phone: input.phone } : {}),
  };
  const enqueued = await enqueue(event, { tabId, originalUrl: input.pageUrl });
  if (enqueued) {
    // Shows immediately, without waiting for a server round trip (`_specs/browser-extension.md`).
    await showWarning({ id: event.id, domain: input.domain, detector: "tech_support_scam", tabId, originalUrl: input.pageUrl, ownerNotified: false });
  }
}

export async function reportLookalikeHit(
  input: { domain: string; pageUrl: string; brand: string; indicators: LookalikeIndicator[] },
  tabId?: number,
): Promise<void> {
  const now = Date.now();
  const state = await getState();
  if (isSuppressed(state, input.domain, now)) return;

  const event: SignalEvent = {
    id: crypto.randomUUID(),
    type: "page",
    detector: "lookalike_login",
    observedAt: new Date(now).toISOString(),
    domain: input.domain,
    brand: input.brand,
    indicators: input.indicators,
  };
  // No immediate warning: the server escalates it, and `pumpPending` shows it only if confirmed.
  await enqueue(event, { tabId, originalUrl: input.pageUrl });
}

export async function reportWarningBypassed(relatesTo: string, domain: string, originalUrl: string, tabId: number): Promise<void> {
  const now = Date.now();
  await updateState((s) => ({ ...s, suppressUntil: { ...s.suppressUntil, [domain]: now + BYPASS_SUPPRESS_MS } }));
  const event: SignalEvent = {
    id: crypto.randomUUID(),
    type: "page",
    detector: "warning_bypassed",
    observedAt: new Date(now).toISOString(),
    relatesTo,
    domain,
  };
  await enqueue(event, { tabId });
  try {
    await browser.tabs.update(tabId, { url: originalUrl });
  } catch {
    /* best effort: the person can navigate back themselves */
  }
}

export async function handleDownloadCreated(download: { id: number; filename?: string; url: string; referrer?: string }): Promise<void> {
  const lists = await effectiveLists();
  const match = matchDownload(download, lists.remoteAccessTools);
  if (!match) return;

  const state = await getState();
  if (state.token) {
    const event: SignalEvent = {
      id: crypto.randomUUID(),
      type: "page",
      detector: "remote_tool_download",
      observedAt: new Date().toISOString(),
      domain: match.domain,
      toolId: match.toolId,
      fileName: match.fileName,
    };
    await enqueue(event);
  }
  try {
    await browser.notifications.create(`neo-download-${download.id}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("/icon/128.png"),
      title: "Neo",
      message: `You are downloading ${match.toolName}. If someone on the phone asked you to install this, it is a scam. Hang up, and don't open it.`,
    });
  } catch {
    /* notifications can still fail to create in some environments; never block on it */
  }
}

export async function checkUrlOnDemand(url: string): Promise<api.ApiResult<api.CheckUrlResponse>> {
  const state = await getState();
  if (!state.token) return { ok: false, status: 0, error: "This browser is not connected to a household.", code: "not_enrolled" };
  const serverUrl = await resolveServerUrl();
  const result = await api.checkUrl(serverUrl, state.token, url);
  if (!result.ok && result.status === 401) await disconnect();
  return result;
}

// ---- Alarms and the toolbar icon ---------------------------------------------

export async function scheduleAlarms(): Promise<void> {
  const state = await getState();
  const minutes = Math.max(1, Math.round(state.heartbeatSeconds / 60));
  await browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: minutes });
  await browser.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
}

export async function clearAlarms(): Promise<void> {
  await browser.alarms.clear(HEARTBEAT_ALARM);
  await browser.alarms.clear(TICK_ALARM);
}

export async function handleAlarm(name: string): Promise<void> {
  if (name === HEARTBEAT_ALARM) await runHeartbeat();
  if (name === TICK_ALARM) {
    await flushQueue();
    await pumpPending();
    await updateBadge();
  }
}

/** Every icon path WXT discovers in `public/icon/` (`.wxt/types/paths.d.ts`, regenerated by `wxt prepare`). */
const ICON_PATHS = {
  enrolled: { 16: "/icon/16.png", 32: "/icon/32.png", 48: "/icon/48.png", 128: "/icon/128.png" },
  grey: { 16: "/icon/16-grey.png", 32: "/icon/32-grey.png", 48: "/icon/48-grey.png", 128: "/icon/128-grey.png" },
} as const;

/** Shield when enrolled, grey shield when not; a red "!" badge while a warning is within the hour. */
export async function updateBadge(): Promise<void> {
  const state = await getState();
  const now = Date.now();
  const hasRecentWarning = state.warnings.some((w) => now - w.shownAt < WARNING_WINDOW_MS);
  const enrolled = state.connection === "enrolled";
  try {
    const variant = ICON_PATHS[enrolled ? "enrolled" : "grey"];
    const path = {
      16: browser.runtime.getURL(variant[16]),
      32: browser.runtime.getURL(variant[32]),
      48: browser.runtime.getURL(variant[48]),
      128: browser.runtime.getURL(variant[128]),
    };
    await browser.action.setIcon({ path });
    if (hasRecentWarning) {
      await browser.action.setBadgeText({ text: "!" });
      await browser.action.setBadgeBackgroundColor({ color: "#c0392b" });
    } else if (!enrolled) {
      await browser.action.setBadgeText({ text: "!" });
      await browser.action.setBadgeBackgroundColor({ color: "#6b727c" });
    } else {
      await browser.action.setBadgeText({ text: "" });
    }
  } catch {
    /* the action API can be unavailable in a test environment; never block on it */
  }
}

/** Runs on install, on browser startup, and lazily whenever the background wakes. */
export async function init(): Promise<void> {
  const state = await getState();
  await scheduleAlarms();
  if (state.token) {
    await runHeartbeat();
    await flushQueue();
    await pumpPending();
  }
  await updateBadge();
}
