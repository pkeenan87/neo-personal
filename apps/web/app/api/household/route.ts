/**
 * GET /api/household → { tenantId, name, role, members: [{ userId, name, email, role }] }
 * Owners see member emails; members get `email: null` for everyone.
 */
import { NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { household } from "@/lib/server/verdict-data";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  try {
    return Response.json(await household(session), { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.household", session.tenantId);
  }
}
