/**
 * DELETE /api/household/memory/[id] → 204 (browser session, household owner): Neo forgets that entry at
 * once (a hard delete, not a mark). 403 `forbidden`; 404 `not_found` (unknown id, or another household's).
 */
import { householdRoute } from "@/lib/server/household-http";
import { forgetMemoryFromConsole } from "@/lib/server/household-memory";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  return householdRoute("api.household.memory.forget", session.tenantId, () => forgetMemoryFromConsole(session, id));
}
