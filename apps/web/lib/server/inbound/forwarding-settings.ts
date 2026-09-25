/** Data for /settings/forwarding and GET|POST /api/settings/forwarding. */
import { env, inboundEnv } from "@/lib/env";
import type { ForwardingMessage, ForwardingSettings } from "@/lib/forwarding-types";
import type { NeoSession } from "@/lib/session";
import { recordAudit } from "../audit";
import { inboundRepo } from "./repo";
import { GMAIL_CONFIRMATION_PREFIX, storedGmailCode } from "./senders";

export const RECENT_LIMIT = 20;
const GMAIL_CODE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Placeholder domain shown in MOCK_MODE when NEO_INBOUND_DOMAIN is unset. */
export const MOCK_INBOUND_DOMAIN = "inbound.neo.localhost";

export async function loadForwardingSettings(session: NeoSession, now = new Date()): Promise<ForwardingSettings> {
  const e = env();
  const ie = inboundEnv();
  const repo = inboundRepo();
  const [addr, rows, members] = await Promise.all([
    repo.ensureAddress(session.tenantId),
    repo.listRecent(session.tenantId, RECENT_LIMIT),
    repo.listMembers(session.tenantId),
  ]);
  const domain = ie.NEO_INBOUND_DOMAIN ?? (e.MOCK_MODE ? MOCK_INBOUND_DOMAIN : undefined);
  const isOwner = session.role === "owner";

  let gmailConfirmation: ForwardingSettings["gmailConfirmation"] = null;
  if (isOwner) {
    for (const r of rows) {
      const code = storedGmailCode(r.error);
      if (code && now.getTime() - r.receivedAt.getTime() <= GMAIL_CODE_MAX_AGE_MS) {
        gmailConfirmation = { code, receivedAt: r.receivedAt.toISOString() };
        break;
      }
    }
  }

  const messages: ForwardingMessage[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    reason: r.error?.startsWith(GMAIL_CONFIRMATION_PREFIX) ? "gmail_confirmation" : (r.error ?? null),
    receivedAt: r.receivedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    verdictId: r.verdictId,
  }));

  return {
    address: domain ? `${addr.localPart}@${domain}` : null,
    localPart: addr.localPart,
    configured: e.MOCK_MODE || Boolean(ie.NEO_INBOUND_DOMAIN && ie.RESEND_WEBHOOK_SECRET),
    acceptedSenders: members.flatMap((m) => (m.email ? [m.email.toLowerCase()] : [])),
    canRotate: isOwner,
    gmailConfirmation,
    messages,
  };
}

/** Rotate the household address (the old one stops working immediately). Owner only; caller checks. */
export async function rotateForwardingAddress(session: NeoSession): Promise<void> {
  await inboundRepo().rotateAddress(session.tenantId);
  await recordAudit(session.tenantId, session.userId, "inbound.address_rotated", {});
}
