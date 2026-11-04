/**
 * What Neo remembers about the household (_specs/v2-m3-cutover.md section 3). Browser session, household
 * owner; the owner check re-reads the database.
 *
 * GET  → { memories: [{ id, text, about: { id, name } | null, source, createdAt, expiresAt }], max }
 * POST { text, subjectMemberId? } → 201 the new entry. 400 `invalid`, `empty`, `too_long`, `control_characters`,
 *   `contact_details`, `link`, `credentials`, `payment_data`, `invalid_subject`; 403 `forbidden`; 409 `memory_limit`.
 */
import { householdRoute } from "@/lib/server/household-http";
import { addMemoryFromConsole, listMemoryForConsole } from "@/lib/server/household-memory";
import { readJsonObject } from "@/lib/server/http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  return householdRoute("api.household.memory.list", session.tenantId, () => listMemoryForConsole(session));
}

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  return householdRoute("api.household.memory.add", session.tenantId, () => addMemoryFromConsole(session, body), 201);
}
