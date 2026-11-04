import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { confirmSignin } from "@/lib/server/signin/chat-answer";
import { requireTenantCaller } from "../lib/tenant";
import { wrappedModelOutput } from "../lib/tool-io";

export default defineTool({
  description:
    "Record the person's answer to \"Was this you?\" for one of their own sign-in alerts: wasMe true remembers that device as theirs; wasMe false forgets it and points to the account takeover playbook. Pass the verdictId from pending_signin_alerts and the answer the person gave in their own message. Needs the person's approval each time. Returns { ok: false, error } when it does nothing; never say it worked unless ok is true.",
  inputSchema: z.object({ verdictId: z.string().trim().min(1).max(100), wasMe: z.boolean() }).strict(),
  approval: {
    request: always(),
    // Fixed text only: the device and place in the alert are attacker-controlled.
    prompt: ({ input }) =>
      input.wasMe
        ? "Tell Neo that this sign-in was you? Neo will remember that device as yours and stop asking about it."
        : "Tell Neo that this sign-in was not you? Neo will not trust that device, and will walk you through securing your account.",
  },
  async execute({ verdictId, wasMe }, ctx) {
    // Tenant and user come from the verified caller; only the alert's own member can answer (re-checked in the database).
    return confirmSignin(requireTenantCaller(ctx), verdictId, wasMe);
  },
  toModelOutput: wrappedModelOutput("confirm_signin"),
});
