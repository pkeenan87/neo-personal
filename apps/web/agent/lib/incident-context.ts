import { loadIncident, isUuid } from "@/lib/server/incident-data";
import { INCIDENT_CONTEXT_PREFIX } from "./incident-pointer";
import { tenantCallerOf, type EveCaller } from "./tenant";


/**
 * The turn context for an incident chat. The browser sends `clientContext: { incidentId }`; it is
 * only trusted after the caller is shown to be allowed to see that incident (same household; a
 * member only their own). The context carries the id, never the alert text: the model fetches
 * that with `get_incident`, so it arrives through wrapToolResult. Anything else the client sent
 * as context is dropped.
 */
export async function incidentTurnContext(caller: EveCaller | null, clientContext: unknown): Promise<string[]> {
  const incidentId = (clientContext as { incidentId?: unknown } | null | undefined)?.incidentId;
  const who = tenantCallerOf(caller);
  if (!who || !isUuid(incidentId)) return [];
  try {
    if (!(await loadIncident(who, incidentId))) return [];
  } catch {
    return [];
  }
  return [`${INCIDENT_CONTEXT_PREFIX}${incidentId.toLowerCase()}. Call get_incident with exactly that id before you say anything about it. Do not guess what it contains.`];
}
