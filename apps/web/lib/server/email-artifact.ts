/** The uploaded-email loader behind analyze_email's artifact_ref, for the old chat and the eve chat (_specs/v2-followups.md slice D). */
import { getArtifactStore } from "./artifacts";

const ARTIFACT_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads an email artifact by ref and tenant. The tenant comes from the caller's
 * session, never from the model's input.
 */
export async function loadEmailArtifact(ref: string, tenantId: string): Promise<Uint8Array | undefined> {
  if (!ARTIFACT_REF_RE.test(ref)) return undefined;
  const store = getArtifactStore();
  if (!store) return undefined;
  const meta = await store.get(ref.toLowerCase(), tenantId);
  // Screenshots are for the model's eyes, not the email parser.
  if (!meta || meta.kind === "image") return undefined;
  return store.read(meta.id, tenantId);
}
