import type { CheckContext, SafeBrowsingResult, Skipped } from "../types.js";
import { discardBody, envKey, readJson, timeoutSignal } from "../util.js";

export const SAFE_BROWSING_ENDPOINT = "https://safebrowsing.googleapis.com/v4/threatMatches:find";
export const SAFE_BROWSING_THREAT_TYPES = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"];

type Match = { threatType?: string; platformType?: string; threat?: { url?: string } };

export function parseSafeBrowsing(body: unknown): SafeBrowsingResult {
  const matches = ((body as { matches?: Match[] } | null)?.matches ?? []).map((m) => ({
    threat_type: m.threatType ?? "UNKNOWN",
    platform: m.platformType ?? "UNKNOWN",
    url: m.threat?.url ?? "",
  }));
  return { flagged: matches.length > 0, matches };
}

/** Google Safe Browsing Lookup API v4 for one or more URLs (all threat types, any platform). */
export async function checkSafeBrowsing(urls: string[], ctx: CheckContext): Promise<SafeBrowsingResult | Skipped> {
  const key = envKey(ctx.deps.env, "GOOGLE_SAFE_BROWSING_API_KEY");
  if (!key) return { skipped: "no_api_key" };
  const unique = [...new Set(urls)].slice(0, 500);
  const res = await ctx.deps.fetch(`${SAFE_BROWSING_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client: { clientId: "neo", clientVersion: "0.0.0" },
      threatInfo: {
        threatTypes: SAFE_BROWSING_THREAT_TYPES,
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: unique.map((url) => ({ url })),
      },
    }),
    signal: timeoutSignal(ctx.deps.timeoutMs, ctx.signal),
  });
  if (!res.ok) {
    discardBody(res);
    throw new Error(`HTTP ${res.status}`);
  }
  return parseSafeBrowsing(await readJson(res));
}
