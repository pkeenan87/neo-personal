import { vi } from "vitest";
import type { AgentClient, AgentStatus, Shell } from "../src/lib/types";

export function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    ok: true,
    state: "not_enrolled",
    version: "0.1.0",
    serverUrl: "https://www.neoshield.dev",
    computerName: "GRANDMA-PC",
    deviceName: null,
    memberName: null,
    householdName: null,
    ownerName: null,
    lastCheckIn: null,
    lastWarningAt: null,
    updateAvailable: null,
    ...over,
  };
}

/** A fake service. Override any method per test. */
export function fakeClient(over: Partial<AgentClient> = {}): AgentClient {
  return {
    status: vi.fn(async () => status()),
    enrollPreview: vi.fn(async () => ({ ok: true as const, householdName: "The Keenans", memberName: "Grandma", ownerName: "Pat", expiresAt: "2026-10-02T00:00:00Z" })),
    enroll: vi.fn(async () => status({ state: "enrolled", memberName: "Grandma", householdName: "The Keenans", ownerName: "Pat" })),
    selfEnrollStart: vi.fn(async () => ({
      ok: true as const,
      userCode: "ABCD-EFGH",
      verificationUri: "https://neo.test/desktop/authorize",
      verificationUriComplete: "https://neo.test/desktop/authorize?code=ABCD-EFGH",
      expiresIn: 600,
      interval: 1,
    })),
    selfEnrollPoll: vi.fn(async () => ({ ok: true as const, status: "pending" as const, interval: 1 })),
    checkUrl: vi.fn(async () => ({ ok: true as const, rating: "no_known_problems" as const, domain: "example.com", reasons: [], checkedAt: "2026-10-01T00:00:00Z" })),
    unenroll: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

export function fakeShell(): Shell & { openUrl: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { openUrl: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}
