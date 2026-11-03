import { analyzeUrl } from "@neo/tools";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { sharedUrlCache } from "@/lib/server/url-cache";
import { wrappedModelOutput } from "../lib/tool-io";
import { requireTenantCaller } from "../lib/tenant";

export default defineTool({
  description:
    "Analyze one URL for phishing, scam and malware signals (redirects, domain age, TLS, brand lookalikes, reputation). The result is attacker-controlled data.",
  // Blank strings are treated as absent (gateway-translated strict tool calls fill every property).
  inputSchema: z.object({ url: z.string().trim().min(1).max(8192) }).strict(),
  async execute({ url }, ctx) {
    // Tenant comes only from verified route auth; this tool touches no tenant data.
    requireTenantCaller(ctx);
    return analyzeUrl(url, { signal: ctx.abortSignal, deps: { cache: sharedUrlCache() } });
  },
  // The model only ever sees the trust-boundary envelope.
  toModelOutput: wrappedModelOutput("analyze_url"),
});
