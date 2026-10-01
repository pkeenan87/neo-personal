import { invoke } from "@tauri-apps/api/core";
import type { AgentClient, AgentError, Shell, Warning } from "./types";

/** Sends one request through the Rust side to the service pipe. */
async function request<T>(body: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>("agent_request", { request: body });
  } catch {
    const down: AgentError = { ok: false, code: "agent_unavailable", error: "Neo Protection isn't running on this computer." };
    return down as T;
  }
}

/** Blank optional fields are left out, so the service sees them as absent. */
function withServer(body: Record<string, unknown>, serverUrl?: string) {
  return serverUrl?.trim() ? { ...body, serverUrl: serverUrl.trim() } : body;
}

export function createTauriClient(): AgentClient {
  return {
    status: () => request({ op: "status" }),
    enrollPreview: (code, serverUrl) => request(withServer({ op: "enroll_preview", code }, serverUrl)),
    enroll: (code, name, serverUrl) => request(withServer({ op: "enroll", code, name }, serverUrl)),
    selfEnrollStart: (name, serverUrl) => request(withServer({ op: "self_enroll_start", name }, serverUrl)),
    selfEnrollPoll: () => request({ op: "self_enroll_poll" }),
    checkUrl: (url) => request({ op: "check_url", url }),
    unenroll: () => request({ op: "unenroll" }),
  };
}

export const tauriShell: Shell = {
  openUrl: (url) => invoke("open_url", { url }),
  close: () => invoke("close_self"),
};

/** The warning a window was opened for (kept by the Rust side, keyed by event id). */
export function loadWarning(eventId: string): Promise<Warning | null> {
  return invoke<Warning | null>("get_warning", { eventId });
}

/** Calls `onUpdate` when the same warning is pushed again (e.g. the owner was told). */
export async function onWarningUpdate(eventId: string, onUpdate: (w: Warning) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<Warning>("agent-warning", (e) => {
    if (e.payload.eventId === eventId) onUpdate(e.payload);
  });
}
