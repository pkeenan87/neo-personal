import type { CheckContext, Skipped, VirusTotalResult } from "../types.js";
import { discardBody, envKey, readJson, timeoutSignal } from "../util.js";

export const VIRUSTOTAL_API = "https://www.virustotal.com/api/v3";

/** VirusTotal URL identifier: unpadded base64url of the URL. */
export function virusTotalUrlId(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
}

function permalink(id: string): string {
  return `https://www.virustotal.com/gui/url/${id}`;
}

type VtAttributes = {
  last_analysis_stats?: { malicious?: number; suspicious?: number; harmless?: number; undetected?: number };
  last_analysis_results?: Record<string, { category?: string; result?: string; engine_name?: string }>;
  reputation?: number;
  last_analysis_date?: number;
};

export function parseVirusTotalReport(id: string, body: unknown): VirusTotalResult {
  const attrs = ((body as { data?: { attributes?: VtAttributes } } | null)?.data?.attributes ?? {}) as VtAttributes;
  const stats = attrs.last_analysis_stats ?? {};
  const rank = (c?: string) => (c === "malicious" ? 0 : c === "suspicious" ? 1 : 2);
  const top_engines = Object.entries(attrs.last_analysis_results ?? {})
    .filter(([, r]) => r.category === "malicious" || r.category === "suspicious")
    .sort(([a, ra], [b, rb]) => rank(ra.category) - rank(rb.category) || a.localeCompare(b))
    .slice(0, 8)
    .map(([name, r]) => `${r.engine_name ?? name}${r.result ? ` (${r.result})` : ""}`);
  const result: VirusTotalResult = {
    status: "found",
    malicious: stats.malicious ?? 0,
    suspicious: stats.suspicious ?? 0,
    harmless: stats.harmless ?? 0,
    undetected: stats.undetected ?? 0,
    top_engines,
    permalink: permalink(id),
  };
  if (typeof attrs.reputation === "number") result.reputation = attrs.reputation;
  if (typeof attrs.last_analysis_date === "number") result.last_analysis_date = new Date(attrs.last_analysis_date * 1000).toISOString();
  return result;
}

/** VirusTotal v3 URL report; unknown URLs are submitted for scanning (unless disabled) and reported as pending. */
export async function checkVirusTotal(url: string, ctx: CheckContext): Promise<VirusTotalResult | Skipped> {
  const key = envKey(ctx.deps.env, "VIRUSTOTAL_API_KEY");
  if (!key) return { skipped: "no_api_key" };
  const id = virusTotalUrlId(url);
  const res = await ctx.deps.fetch(`${VIRUSTOTAL_API}/urls/${id}`, {
    headers: { "x-apikey": key, accept: "application/json" },
    signal: timeoutSignal(ctx.deps.timeoutMs, ctx.signal),
  });
  if (res.ok) return parseVirusTotalReport(id, await readJson(res));
  discardBody(res);
  if (res.status !== 404) throw new Error(`HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`);
  if (!ctx.deps.virustotalSubmit) return { status: "pending", permalink: permalink(id) };

  const submit = await ctx.deps.fetch(`${VIRUSTOTAL_API}/urls`, {
    method: "POST",
    headers: { "x-apikey": key, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url }).toString(),
    signal: timeoutSignal(ctx.deps.timeoutMs, ctx.signal),
  });
  if (!submit.ok) {
    discardBody(submit);
    throw new Error(`submit HTTP ${submit.status}`);
  }
  const body = (await readJson(submit)) as { data?: { id?: string } } | null;
  const result: VirusTotalResult = { status: "pending", permalink: permalink(id) };
  if (body?.data?.id) result.analysis_id = body.data.id;
  return result;
}
