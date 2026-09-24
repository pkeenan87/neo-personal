/**
 * MOCK_MODE model: a scripted, offline stand-in for the Anthropic client,
 * passed to runAgentLoop / resumeAfterConfirmation as `client`. The REAL agent
 * loop, tool registry, trust-boundary wrapping, check_url (in @neo/tools mock
 * mode), persistence and usage recording all run; only the model is scripted.
 * No API key and no network are needed.
 *
 * Script (decided from the request's messages):
 *   - user text with URLs          → tool_use check_url for each (up to 3)
 *   - check_url tool_result(s)     → explanation + one ```verdict block built
 *                                    from the actual UrlAnalysis
 *   - user text with "confirm-test"→ tool_use report_phish_demo (destructive,
 *                                    registered only in MOCK_MODE) to exercise
 *                                    the confirmation gate
 *   - report_phish_demo result     → short acknowledgement
 *   - anything else                → a canned demo-mode answer
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { RegisteredTool } from "@neo/core";
import { extractUrlIocs, isSkipped, MOCK_URLS, type UrlAnalysis } from "@neo/tools";
import type { Verdict } from "@neo/verdict";

export const CONFIRM_TEST_TRIGGER = "confirm-test";
export const MOCK_REPORT_TOOL = "report_phish_demo";
const MOCK_MODEL_ID = "neo-mock-model";

/** Destructive demo tool (MOCK_MODE only) so the confirmation flow can be exercised end to end. */
export const mockReportPhishTool: RegisteredTool = {
  definition: {
    name: MOCK_REPORT_TOOL,
    description: "Report a URL to Google Safe Browsing as phishing (demo only: nothing is sent).",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to report." } },
      required: ["url"],
      additionalProperties: false,
    },
    destructive: true,
  },
  execute: async () => ({ reported: true, reference: "mock-report-0001", note: "MOCK_MODE: nothing was sent." }),
};

type Block = Record<string, unknown> & { type: string };
interface ScriptedResponse {
  content: Block[];
  stop_reason: "end_turn" | "tool_use";
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

function blocksOf(m: MessageParam | undefined): Block[] {
  if (!m) return [];
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as Block[]);
}

