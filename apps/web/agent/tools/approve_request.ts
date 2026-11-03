import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { decideForAgent } from "@/lib/server/child-requests";
import { approvePrompt, decisionInput } from "../lib/request-tools";
import { requireTenantCaller } from "../lib/tenant";
import { wrappedModelOutput } from "../lib/tool-io";

export default defineTool({
  description:
    "Approve a child's request (more time, unblocking a site, or allowing an app) after the household owner says yes. Pass the request id from list_requests; for more time pass the minutes you are offering (1 to 120); for a site you may pass scope \"once\" (1 hour, the default) or \"always\". The grant comes from the stored request, never from your input. Needs the owner's approval each time. Returns { ok: false, error } when it does nothing; never say it worked unless ok is true.",
  inputSchema: decisionInput,
  approval: { request: always(), prompt: ({ input }) => approvePrompt(input) },
  async execute({ requestId, minutes, scope }, ctx) {
    return decideForAgent(requireTenantCaller(ctx), "approve", requestId, { minutes, scope });
  },
  toModelOutput: wrappedModelOutput("approve_request"),
});
