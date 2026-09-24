import type { CheckContext, Skipped, UrlscanResult } from "../types.js";
import { discardBody, envKey, readJson, sleep, timeoutSignal } from "../util.js";

export const URLSCAN_API = "https://urlscan.io/api/v1";

type UrlscanDoc = {
  task?: { uuid?: string; screenshotURL?: string; reportURL?: string };
  page?: { domain?: string; ip?: string; country?: string };
  verdicts?: { overall?: { score?: number; malicious?: boolean } };
};

export function parseUrlscanResult(uuid: string, body: unknown): UrlscanResult {
  const doc = (body ?? {}) as UrlscanDoc;
  const result: UrlscanResult = {
    status: "done",
    uuid,
    report_url: doc.task?.reportURL ?? `https://urlscan.io/result/${uuid}/`,
    screenshot_url: doc.task?.screenshotURL ?? `https://urlscan.io/screenshots/${uuid}.png`,
  };
  const overall = doc.verdicts?.overall;
  if (typeof overall?.score === "number") result.score = overall.score;
  if (typeof overall?.malicious === "boolean") result.malicious = overall.malicious;
  if (doc.page) {
    const page: NonNullable<UrlscanResult["page"]> = {};
    if (doc.page.domain) page.domain = doc.page.domain;
    if (doc.page.ip) page.ip = doc.page.ip;
    if (doc.page.country) page.country = doc.page.country;
    result.page = page;
  }
  return result;
}

/** urlscan.io private scan + poll. Slow (10-30s), so disabled unless explicitly enabled. */
export async function checkUrlscan(url: string, ctx: CheckContext): Promise<UrlscanResult | Skipped> {
  if (!ctx.deps.urlscan) return { skipped: "disabled" };
  const key = envKey(ctx.deps.env, "URLSCAN_API_KEY");
  if (!key) return { skipped: "no_api_key" };

  const submit = await ctx.deps.fetch(`${URLSCAN_API}/scan/`, {
    method: "POST",
    headers: { "api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ url, visibility: "private" }),
    signal: timeoutSignal(ctx.deps.timeoutMs, ctx.signal),
  });
  if (!submit.ok) {
    discardBody(submit);
    throw new Error(`submit HTTP ${submit.status}`);
  }
  const { uuid } = ((await readJson(submit)) ?? {}) as { uuid?: string };
  if (!uuid) throw new Error("submit returned no uuid");

  const deadline = Date.now() + ctx.deps.urlscanPollMs;
  while (Date.now() < deadline) {
    await sleep(ctx.deps.urlscanPollIntervalMs, ctx.signal);
    const res = await ctx.deps.fetch(`${URLSCAN_API}/result/${uuid}/`, {
      headers: { "api-key": key },
      signal: timeoutSignal(ctx.deps.timeoutMs, ctx.signal),
    });
    if (res.status === 404) {
      discardBody(res);
      continue;
    }
    if (!res.ok) {
      discardBody(res);
      throw new Error(`result HTTP ${res.status}`);
    }
    return parseUrlscanResult(uuid, await readJson(res));
  }
  return { status: "pending", uuid, report_url: `https://urlscan.io/result/${uuid}/` };
}
