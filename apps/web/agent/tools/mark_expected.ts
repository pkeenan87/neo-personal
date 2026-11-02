import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { performIncidentAction } from "@/lib/server/incident-actions";
import { requireTenantCaller } from "../lib/tenant";
import { wrappedModelOutput } from "../lib/tool-io";

export default defineTool({
  description:
    "Mark a remote-access incident as expected: the household owner says this remote tool and remote ID are fine on that device. Adds them to the device's expected tools and closes the incident as a false alarm. Only for remote-access incidents. Pass only the incident id: the tool and remote ID come from the incident's own stored signals. Needs the owner's approval each time. Returns { ok: false, error } when it does nothing; never say it worked unless ok is true.",
  inputSchema: z.object({ incidentId: z.string().trim().min(1).max(100) }).strict(),
  approval: {
    request: always(),
    prompt: () => "Mark this remote session as expected? Neo will treat that remote tool and remote ID as fine on that device from now on, and close the alert as a false alarm.",
  },
  async execute({ incidentId }, ctx) {
    // Tenant and user come from the verified caller; the owner check re-reads the database at this moment.
    return performIncidentAction(requireTenantCaller(ctx), "mark_expected", incidentId);
  },
  toModelOutput: wrappedModelOutput("mark_expected"),
});
