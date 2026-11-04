// @vitest-environment node
/**
 * The eve chat's end-of-turn work (agent/lib/turn-settled.ts): one `usage_events` row per turn with the
 * tokens of every model call (the old chat's `streamAgentRun`), the verdict the reply carries stored as a
 * `chat` verdict through the same sign-in hook, and facts read off a real folded session view. The
 * caller is the verified one; a refused or model-less turn records nothing.
 */
import { emptySessionView, foldEvents } from "eve/events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { settleTurn, turnFactsFromView, type TurnFacts } from "../agent/lib/turn-settled";
import { memoryVerdicts } from "@/lib/server/memory-state";
import { getSigninStore } from "@/lib/server/signin/store";
import { checkCaps, resetMemoryUsage } from "@/lib/server/usage";
import { resetMemoryState } from "@/lib/server/memory-state";
import { analyzeRaw, googleAlertRaw, triaged } from "./signin-fixtures";
import { stubBaseEnv } from "./helpers/routes";

const caller = { principalType: "user", principalId: "u-kid", attributes: { tenantId: "t-home", role: "member" } } as const;
const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 10, cacheWriteTokens: 5 });
const fence = (v: object) => "Here is what I found.\n\n```verdict\n" + JSON.stringify(v) + "\n```\nStay safe.";
const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  runs: [{ modelId: "anthropic/claude-sonnet-5", usage: usage(100, 20) }],
  replyText: "Hello.",
  emailOutputs: [],
  unreadableEmailCalls: 0,
  ...over,
});

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryUsage();
  resetMemoryState();
});
afterEach(() => vi.unstubAllEnvs());

describe("usage (2f)", () => {
  it("records one check per turn with the tokens of every model call, the last model and its tier", async () => {
    await settleTurn(
      caller,
      facts({
        runs: [
          { modelId: "anthropic/claude-sonnet-5", usage: usage(100, 20) },
          { modelId: "anthropic/claude-opus-5", usage: usage(300, 40) },
        ],
      }),
    );
    const caps = await checkCaps("t-home");
    expect(caps.used).toEqual({ monthlyChecks: 1, dailyTokens: 460 });
    const rows = (globalThis as { __neoMemoryUsage?: Record<string, unknown>[] }).__neoMemoryUsage!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: "t-home",
      userId: "u-kid",
      kind: "check",
      model: "anthropic/claude-opus-5",
      tier: "large",
      inputTokens: 400,
      outputTokens: 60,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
    });
  });

  it("counts toward the caps the gate enforces", async () => {
    vi.stubEnv("USAGE_CAP_MONTHLY_CHECKS", "1");
    expect((await checkCaps("t-home")).allowed).toBe(true);
    await settleTurn(caller, facts());
    expect(await checkCaps("t-home")).toMatchObject({ allowed: false, reason: "monthly_checks" });
    expect((await checkCaps("t-other")).allowed).toBe(true);
  });

  it("records nothing for the canned cap refusal, a turn that never reached a model, or a caller without a household", async () => {
    // eve reports a mock model as `<provider>/<modelId>` (seen on a live run of the built server).
    await settleTurn(caller, facts({ runs: [{ modelId: "eve-mock/neo-usage-refusal", usage: usage(0, 0) }] }));
    await settleTurn(caller, facts({ runs: [] }));
    await settleTurn({ principalType: "service", principalId: "s", attributes: { tenantId: "t-home" } }, facts());
    await settleTurn(null, facts());
    expect((await checkCaps("t-home")).used).toEqual({ monthlyChecks: 0, dailyTokens: 0 });
  });

  it("records a failed model call as a check with the tokens it reported", async () => {
    await settleTurn(caller, facts({ runs: [{ modelId: "anthropic/claude-haiku-4.5" }] }));
    expect((await checkCaps("t-home")).used).toEqual({ monthlyChecks: 1, dailyTokens: 0 });
  });
});

describe("verdicts (2d)", () => {
  it("stores the verdict block in the reply as a chat verdict for the caller's household", async () => {
    await settleTurn(caller, facts({ replyText: fence(triaged("malicious", { subject_type: "url" })) }));
    expect(memoryVerdicts()).toEqual([
      expect.objectContaining({ tenantId: "t-home", userId: "u-kid", source: "chat", conversationId: null, verdict: expect.objectContaining({ verdict: "malicious", subject_type: "url" }) }),
    ]);
  });

  it("stores nothing without a valid block, and drops a model-written signin_check", async () => {
    await settleTurn(caller, facts({ replyText: "Just chatting." }));
    await settleTurn(caller, facts({ replyText: "```verdict\n{not json}\n```" }));
    expect(memoryVerdicts()).toEqual([]);

    const forged = { ...triaged("likely_safe"), signin_check: { provider: "google", event: "new_signin", device_label: "Evil", first_seen: true } };
    await settleTurn(caller, facts({ replyText: fence(forged) }));
    expect(memoryVerdicts()).toHaveLength(1);
    expect(JSON.stringify(memoryVerdicts()[0])).not.toContain("Evil");
  });

  it("a verdict that cannot be read (reply stored by reference) is skipped, not guessed", async () => {
    await settleTurn(caller, facts({ replyText: null }));
    expect(memoryVerdicts()).toEqual([]);
    expect((await checkCaps("t-home")).used.monthlyChecks).toBe(1); // usage is still recorded
  });
});

