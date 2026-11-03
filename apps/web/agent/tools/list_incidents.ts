import { defineTool } from "eve/tools";
import { z } from "zod";
import { INCIDENT_LIST_MAX, listIncidents } from "@/lib/server/incident-data";
import { requireTenantCaller } from "../lib/tenant";
import { optionalInput, wrappedModelOutput } from "../lib/tool-io";

export default defineTool({
  description:
    "List recent incidents (Neo alerts), newest first: id, kind, severity, status, title, time and whose. status \"open\" (default) is the ones nobody has marked as seen; \"all\" includes handled ones. A household member sees only incidents about themselves. Use get_incident for the details of one.",
  inputSchema: z
    .object({
      status: optionalInput(z.enum(["open", "all"])),
      limit: optionalInput(z.number().int().min(0).max(INCIDENT_LIST_MAX)),
    })
    .strict(),
  async execute({ status, limit }, ctx) {
    const incidents = await listIncidents(requireTenantCaller(ctx), { ...(status ? { status } : {}), ...(limit ? { limit } : {}) });
    return { incidents };
  },
  toModelOutput: wrappedModelOutput("list_incidents"),
});
