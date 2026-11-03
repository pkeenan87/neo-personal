import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { performIncidentAction, NOTE_MAX } from "@/lib/server/incident-actions";
import { requireTenantCaller } from "../lib/tenant";
import { optionalInput, wrappedModelOutput } from "../lib/tool-io";

export default defineTool({
  description:
    "Close an incident as handled without changing any settings: the household owner has looked and accepts this one. Records the decision. Pass the incident id and, optionally, a short note. Needs the owner's approval each time. Returns { ok: false, error } when it does nothing; never say it worked unless ok is true.",
  // A blank note counts as absent (gateway-translated strict tool calls fill every property).
  inputSchema: z.object({ incidentId: z.string().trim().min(1).max(100), note: optionalInput(z.string().trim().max(NOTE_MAX)) }).strict(),
  approval: {
    request: always(),
    prompt: () => "Close this alert as handled? Neo will not change any settings. It only records that you accepted this one.",
  },
  async execute({ incidentId, note }, ctx) {
    return performIncidentAction(requireTenantCaller(ctx), "allow_once", incidentId, note === undefined ? {} : { note });
  },
  toModelOutput: wrappedModelOutput("allow_once"),
});
