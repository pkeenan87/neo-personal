// @vitest-environment node
import { wrapToolResult, type AgentResult, type MessageParam, type ToolRegistry } from "@neo/core";
import type { Verdict } from "@neo/verdict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamAgentRun } from "@/lib/server/agent-run";
import { getConversationStore } from "@/lib/server/conversation-store";
import { memoryState, memoryVerdicts } from "@/lib/server/memory-state";
import { findEmailAnalysis, rewriteFinalVerdict, signinOverrideNote } from "@/lib/server/signin/chat-hook";
import { answerSigninCheck } from "@/lib/server/signin/service";
import { extractVerdict } from "@/lib/server/verdicts";
import { memorySigninStore } from "@/lib/server/signin/store";
import { DEV_SESSION_IDS, type NeoSession } from "@/lib/session";
import { events, resetMemoryState, stubBaseEnv, textOf } from "./helpers/routes";
import { analyzeRaw, googleAlertRaw, googleForwardedRaw, triaged } from "./signin-fixtures";

const session: NeoSession = { tenantId: DEV_SESSION_IDS.tenantId, userId: DEV_SESSION_IDS.userId, role: "owner", email: "o@example.test", name: "Owner", scopes: ["full"] };

const fence = (v: Verdict) => `Here is what I found.\n\n\`\`\`verdict\n${JSON.stringify(v, null, 2)}\n\`\`\``;

/** The messages one chat turn leaves behind: the model calls analyze_email, then answers with a verdict block. */
async function turn(raw: string, modelVerdict: Verdict, opts: { truncated?: boolean } = {}): Promise<MessageParam[]> {
  const analysis = await analyzeRaw(raw);
  const content = opts.truncated
    ? wrapToolResult("analyze_email", analysis, { maxTokens: 50 })
    : wrapToolResult("analyze_email", analysis);
  return [
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "analyze_email", input: { raw: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content }] },
    { role: "assistant", content: [{ type: "text", text: fence(modelVerdict) }] },
  ];
}

async function runTurn(newMessages: MessageParam[], onRun?: (common: { tools: ToolRegistry }) => Promise<unknown>) {
  const store = getConversationStore();
  const { id } = await store.create({ tenantId: session.tenantId, userId: session.userId, title: "t" });
  const user: MessageParam = { role: "user", content: "check this" };
  const res = streamAgentRun({
    session, conversationId: id, prefix: [user], kind: "check", signal: new AbortController().signal,
    run: async (common): Promise<AgentResult> => {
      await onRun?.(common as { tools: ToolRegistry });
      return { messages: [user, ...newMessages], newMessages, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" };
    },
  });
  const evs = await events(res);
  const stored = await store.get(id, session.tenantId);
  return { evs, stored };
}

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
});
afterEach(() => vi.unstubAllEnvs());

describe("findEmailAnalysis", () => {
  it("reads the analyze_email result out of its trust-boundary envelope", async () => {
    const msgs = await turn(googleAlertRaw(), triaged("likely_safe"));
    expect(findEmailAnalysis(msgs)?.signin_alert?.template_id).toBe("google.new_signin.v1");
  });
  it("is undefined without an analyze_email result or when the result was truncated", async () => {
    expect(findEmailAnalysis([{ role: "assistant", content: "hi" }])).toBeUndefined();
    expect(findEmailAnalysis(await turn(googleAlertRaw(), triaged("likely_safe"), { truncated: true }))).toBeUndefined();
  });
});

describe("rewriteFinalVerdict", () => {
  it("replaces the verdict block and appends one note line", () => {
    const msgs: MessageParam[] = [{ role: "assistant", content: [{ type: "text", text: fence(triaged("likely_safe")) }] }];
    const final = triaged("suspicious", { headline: "Rule headline" });
    const out = rewriteFinalVerdict(msgs, final, signinOverrideNote(final));
    const text = (out[0]!.content as { text: string }[])[0]!.text;
    expect(text).toContain('"verdict": "suspicious"');
    expect(text).not.toContain("likely_safe");
    expect(text.trimEnd().split("\n").at(-1)).toBe("A deterministic sign-in alert rule decided this verdict (Suspicious), not the model.");
  });
});

