import { recordSessionOwner } from "@/lib/server/eve-session-owner";
import { tenantCallerOf, type EveCaller } from "./tenant";

/**
 * Record the creator of a new eve session (the session's initiator). A session whose initiator is
 * not a Neo household member is left unrecorded, so no one can continue it through the chat route.
 */
export async function recordSessionCreator(sessionId: string, initiator: EveCaller | null | undefined): Promise<void> {
  const who = tenantCallerOf(initiator);
  if (who) await recordSessionOwner({ tenantId: who.tenantId, userId: who.userId }, sessionId);
}
