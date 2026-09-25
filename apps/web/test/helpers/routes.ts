import type { AgentEvent } from "@neo/core";
import { readAgentEvents } from "@/lib/ndjson";
import { resetArtifactStore } from "@/lib/server/artifacts";
import { memoryAuditLog } from "@/lib/server/audit";
import { resetMemoryUsage } from "@/lib/server/usage";
import { memoryVerdicts } from "@/lib/server/verdicts";
import { resetStubArtifacts, resetStubInbound } from "@/lib/server/phase1-stubs-dashboard";
import { resetMemoryMembers } from "@/lib/server/verdict-memory";
import { collect } from "../fixtures";

export function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Read the whole NDJSON body. The route persists the turn before closing the stream. */
export async function events(res: Response): Promise<AgentEvent[]> {
  return collect(readAgentEvents(res.body!));
}

export function textOf(evs: AgentEvent[]): string {
  return evs.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
}

/** Env for the zero-infrastructure path: MOCK_MODE, dev bypass, no database. */
export function stubBaseEnv(vi: { stubEnv: (k: string, v: string) => unknown }): void {
  vi.stubEnv("MOCK_MODE", "true");
  vi.stubEnv("DEV_AUTH_BYPASS", "true");
  vi.stubEnv("MOCK_STREAM_DELAY_MS", "0");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("INJECTION_GUARD_MODE", "monitor");
  vi.stubEnv("USAGE_CAP_MONTHLY_CHECKS", "");
  vi.stubEnv("USAGE_CAP_DAILY_TOKENS", "");
  // Phase 1 intake: in-memory blob client, plaintext artifacts.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("NEO_MASTER_KEY", "");
}

/** Clear every no-database fallback between tests. */
export function resetMemoryState(): void {
  const g = globalThis as { __neoMemoryConversationStore?: unknown };
  g.__neoMemoryConversationStore = undefined;
  resetMemoryUsage();
  memoryAuditLog().length = 0;
  memoryVerdicts().length = 0;
  resetArtifactStore();
  // dashboard (agent E)
  resetMemoryMembers();
  resetStubArtifacts();
  resetStubInbound();
}