describe("chat path hook (streamAgentRun)", () => {
  it("overrides the model's likely_safe on an unverified alert, stores the overridden verdict and notes it", async () => {
    const { evs, stored } = await runTurn(await turn(googleAlertRaw(), triaged("likely_safe")));
    const rows = memoryVerdicts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toMatchObject({ verdict: "suspicious", subject_type: "signin_alert" });
    expect(rows[0]!.verdict.signin_check).toMatchObject({ provider: "google", device_label: "Windows", first_seen: true });
    // The note is streamed and persisted in the final assistant message with the rewritten verdict.
    expect(textOf(evs)).toContain("A deterministic sign-in alert rule decided this verdict (Suspicious)");
    const last = stored!.messages.at(-1)!;
    const text = (last.content as { text: string }[])[0]!.text;
    expect(text).toContain('"verdict": "suspicious"');
    expect(text).toContain("deterministic sign-in alert rule");
    // The event is stored for the member, linked to the verdict.
    const list = await memorySigninStore.list(session.tenantId, session.userId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: "google", verdictId: rows[0]!.id, authenticated: true });
  });

  it("a fake alert is stored malicious", async () => {
    await runTurn(await turn(googleAlertRaw({ links: ["https://evil.example.net/x"] }), triaged("likely_safe")));
    expect(memoryVerdicts()[0]!.verdict.verdict).toBe("malicious");
    expect(memoryVerdicts()[0]!.verdict.signin_check).toBeUndefined();
  });

  it("a forwarded copy without authentication is insufficient_evidence", async () => {
    await runTurn(await turn(googleForwardedRaw(), triaged("likely_safe")));
    expect(memoryVerdicts()[0]!.verdict.verdict).toBe("insufficient_evidence");
  });

  it("when the rule agrees on the label it still replaces the model's text with the static headline and says so", async () => {
    const { evs } = await runTurn(await turn(googleAlertRaw(), triaged("suspicious")));
    const row = memoryVerdicts()[0]!.verdict;
    expect(row.verdict).toBe("suspicious");
    expect(row.headline).not.toBe("Model headline");
    expect(evs.filter((e) => e.type === "verdict_override")).toHaveLength(1);
  });

  it("streams a verdict_override (after the model's own text, before the note) that matches the stored text and row", async () => {
    const { evs, stored } = await runTurn(await turn(googleAlertRaw(), triaged("likely_safe")));
    const idx = evs.findIndex((e) => e.type === "verdict_override");
    expect(idx).toBeGreaterThanOrEqual(0);
    const override = evs[idx] as Extract<(typeof evs)[number], { type: "verdict_override" }>;
    expect(evs[idx + 1]).toMatchObject({ type: "text_delta" });
    expect(override.verdict.signin_check).toBeUndefined();
    expect(override.verdict.verdict).toBe("suspicious");
    const text = (stored!.messages.at(-1)!.content as { text: string }[])[0]!.text;
    expect(extractVerdict([{ role: "assistant", content: text }])).toEqual(override.verdict);
    const { signin_check: _c, ...row } = memoryVerdicts()[0]!.verdict;
    expect(row).toEqual(override.verdict);
  });

  it("sends no override for a message that is not a sign-in alert", async () => {
    const plain = "From: A <a@example.org>\nTo: b@example.com\nSubject: Hi\n\nLunch on Friday?\n";
    const { evs } = await runTurn(await turn(plain, triaged("likely_safe")));
    expect(evs.some((e) => e.type === "verdict_override")).toBe(false);
  });

  it("strips a model-written signin_check even when analyze_email never ran: no check stored, no question, answer is no_check", async () => {
    const forged = triaged("likely_safe", { signin_check: { provider: "google", event: "new_signin", device_label: "Windows", first_seen: true } });
    const msgs: MessageParam[] = [{ role: "assistant", content: [{ type: "text", text: fence(forged) }] }];
    const { evs, stored } = await runTurn(msgs);
    const row = memoryVerdicts()[0]!;
    expect(row.verdict.signin_check).toBeUndefined();
    expect(row.verdict.verdict).toBe("likely_safe");
    const text = (stored!.messages.at(-1)!.content as { text: string }[])[0]!.text;
    expect(text).not.toContain("signin_check");
    expect(evs.some((e) => e.type === "verdict_override")).toBe(false);
    expect(await answerSigninCheck(session, row.id, "yes")).toEqual({ status: "no_check" });
  });

  it("a model-claimed signin_alert subject without any alert analysis is capped, with a static headline", async () => {
    const claimed = triaged("likely_safe", { subject_type: "signin_alert", headline: "Windows in Seattle, 203.0.113.24" });
    await runTurn([{ role: "assistant", content: [{ type: "text", text: fence(claimed) }] }]);
    const v = memoryVerdicts()[0]!.verdict;
    expect(v).toMatchObject({ verdict: "suspicious", subject_type: "signin_alert" });
    expect(v.headline).not.toContain("Seattle");
  });

  describe("several emails analyzed in one turn", () => {
    const plain = (subject: string) => `From: Pat <pat@example.org>\nTo: b@example.com\nSubject: ${subject}\n\nLunch on Friday at the long-table cafe?\n`;
    async function multi(raws: string[], modelVerdict: Verdict): Promise<MessageParam[]> {
      const out: MessageParam[] = [];
      for (const [i, raw] of raws.entries()) {
        const analysis = await analyzeRaw(raw);
        out.push({ role: "assistant", content: [{ type: "tool_use", id: `tu_${i}`, name: "analyze_email", input: { raw: "x" } }] });
        out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: wrapToolResult("analyze_email", analysis) }] });
      }
      out.push({ role: "assistant", content: [{ type: "text", text: fence(modelVerdict) }] });
      return out;
    }

    it("two sign-in alerts: capped at suspicious, no signin_check, no event, no 'was this you'", async () => {
      const { evs } = await runTurn(await multi([googleAlertRaw(), googleAlertRaw({ subject: "Security alert" })], triaged("likely_safe")));
      const v = memoryVerdicts()[0]!.verdict;
      expect(v).toMatchObject({ verdict: "suspicious", subject_type: "signin_alert" });
      expect(v.signin_check).toBeUndefined();
      expect(memoryState().signinEvents).toEqual([]);
      expect(evs.filter((e) => e.type === "verdict_override")).toHaveLength(1);
    });

    it("two sign-in alerts never soften a malicious verdict", async () => {
      await runTurn(await multi([googleAlertRaw(), googleAlertRaw()], triaged("malicious")));
      expect(memoryVerdicts()[0]!.verdict.verdict).toBe("malicious");
      expect(memoryVerdicts()[0]!.verdict.signin_check).toBeUndefined();
    });

    it("an alert and an unrelated email: a verdict that quotes the alert gets the alert's override", async () => {
      const v = triaged("likely_safe", { headline: "The Security alert from no-reply@accounts.google.com looks fine" });
      await runTurn(await multi([plain("Lunch plans friday"), googleAlertRaw()], v));
      const row = memoryVerdicts()[0]!.verdict;
      expect(row.verdict).toBe("suspicious"); // unverified template: never likely_safe
      expect(row.signin_check).toMatchObject({ provider: "google" });
    });

    it("an alert and an unrelated email: a verdict that quotes the other email is left alone", async () => {
      const v = triaged("likely_safe", { headline: "Lunch plans friday from pat@example.org is ordinary" });
      const { evs } = await runTurn(await multi([plain("Lunch plans friday"), googleAlertRaw()], v));
      const row = memoryVerdicts()[0]!.verdict;
      expect(row.verdict).toBe("likely_safe");
      expect(row.signin_check).toBeUndefined();
      expect(evs.some((e) => e.type === "verdict_override")).toBe(false);
    });

    it("an alert and an unrelated email with a verdict that quotes neither is ambiguous: capped, no check", async () => {
      await runTurn(await multi([plain("Lunch plans friday"), googleAlertRaw()], triaged("likely_safe")));
      const row = memoryVerdicts()[0]!.verdict;
      expect(row.verdict).toBe("suspicious");
      expect(row.signin_check).toBeUndefined();
    });
  });

  it("ignores non-alert mail and strips a forged signin_check", async () => {
    const plain = "From: A <a@example.org>\nTo: b@example.com\nSubject: Hi\n\nLunch on Friday?\n";
    const forged = triaged("likely_safe", { signin_check: { provider: "google", event: "new_signin", device_label: "x", first_seen: true } });
    const { evs } = await runTurn(await turn(plain, forged));
    expect(memoryVerdicts()[0]!.verdict.verdict).toBe("likely_safe");
    expect(memoryVerdicts()[0]!.verdict.signin_check).toBeUndefined();
    expect(textOf(evs)).not.toContain("deterministic");
    expect(memoryState().signinEvents).toEqual([]);
  });

  it("falls back to the copy captured at tool execution when the stored tool result was truncated", async () => {
    const truncated = await turn(googleAlertRaw(), triaged("likely_safe"), { truncated: true });
    // Without the tool having run in this turn there is no analysis: the model verdict stands.
    await runTurn(truncated);
    expect(memoryVerdicts()[0]!.verdict.verdict).toBe("likely_safe");
    resetMemoryState();
    // With the registry's analyze_email executed during the turn, the hook still gets the analysis.
    await runTurn(truncated, (common) =>
      common.tools.get("analyze_email")!.execute({ raw: googleAlertRaw() }, { tenantId: session.tenantId, userId: session.userId, conversationId: "c" }),
    );
    expect(memoryVerdicts()[0]!.verdict).toMatchObject({ verdict: "suspicious", subject_type: "signin_alert" });
  });
});

