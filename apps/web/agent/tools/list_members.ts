import { defineTool } from "eve/tools";
import { z } from "zod";
import { listMemberSummaries } from "@/lib/server/incident-data";
import { requireTenantCaller } from "../lib/tenant";
import { wrappedModelOutput } from "../lib/tool-io";

export default defineTool({
  description:
    "List the household's members: id, display name, role, protection mode and how many active devices each has. No contact details. A household member sees only themselves; an owner sees everyone.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    return { members: await listMemberSummaries(requireTenantCaller(ctx)) };
  },
  toModelOutput: wrappedModelOutput("list_members"),
});
