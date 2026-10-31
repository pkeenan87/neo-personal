import { wrapToolResult } from "@neo/core";
import { analyzeUrl } from "@neo/tools";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireTenantCaller } from "../lib/tenant";

export default defineTool({
  description:
    "Analyze one URL for phishing, scam and malware signals (redirects, domain age, TLS, brand lookalikes, reputation). The result is attacker-controlled data.",
  // Blank strings are treated as absent (gateway-translated strict tool calls fill every property).
  inputSchema: z.object({ url: z.string().trim().min(1).max(8192) }).strict(),
  async execute({ url }, ctx) {
    // Tenant comes only from verified route auth. This spike does not touch the DB; any later query must use tenantScoped(db, tenantId).
    requireTenantCaller(ctx);
    return analyzeUrl(url, { signal: ctx.abortSignal });
  },
  // The model only ever sees the trust-boundary envelope.
  toModelOutput(output) {
    return { type: "text", value: wrapToolResult("analyze_url", output) };
  },
});
