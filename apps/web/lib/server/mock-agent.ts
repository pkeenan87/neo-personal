/**
 * ─── STUB: DELETE IN INTEGRATION PASS ────────────────────────────────
 * Scripted AgentEvent sequences used by the /api/agent and
 * /api/agent/confirm stubs when MOCK_MODE=true. The integration pass
 * replaces their callers with runAgentLoop / resumeAfterConfirmation from
 * @neo/core (whose own mock mode takes over) and deletes this file.
 * ─────────────────────────────────────────────────────────────────────
 */
import { encodeEvent, type AgentEvent } from "@/types/agent-event";
import type { Verdict } from "@/types/verdict";
import type { StoredMessage } from "@/lib/chat-state";

export const MOCK_DEFAULT_URL = "http://paypa1-account-verify.example/login";
export const CONFIRM_TEST_TRIGGER = "confirm-test";

/** Shape-compatible with UrlAnalysis in docs/contracts.md (@neo/tools). */
export function mockUrlAnalysis(url: string) {
  let host = "paypa1-account-verify.example";
  try {
    host = new URL(url).hostname;
  } catch {
    // keep default
  }
  return {
    normalized_url: url,
    final_url: url,
    redirect_chain: [url],
    domain: { registrable: host, age_days: 3, registrar: "Example Registrar, Inc.", created: "2026-09-21" },
    reputation: {
      safe_browsing: { matched: true, threat_types: ["SOCIAL_ENGINEERING"] },
      virustotal: { malicious: 7, suspicious: 2, harmless: 58 },
      urlscan: { skipped: "no_api_key" },
    },
    tls: { valid: true, issuer: "Let's Encrypt", days_valid: 90 },
    lookalike: { brand: "PayPal", technique: "homoglyph (1 → l)" },
    heuristics: ["login_form_on_non_brand_domain", "newly_registered_domain"],
    errors: [],
  };
}

export function mockVerdict(url: string): Verdict {
  const a = mockUrlAnalysis(url);
  return {
    subject_type: "url",
    verdict: "malicious",
    confidence: 0.94,
    headline: "This link imitates PayPal to steal your login. Don't open it or enter any details.",
    indicators: [
      {
        severity: "critical",
        category: "Known phishing",
        evidence: "Google Safe Browsing: SOCIAL_ENGINEERING",
        explanation: "Google has already flagged this address as a phishing page.",
      },
      {
        severity: "high",
        category: "Lookalike domain",
        evidence: a.domain.registrable,
        explanation: "The domain swaps the letter “l” for the number “1” to look like paypal.",
      },
      {
        severity: "medium",
        category: "New domain",
        evidence: "Registered 3 days ago",
        explanation: "Scam sites are usually brand new; real banks and payment sites are not.",
      },
    ],
    recommended_actions: [
      { action: "Don't open the link or reply to the message.", urgency: "now" },
      {
        action: "If you entered your password, change it now from the real PayPal site.",
        urgency: "now",
        deep_link: "https://www.paypal.com/myaccount/security",
      },
      { action: "Report the message as phishing, then delete it.", urgency: "soon" },
    ],
    iocs: { urls: [url], domains: [a.domain.registrable], ips: [], hashes: [], phone_numbers: [] },
  };
}

function firstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"')\]]+/i.exec(text);
  return m ? m[0] : null;
}

