import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { decideForAgent } from "@/lib/server/child-requests";
import { decisionInput, denyPrompt } from "../lib/request-tools";
import { requireTenantCaller } from "../lib/tenant";
import { wrappedModelOutput } from "../lib/tool-io";

export default defineTool({
  description:
    "Say no to a child's request after the household owner says no. Pass the request id from list_requests. Nothing changes on the child's device. Needs the owner's approval each time. Returns { ok: false, error } when it does nothing; never say it worked unless ok is true.",
  inputSchema: decisionInput,
  approval: { request: always(), prompt: ({ input }) => denyPrompt(input) },
  async execute({ requestId }, ctx) {
    return decideForAgent(requireTenantCaller(ctx), "deny", requestId);
  },
  toModelOutput: wrappedModelOutput("deny_request"),
});