function textOf(m: MessageParam | undefined): string {
  return blocksOf(m)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function toolId(): string {
  return `toolu_mock_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Unwrap a `_neo_trust_boundary` envelope (tool_result content) to its data. */
function unwrap(content: unknown): unknown {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((b: { text?: unknown }) => (typeof b.text === "string" ? b.text : "")).join("")
        : "";
  try {
    const parsed = JSON.parse(text) as { data?: unknown };
    return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
  } catch {
    return undefined;
  }
}

function isAnalysis(v: unknown): v is UrlAnalysis {
  return typeof v === "object" && v !== null && typeof (v as UrlAnalysis).normalized_url === "string";
}

/** A plausible verdict from a real UrlAnalysis (what a careful model would conclude). */
export function mockVerdictFor(a: UrlAnalysis): Verdict {
  const indicators: Verdict["indicators"] = [];
  const sb = a.reputation.safe_browsing;
  const sbFlagged = Boolean(sb && !isSkipped(sb) && sb.flagged);
  const vt = a.reputation.virustotal;
  const vtMalicious = vt && !isSkipped(vt) && vt.status === "found" ? vt.malicious : 0;
  const domain = a.final_domain ?? a.domain;
  const page = a.page && !isSkipped(a.page) ? a.page : undefined;

  if (sbFlagged) {
    indicators.push({
      severity: "critical",
      category: "known_phishing",
      evidence: "Google Safe Browsing lists this address",
      explanation: "Google has already flagged this link as dangerous.",
    });
  }
  if (vtMalicious > 0) {
    indicators.push({
      severity: vtMalicious >= 2 ? "high" : "medium",
      category: "reputation",
      evidence: `${vtMalicious} VirusTotal engine${vtMalicious === 1 ? "" : "s"} flag this URL`,
      explanation: "Independent security vendors consider this link malicious.",
    });
  }
  if (a.lookalike) {
    indicators.push({
      severity: "high",
      category: "lookalike_domain",
      evidence: `${a.domain.registrable} imitates ${a.lookalike.brand_domain} (${a.lookalike.technique})`,
      explanation: `The address is made to look like ${a.lookalike.brand}, but it is a different website.`,
    });
  }
  if (typeof domain.age_days === "number" && domain.age_days < 30) {
    indicators.push({
      severity: "medium",
      category: "young_domain",
      evidence: `${domain.registrable} was registered ${domain.age_days} day${domain.age_days === 1 ? "" : "s"} ago`,
      explanation: "Scam sites are usually brand new; real banks and shops are not.",
    });
  }
  if (page?.has_password_field) {
    indicators.push({
      severity: "medium",
      category: "credential_form",
      evidence: "The page asks for a password",
      explanation: "A password form on an unfamiliar site is how credentials get stolen.",
    });
  }
  const ssrf = a.heuristics.includes("ssrf_refused");
  if (ssrf) {
    indicators.push({
      severity: "high",
      category: "private_network_address",
      evidence: `${a.domain.host} is a private or internal network address`,
      explanation: "This is not a normal public website; links like this are used to reach devices on your own network.",
    });
  }
  const covered = new Set(["safe_browsing_match", "virustotal_malicious", "brand_lookalike", "young_domain", "very_young_domain", "password_field", "ssrf_refused"]);
  for (const h of a.heuristics) {
    if (covered.has(h)) continue;
    indicators.push({ severity: "low", category: h, evidence: h.replace(/_/g, " "), explanation: "A common trait of scam links." });
  }

  const strong = sbFlagged || vtMalicious >= 2 || (a.lookalike != null && (page?.has_password_field ?? false));
  let verdict: Verdict["verdict"];
  let confidence: number;
  let headline: string;
  if (strong) {
    verdict = "malicious";
    confidence = 0.95;
    headline = a.lookalike
      ? `This link imitates ${a.lookalike.brand} to steal your login. Don't open it or enter any details.`
      : "This link is known to be dangerous. Don't open it.";
  } else if (ssrf || a.heuristics.length >= 2 || a.lookalike) {
    verdict = "suspicious";
    confidence = 0.7;
    headline = "This link has several warning signs. Don't open it unless you can confirm it with the sender.";
  } else if ((domain.age_days ?? 0) > 365 && a.heuristics.length === 0) {
    verdict = "likely_safe";
    confidence = 0.85;
    headline = `This link goes to ${domain.registrable}, an established site with a clean reputation.`;
  } else {
    verdict = "insufficient_evidence";
    confidence = 0.4;
    headline = "There isn't enough evidence to say whether this link is safe.";
  }

  const recommended_actions: Verdict["recommended_actions"] =
    verdict === "malicious" || verdict === "suspicious"
      ? [
          { action: "Don't open the link or reply to the message.", urgency: "now" },
          { action: "If you entered a password, change it on the real website and turn on two-step verification.", urgency: "now" },
          { action: "Report the message as phishing, then delete it.", urgency: "soon" },
        ]
      : verdict === "likely_safe"
        ? [{ action: "It's fine to open, but still never enter a password on a page you reached from a message.", urgency: "optional" }]
        : [{ action: "Don't enter any details on this site until you have confirmed it with the sender another way.", urgency: "soon" }];

  return { subject_type: "url", verdict, confidence, headline, indicators, recommended_actions, iocs: extractUrlIocs(a) };
}

function verdictAnswer(analyses: UrlAnalysis[]): string {
  const rank = { malicious: 3, suspicious: 2, insufficient_evidence: 1, likely_safe: 0 } as const;
  const verdicts = analyses.map(mockVerdictFor).sort((x, y) => rank[y.verdict] - rank[x.verdict]);
  const v = verdicts[0]!;
  const lead =
    v.verdict === "malicious"
      ? "**Don't open this link.**"
      : v.verdict === "suspicious"
        ? "**Be careful with this link.**"
        : v.verdict === "likely_safe"
          ? "**This link looks legitimate.**"
          : "**I can't tell for sure whether this link is safe.**";
  const found = v.indicators.length
    ? `Here's what I found:\n\n${v.indicators.map((i) => `- ${i.evidence}: ${i.explanation}`).join("\n")}`
    : "The reputation checks came back clean and nothing imitates a well-known brand.";
  const block = "```verdict\n" + JSON.stringify(v, null, 2) + "\n```";
  return `${lead} ${v.headline}\n\n${found}\n\n${block}\n\n_(Demo mode: this answer is scripted; the link checks ran in mock mode.)_`;
}