/** Split text into small chunks so the UI visibly streams. */
export function chunkText(text: string, size = 12): string[] {
  const out: string[] = [];
  let buf = "";
  for (const token of text.split(/(\s+)/)) {
    buf += token;
    if (buf.length >= size) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

const deltas = (text: string): AgentEvent[] => chunkText(text).map((t) => ({ type: "text_delta", text: t }));

export interface MockTurn {
  events: AgentEvent[];
  /** Final assistant text, persisted to the conversation store. */
  assistantText: string;
  toolUses: Array<{ id: string; name: string; input: unknown; result: unknown }>;
  pendingConfirmation?: { id: string; name: string; input: unknown; description: string };
}

export function scriptMockTurn(message: string): MockTurn {
  const url = firstUrl(message) ?? MOCK_DEFAULT_URL;

  if (message.toLowerCase().includes(CONFIRM_TEST_TRIGGER)) {
    const intro = `I can report \`${url}\` to Google Safe Browsing so other people get warned too. I need your OK first.`;
    const pending = {
      id: "toolu_mock_confirm_1",
      name: "report_phish",
      input: { url, provider: "google_safe_browsing" },
      description: `Report ${url} to Google Safe Browsing as phishing.`,
    };
    return {
      assistantText: intro,
      toolUses: [],
      pendingConfirmation: pending,
      events: [
        { type: "thinking", text: "The user wants to report this URL. Reporting is an action, so I must ask first." },
        ...deltas(intro),
        { type: "confirmation_required", ...pending },
        { type: "usage", input_tokens: 812, output_tokens: 64 },
        { type: "done", stop_reason: "confirmation_required" },
      ],
    };
  }

  const toolId = "toolu_mock_check_url_1";
  const analysis = mockUrlAnalysis(url);
  const verdict = mockVerdict(url);
  const before = "Let me check that link for you.";
  const after =
    "**Don't open this link.** It's a fake PayPal login page built to steal your password.\n\n" +
    "```verdict\n" +
    JSON.stringify(verdict, null, 2) +
    "\n```\n\n" +
    "If you already entered your password, change it on the real site right away and turn on two-step verification.";
  return {
    assistantText: `${before}\n\n${after}`,
    toolUses: [{ id: toolId, name: "check_url", input: { url }, result: analysis }],
    events: [
      { type: "thinking", text: "The user is asking whether a URL is safe. I'll run check_url and reason over the result." },
      ...deltas(before),
      { type: "tool_start", id: toolId, name: "check_url", input: { url } },
      { type: "tool_result", id: toolId, name: "check_url", result: analysis },
      ...deltas("\n\n" + after),
      { type: "usage", input_tokens: 1843, output_tokens: 412, cache_read_input_tokens: 1200 },
      { type: "done", stop_reason: "end_turn" },
    ],
  };
}

export function scriptMockConfirmation(approved: boolean, pending: { id: string; name: string; input: unknown }): MockTurn {
  const text = approved
    ? "Done. I reported it. Thanks for helping protect other people."
    : "Okay, I won't report it. Let me know if you change your mind.";
  const result = approved ? { reported: true, reference: "mock-report-0001" } : { skipped: "declined_by_user" };
  const events: AgentEvent[] = [];
  if (approved) {
    events.push({ type: "tool_start", id: pending.id, name: pending.name, input: pending.input });
    events.push({ type: "tool_result", id: pending.id, name: pending.name, result });
  }
  events.push(...deltas(text), { type: "usage", input_tokens: 420, output_tokens: 30 }, { type: "done", stop_reason: "end_turn" });
  return { events, assistantText: text, toolUses: approved ? [{ ...pending, result }] : [] };
}

/**
 * Stream AgentEvents as NDJSON with a per-event delay. Stops early when
 * `signal` aborts (client pressed Stop / navigated away).
 */
export function streamMockEvents(
  events: AgentEvent[],
  opts: { delayMs: number; signal?: AbortSignal; onComplete?: (aborted: boolean) => void | Promise<void> },
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false;
      try {
        for (const e of events) {
          if (opts.signal?.aborted) {
            aborted = true;
            break;
          }
          controller.enqueue(enc.encode(encodeEvent(e)));
          if (opts.delayMs > 0) await sleep(opts.delayMs);
        }
      } finally {
        await opts.onComplete?.(aborted);
        try {
          controller.close();
        } catch {
          // already closed by a cancelled reader
        }
      }
    },
  });
}

/** Persisted form of a mock turn (Anthropic MessageParam shape). */
export function mockTurnMessages(userText: string | null, turn: MockTurn): StoredMessage[] {
  const out: StoredMessage[] = [];
  if (userText !== null) out.push({ role: "user", content: userText });
  if (turn.toolUses.length) {
    out.push({
      role: "assistant",
      content: turn.toolUses.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
    });
    out.push({
      role: "user",
      content: turn.toolUses.map((t) => ({ type: "tool_result", tool_use_id: t.id, content: JSON.stringify(t.result) })),
    });
  }
  out.push({ role: "assistant", content: turn.assistantText });
  return out;
}