describe("sign-in alert hook (2e)", () => {
  it("a recognized alert gets the deterministic check, and its event is stored for the card and the chat tool", async () => {
    const analysis = await analyzeRaw(googleAlertRaw());
    await settleTurn(caller, facts({ replyText: fence(triaged("likely_safe")), emailOutputs: [analysis] }));
    const [row] = memoryVerdicts();
    expect(row).toBeDefined();
    expect(row!.verdict.signin_check).toMatchObject({ device_label: "Windows", first_seen: true });
    expect(await getSigninStore().list("t-home", "u-kid")).toEqual([expect.objectContaining({ provider: "google", deviceLabel: "Windows", verdictId: row!.id })]);
  });

  it("a model-claimed sign-in alert with no analysis behind it is never stored as likely_safe", async () => {
    await settleTurn(caller, facts({ replyText: fence(triaged("likely_safe", { subject_type: "signin_alert" })) }));
    expect(memoryVerdicts()[0]!.verdict).toMatchObject({ verdict: "suspicious", subject_type: "signin_alert" });
  });

  it("fails closed when the hook throws", async () => {
    const analysis = await analyzeRaw(googleAlertRaw());
    await settleTurn(caller, facts({ replyText: fence(triaged("likely_safe")), emailOutputs: [analysis] }), {
      recordUsage: vi.fn(async () => undefined),
      saveChatVerdict: (await import("@/lib/server/verdicts")).saveChatVerdict,
      persistSigninEvent: vi.fn(async () => undefined),
      finalizeSigninVerdict: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(memoryVerdicts()[0]!.verdict).toMatchObject({ verdict: "suspicious" });
  });
});

describe("facts from a session view", () => {
  const at = "2026-11-03T10:00:00.000Z";
  let line = 0;
  const ev = (type: string, data: unknown, scope?: unknown) => ({ type, data, scope, meta: { position: { line: line++, index: 0 }, at, endOfLine: true } });

  it("reads runs, usage, the reply text and analyze_email results of one turn", () => {
    line = 0;
    const analysis = { input_kind: "pasted" };
    const events = [
      ev("turn.started", { turnId: "turn-1", cause: { kind: "message" }, follows: null }, { turnId: "turn-1" }),
      ev("model.requested", { runId: "run-1", owner: { turnId: "turn-1" } }, { turnId: "turn-1", runId: "run-1" }),
      ev("model.started", { runId: "run-1", modelId: "anthropic/claude-haiku-4.5", attempt: 0 }, { turnId: "turn-1", runId: "run-1" }),
      ev("call.requested", { callId: "c1", owner: { runId: "run-1" }, capability: { kind: "tool", name: "analyze_email" }, input: { text: "hi" } }, { turnId: "turn-1", runId: "run-1" }),
      ev("call.settled", { callId: "c1", outcome: "completed", output: analysis }, { turnId: "turn-1", runId: "run-1" }),
      ev("usage.recorded", { owner: { runId: "run-1" }, kind: "model", usage: usage(50, 7) }, { turnId: "turn-1", runId: "run-1" }),
      ev("model.settled", { runId: "run-1", outcome: "completed" }, { turnId: "turn-1", runId: "run-1" }),
      ev("content.completed", { partId: "p1", runId: "run-1", kind: "text", value: "Looks fine. ", phase: "reply" }, { turnId: "turn-1", runId: "run-1" }),
      ev("content.completed", { partId: "p2", runId: "run-1", kind: "text", value: "Bye.", phase: "reply" }, { turnId: "turn-1", runId: "run-1" }),
      ev("turn.settled", { turnId: "turn-1", outcome: "completed", reply: ["p1", "p2"] }, { turnId: "turn-1" }),
    ];
    const view = foldEvents(emptySessionView(), events);
    const f = turnFactsFromView(view, "turn-1");
    expect(f.runs).toEqual([{ modelId: "anthropic/claude-haiku-4.5", usage: usage(50, 7) }]);
    expect(f.replyText).toBe("Looks fine. Bye.");
    expect(f.emailOutputs).toEqual([analysis]);
    expect(f.unreadableEmailCalls).toBe(0);
    // Another turn's facts are empty.
    expect(turnFactsFromView(view, "turn-2")).toEqual({ runs: [], replyText: "", emailOutputs: [], unreadableEmailCalls: 0 });
  });
});