/** Decide the scripted response from the request messages. */
export function scriptResponse(messages: readonly MessageParam[]): ScriptedResponse {
  const last = messages[messages.length - 1];
  const results = blocksOf(last).filter((b) => b.type === "tool_result");

  if (results.length > 0) {
    const prevAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const names = new Map<string, string>();
    for (const b of blocksOf(prevAssistant)) if (b.type === "tool_use") names.set(String(b.id), String(b.name));
    const analyses: UrlAnalysis[] = [];
    let reportOutcome: "approved" | "declined" | undefined;
    for (const r of results) {
      const name = names.get(String(r.tool_use_id));
      const data = unwrap(r.content);
      if (name === MOCK_REPORT_TOOL) {
        reportOutcome = data && typeof data === "object" && "cancelled" in data ? "declined" : "approved";
      } else if (isAnalysis(data)) {
        analyses.push(data);
      }
    }
    if (reportOutcome) {
      const text =
        reportOutcome === "approved"
          ? "Done. I reported it (demo mode: nothing was actually sent). Thanks for helping protect other people."
          : "Okay, I won't report it. Let me know if you change your mind.";
      return { content: [{ type: "text", text, citations: null }], stop_reason: "end_turn" };
    }
    const text = analyses.length
      ? verdictAnswer(analyses)
      : "I couldn't analyze that link: the check failed. Please try again in a moment.";
    return { content: [{ type: "text", text, citations: null }], stop_reason: "end_turn" };
  }

  const userText = textOf(last);
  const urls = [...new Set(userText.match(URL_RE) ?? [])].slice(0, 3);

  if (userText.toLowerCase().includes(CONFIRM_TEST_TRIGGER)) {
    const url = urls[0] ?? MOCK_URLS.phish;
    return {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "The user wants to report this URL. Reporting is an action, so I must ask first.", signature: "mock" },
        { type: "text", text: `I can report \`${url}\` to Google Safe Browsing so other people get warned too. I need your OK first.`, citations: null },
        { type: "tool_use", id: toolId(), name: MOCK_REPORT_TOOL, input: { url } },
      ],
    };
  }

  if (urls.length > 0) {
    return {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "The user is asking whether a link is safe. I'll run check_url and reason over the result.", signature: "mock" },
        { type: "text", text: urls.length === 1 ? "Let me check that link for you." : "Let me check those links for you.", citations: null },
        ...urls.map((url) => ({ type: "tool_use", id: toolId(), name: "check_url", input: { url } })),
      ],
    };
  }

  return {
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text:
          "Neo is running in demo mode (MOCK_MODE), so answers are scripted and no AI model is called. " +
          `Paste a link to see a full check, for example ${MOCK_URLS.phish} or ${MOCK_URLS.clean}.`,
        citations: null,
      },
    ],
  };
}

function chunk(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

const estimate = (v: unknown) => Math.max(1, Math.ceil(JSON.stringify(v).length / 4));

export interface MockClientOptions {
  /** Delay between stream events (ms), so the UI visibly streams. */
  delayMs?: number;
}

/** A fake Anthropic client implementing the subset @neo/core uses (stream, beta stream, create). */
export function createMockAnthropicClient(opts: MockClientOptions = {}): Anthropic {
  const delayMs = opts.delayMs ?? 0;

  function stream(params: { messages: MessageParam[] }, options?: { signal?: AbortSignal }) {
    const signal = options?.signal;
    const scripted = scriptResponse(params.messages);
    const message = {
      id: `msg_mock_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      type: "message",
      role: "assistant",
      model: MOCK_MODEL_ID,
      content: scripted.content,
      stop_reason: scripted.stop_reason,
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: estimate(params.messages),
        output_tokens: estimate(scripted.content),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };

    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { ...message, content: [] } };
        for (let i = 0; i < scripted.content.length; i++) {
          const block = scripted.content[i]!;
          if (signal?.aborted) return;
          if (block.type === "text") {
            yield { type: "content_block_start", index: i, content_block: { type: "text", text: "" } };
            for (const piece of chunk(String(block.text))) {
              if (signal?.aborted) return; // the SDK iterator ends silently on abort
              yield { type: "content_block_delta", index: i, delta: { type: "text_delta", text: piece } };
              await sleep(delayMs, signal);
            }
          } else if (block.type === "thinking") {
            yield { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } };
            yield { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: block.thinking } };
            await sleep(delayMs, signal);
          } else {
            yield { type: "content_block_start", index: i, content_block: block };
          }
          yield { type: "content_block_stop", index: i };
        }
        yield { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage };
        yield { type: "message_stop" };
      },
      async finalMessage() {
        return message;
      },
    };
  }

  const client = {
    messages: {
      stream,
      // Conversation compression (prepareMessages) uses messages.create.
      create: async () => ({
        id: "msg_mock_summary",
        type: "message",
        role: "assistant",
        model: MOCK_MODEL_ID,
        content: [{ type: "text", text: "Summary of the earlier conversation (demo mode).", citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    },
    beta: { messages: { stream } },
  };
  return client as unknown as Anthropic;
}