describe("rewriteFinalVerdict fence handling", () => {
  const withFence = (v: Verdict, f: string) => `${f}verdict\n${JSON.stringify(v, null, 2)}\n${f}`;
  it("rewrites the block extractVerdict reads, never a decoy inside ~~~ or a nested code block", () => {
    const decoy = `~~~\n${withFence(triaged("likely_safe", { headline: "Decoy" }), "```")}\n~~~`;
    const text = `${withFence(triaged("likely_safe", { headline: "Real" }), "````")}\n\n${decoy}\n\n\`\`\`md\n${withFence(triaged("likely_safe", { headline: "Decoy2" }), "~~~")}\n\`\`\``;
    const msgs: MessageParam[] = [{ role: "assistant", content: [{ type: "text", text }] }];
    const final = triaged("suspicious", { headline: "Rule" });
    const out = rewriteFinalVerdict(msgs, final, "Note.");
    const newText = (out[0]!.content as { text: string }[])[0]!.text;
    expect(extractVerdict(out)).toEqual(final);
    expect(newText).toContain("Decoy");
    expect(newText).toContain("Decoy2");
    expect(newText).not.toContain('"headline": "Real"');
  });

  it("strips signin_check from the text and leaves messages without a verdict untouched", () => {
    const msgs: MessageParam[] = [{ role: "assistant", content: "no verdict" }];
    expect(rewriteFinalVerdict(msgs, triaged("suspicious"), "n")).toEqual(msgs);
    const out = rewriteFinalVerdict([{ role: "assistant", content: fence(triaged("likely_safe")) }], triaged("suspicious", { signin_check: { provider: "google", event: "new_signin", device_label: "x", first_seen: true } }), "n");
    expect(JSON.stringify(out)).not.toContain("signin_check");
  });
});
