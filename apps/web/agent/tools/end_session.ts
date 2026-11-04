import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { requestEndSession } from "@/lib/server/end-session";
import { requireTenantCaller } from "../lib/tenant";
import { wrappedModelOutput } from "../lib/tool-io";

export default defineTool({
  description:
    "Ask the computer in a remote-access incident to end the remote session. Neo sends a request to that computer; it closes the remote-access program only after the person at the computer confirms on screen (unless it is a child's computer). This only requests: the session has not ended when the tool returns, and you must never say it did. Pass only the incident id: the computer, the tool and the remote ID come from the incident's own stored signals. Needs the owner's approval each time. Returns { ok: false, error } when it sends nothing; never say it worked unless ok is true, and even then say only that it was requested.",
  inputSchema: z.object({ incidentId: z.string().trim().min(1).max(100) }).strict(),
  approval: {
    request: always(),
    prompt: () => "Ask that computer to end the remote session? The person at the computer will be asked to confirm on screen before anything is closed (unless it is a child's computer).",
  },
  async execute({ incidentId }, ctx) {
    // Tenant and user come from the verified caller; the owner check re-reads the database at this moment.
    return requestEndSession(requireTenantCaller(ctx), incidentId);
  },
  toModelOutput: wrappedModelOutput("end_session"),
});
