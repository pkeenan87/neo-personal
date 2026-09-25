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
 *   - an [Attached file …] note    → tool_use analyze_email { artifact_ref } per file
 *   - an image block (screenshot)  → a scripted transcription + tool_use analyze_sms
 *                                    with a fixed input
 *   - analyze_email / analyze_sms
 *     tool_result(s)               → explanation + one ```verdict block built
 *                                    from the actual result
 *   - anything else                → a canned demo-mode answer
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { RegisteredTool } from "@neo/core";
import { extractUrlIocs, isSkipped, MOCK_URLS, type UrlAnalysis } from "@neo/tools";
import type { Verdict } from "@neo/verdict";
import { parseAttachmentNote } from "@/lib/attachments";

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

// ── Intake (analyze_email / analyze_sms) ──

export const ANALYZE_EMAIL_TOOL = "analyze_email";
export const ANALYZE_SMS_TOOL = "analyze_sms";

/** The fixed "transcription" the scripted model makes of any screenshot. */
export const MOCK_SMS_INPUT = {
  sender: "+1 555 0100",
  body: `PayPal: your account has been limited. Verify your details at ${MOCK_URLS.phish} within 24 hours or it will be closed.`,
} as const;

/** The fields of an EmailAnalysis / SmsAnalysis the scripted model reasons over (docs/contracts.md). */
export interface MessageAnalysisLike {
  heuristics?: unknown;
  signals?: unknown;
  content?: { signals?: unknown };
  urls?: unknown;
  phone_numbers?: unknown;
  errors?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const STRONG_MESSAGE_CODES = new Set([
  "lookalike_sender_domain",
  "spoofed_brand_in_display_name",
  "free_mail_sender_claiming_brand",
  "brand_claim_from_personal_number",
  "brand_claim_from_international_number",
  "link_domain_not_brand",
  "dangerous_attachment_type",
  "attachment_vt_flagged",
]);

/** A plausible verdict from an analyze_email / analyze_sms result. Null when the analysis could not run. */
export function mockMessageVerdict(kind: "email" | "sms", a: MessageAnalysisLike): Verdict | null {
  const errors = strings(a.errors);
  if (errors.includes("artifact_not_found")) return null;
  const codes = [...new Set([...strings(a.heuristics), ...strings(a.signals), ...strings(a.content?.signals)])];
  const urlAnalyses = (Array.isArray(a.urls) ? a.urls : [])
    .map((u) => (u && typeof u === "object" ? (u as { analysis?: unknown }).analysis : undefined))
    .filter(isAnalysis);
  const urlVerdicts = urlAnalyses.map(mockVerdictFor);

  const indicators: Verdict["indicators"] = [
    ...codes.map((c) => ({
      severity: (STRONG_MESSAGE_CODES.has(c) ? "high" : "medium") as Verdict["indicators"][number]["severity"],
      category: c,
      evidence: c.replace(/_/g, " "),
      explanation: STRONG_MESSAGE_CODES.has(c) ? "A strong sign the message is impersonating someone." : "A common trait of scam messages.",
    })),
    ...urlVerdicts.flatMap((v) => v.indicators),
  ].slice(0, 12);

  const strong = codes.some((c) => STRONG_MESSAGE_CODES.has(c)) || urlVerdicts.some((v) => v.verdict === "malicious");
  const noun = kind === "email" ? "email" : "text message";
  let verdict: Verdict["verdict"];
  let confidence: number;
  let headline: string;
  if (strong) {
    verdict = "malicious";
    confidence = 0.93;
    headline = `This ${noun} is a phishing attempt. Don't click its link or reply.`;
  } else if (codes.length >= 2 || urlVerdicts.some((v) => v.verdict === "suspicious")) {
    verdict = "suspicious";
    confidence = 0.7;
    headline = `This ${noun} has several warning signs. Don't act on it until you confirm it another way.`;
  } else if (codes.length === 0 && urlVerdicts.length > 0 && urlVerdicts.every((v) => v.verdict === "likely_safe")) {
    verdict = "likely_safe";
    confidence = 0.8;
    headline = `This ${noun} looks legitimate.`;
  } else {
    verdict = "insufficient_evidence";
    confidence = 0.4;
    headline = `There isn't enough evidence to say whether this ${noun} is safe.`;
  }

  const iocs: Verdict["iocs"] = { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] };
  for (const v of urlVerdicts) {
    for (const k of Object.keys(iocs) as Array<keyof Verdict["iocs"]>) iocs[k] = [...new Set([...iocs[k], ...v.iocs[k]])];
  }
  iocs.phone_numbers = [...new Set([...iocs.phone_numbers, ...strings(a.phone_numbers)])];

  const recommended_actions: Verdict["recommended_actions"] =
    verdict === "malicious" || verdict === "suspicious"
      ? [
          { action: "Don't click the link, call any number in it, or reply.", urgency: "now" },
          { action: "If you entered a password, change it on the real website and turn on two-step verification.", urgency: "now" },
          { action: kind === "email" ? "Report it as phishing in your email app, then delete it." : "Report it as junk and block the sender.", urgency: "soon" },
        ]
      : [{ action: "If anything asks for a password or payment, go to the company's site or app directly instead.", urgency: "optional" }];

  return { subject_type: kind, verdict, confidence, headline, indicators, recommended_actions, iocs };
}

