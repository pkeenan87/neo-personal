import { defineTool } from "eve/tools";
import { z } from "zod";
import { deviceTimeline, TIMELINE_MAX_HOURS } from "@/lib/server/incident-data";
import { requireTenantCaller } from "../lib/tenant";
import { optionalInput, wrappedModelOutput } from "../lib/tool-io";

export default defineTool({
  description:
    "What a household member's devices reported in the last hours (at most 24), oldest first: detector, subject (a domain, tool or app name), severity, outcome, time and device name. Give memberId (from list_members) or deviceId; with neither it is the caller's own. A member can ask only about themselves; an owner about anyone in the household. Returns { error: \"not_found\" } otherwise.",
  inputSchema: z
    .object({
      memberId: optionalInput(z.string().trim().max(100)),
      deviceId: optionalInput(z.string().trim().max(100)),
      hours: optionalInput(z.number().int().min(0).max(TIMELINE_MAX_HOURS)),
    })
    .strict(),
  async execute({ memberId, deviceId, hours }, ctx) {
    return deviceTimeline(requireTenantCaller(ctx), {
      ...(memberId ? { memberId } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(hours ? { hours } : {}),
    });
  },
  toModelOutput: wrappedModelOutput("device_timeline"),
});
