import type { AgentEvent } from "@neo/core";
import type { Verdict } from "@neo/verdict";

export const VERDICT_FIXTURE: Verdict = {
  subject_type: "sms",
  verdict: "suspicious",
  confidence: 0.72,
  headline: "This text looks like a fake delivery notice.",
  indicators: [
    {
      severity: "low",
      category: "Generic greeting",
      evidence: "Dear customer",
      explanation: "Real carriers usually use your name.",
    },
    {
      severity: "high",
      category: "Shortened link",
      evidence: "bit.ly/3xYz",
      explanation: "Shortened links hide where they really go.",
    },
  ],
  recommended_actions: [
    { action: "Don't tap the link.", urgency: "now" },
    { action: "Track the package on the carrier's own site.", urgency: "soon", deep_link: "https://www.usps.com/" },
    { action: "Block the sender.", urgency: "optional", deep_link: "javascript:alert(1)" },
  ],
  iocs: {
    urls: ["https://bit.ly/3xYz"],
    domains: ["bit.ly"],
    ips: ["203.0.113.7"],
    hashes: [],
    phone_numbers: ["+1 555 0100"],
  },
};

export function ndjson(events: AgentEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** A Response whose body streams the given NDJSON text in small, line-splitting chunks. */
export function streamingResponse(text: string, init: ResponseInit = {}, chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" }, ...init });
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
