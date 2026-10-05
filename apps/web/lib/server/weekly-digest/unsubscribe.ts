import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey } from "@neo/core";
import { z } from "zod";
import { isDeployedEnvironment, type EnvSource } from "@/lib/env";
const ownerSchema = z.object({ tenantId: z.string().uuid(), userId: z.string().min(1).max(200) }).strict();
type TokenOwner = z.infer<typeof ownerSchema>;
/** Public development key, never accepted on a deployment. No email/name is encoded. */
const DEV_KEY = "neo-dev-weekly-digest-not-for-production";
function key(source: EnvSource): Uint8Array | undefined {
  const secret = source.AUTH_SECRET?.trim() || (!isDeployedEnvironment(source) ? DEV_KEY : undefined);
  if (!secret) return undefined;
  return deriveKey(createHash("sha256").update(secret).digest(), "neo-weekly-digest-unsubscribe-v1", "");
}
export function signDigestUnsubscribe(owner: TokenOwner, source: EnvSource = process.env): string | undefined {
  const secret = key(source);
  if (!secret) return undefined;
  const payload = Buffer.from(JSON.stringify(ownerSchema.parse(owner))).toString("base64url");
  const signed = `v1.${payload}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}
export function verifyDigestUnsubscribe(token: string, source: EnvSource = process.env): TokenOwner | undefined {
  if (token.length > 1024) return undefined;
  const secret = key(source);
  const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!secret || !match) return undefined;
  const expected = createHmac("sha256", secret).update(`v1.${match[1]}`).digest("base64url");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]!))) return undefined;
  try { return ownerSchema.parse(JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"))); }
  catch { return undefined; }
}