function messageVerdictAnswer(items: Array<{ kind: "email" | "sms"; data: MessageAnalysisLike }>): string {
  const rank = { malicious: 3, suspicious: 2, insufficient_evidence: 1, likely_safe: 0 } as const;
  const verdicts = items
    .map((i) => mockMessageVerdict(i.kind, i.data))
    .filter((v): v is Verdict => v !== null)
    .sort((x, y) => rank[y.verdict] - rank[x.verdict]);
  const v = verdicts[0];
  if (!v) {
    return "I couldn't open that file: it may have expired or been removed. Please attach it again.\n\n_(Demo mode: this answer is scripted.)_";
  }
  const lead =
    v.verdict === "malicious" ? "**This is a scam.**" : v.verdict === "suspicious" ? "**Be careful with this one.**" : v.verdict === "likely_safe" ? "**This looks legitimate.**" : "**I can't tell for sure.**";
  const found = v.indicators.length ? `Here's what I found:\n\n${v.indicators.map((i) => `- ${i.evidence}: ${i.explanation}`).join("\n")}` : "Nothing stood out as a warning sign.";
  const block = "```verdict\n" + JSON.stringify(v, null, 2) + "\n```";
  return `${lead} ${v.headline}\n\n${found}\n\n${block}\n\n_(Demo mode: this answer is scripted; the checks ran in mock mode.)_`;
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
    const messageAnalyses: Array<{ kind: "email" | "sms"; data: MessageAnalysisLike }> = [];
    let reportOutcome: "approved" | "declined" | undefined;
    for (const r of results) {
      const name = names.get(String(r.tool_use_id));
      const data = unwrap(r.content);
      if ((name === ANALYZE_EMAIL_TOOL || name === ANALYZE_SMS_TOOL) && data && typeof data === "object") {
        messageAnalyses.push({ kind: name === ANALYZE_EMAIL_TOOL ? "email" : "sms", data: data as MessageAnalysisLike });
      } else if (name === MOCK_REPORT_TOOL) {
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
    if (messageAnalyses.length > 0) {
      return { content: [{ type: "text", text: messageVerdictAnswer(messageAnalyses), citations: null }], stop_reason: "end_turn" };
    }
    const text = analyses.length
      ? verdictAnswer(analyses)
      : "I couldn't analyze that link: the check failed. Please try again in a moment.";
    return { content: [{ type: "text", text, citations: null }], stop_reason: "end_turn" };
  }

  // Intake: attached files → analyze_email; screenshots → transcription + analyze_sms.
  const lastBlocks = blocksOf(last);
  const files = lastBlocks
    .map((b) => (b.type === "text" && typeof b.text === "string" ? parseAttachmentNote(b.text) : null))
    .filter((r) => r !== null && r.kind !== "image");
  const hasImage = lastBlocks.some((b) => b.type === "image");
  if (files.length > 0 || hasImage) {
    const content: Block[] = [
      { type: "thinking", thinking: "The user attached evidence. I'll analyze it with the message tools before judging.", signature: "mock" },
    ];
    if (hasImage) {
      content.push({
        type: "text",
        text:
          `Here's what I can see in the screenshot: a text message from **${MOCK_SMS_INPUT.sender}** that reads ` +
          `"${MOCK_SMS_INPUT.body}". Let me check it.`,
        citations: null,
      });
      content.push({ type: "tool_use", id: toolId(), name: ANALYZE_SMS_TOOL, input: MOCK_SMS_INPUT });
    }
    if (files.length > 0) {
      content.push({ type: "text", text: files.length === 1 ? "Let me analyze that email." : "Let me analyze those emails.", citations: null });
      for (const f of files) content.push({ type: "tool_use", id: toolId(), name: ANALYZE_EMAIL_TOOL, input: { artifact_ref: f!.id } });
    }
    return { stop_reason: "tool_use", content };
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
