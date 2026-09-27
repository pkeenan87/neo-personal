/**
 * Household invites and membership changes (_specs/household-invites.md).
 * Postgres via @neo/db when DATABASE_URL is set, else memory-household.ts.
 * Route handlers stay thin: role checks, limits, emails and audit live here and
 * every failure comes back as `{ ok: false, status, code, message }`.
 */
import { hashPii, logger } from "@neo/core";
import {
  acceptHouseholdInvite,
  createHouseholdInvite,
  leaveHousehold,
  listPendingHouseholdInvites,
  previewHouseholdInvite,
  removeHouseholdMember,
  revokeHouseholdInvite,
  rotateHouseholdInvite,
  type AcceptInviteError,
  type CreateInviteError,
  type HouseholdInvitePublic,
} from "@neo/db";
import type {
  AcceptInviteResponse,
  CreateInviteResponse,
  HouseholdInviteItem,
  InvitePreviewResponse,
  ResendInviteResponse,
} from "@/lib/household-types";
import type { NeoSession } from "@/lib/session";
import { deleteOrphanedBlobs } from "./artifacts";
import { recordAudit } from "./audit";
import { getDb } from "./db";
import { alertMemberJoined, alertMemberLeft } from "./alerts";
import { renderInviteEmail, renderMemberRemovedEmail } from "./email/household-email";
import { getMailer } from "./email/resend";
import {
  memoryAcceptInvite,
  memoryCreateInvite,
  memoryLeave,
  memoryListInvites,
  memoryPreviewInvite,
  memoryRemoveMember,
  memoryRevokeInvite,
  memoryRotateInvite,
} from "./memory-household";
import { takeRateSlot } from "./rate-limit";
import { household, householdMembers } from "./verdict-data";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Invites created or resent, per household. */
export const INVITE_SEND_LIMIT = { limit: 20, windowMs: DAY_MS } as const;
/** Preview and accept attempts, per user: secrets are unguessable, this only blunts scripted abuse. */
export const INVITE_USE_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 } as const;

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string; retryAfterSeconds?: number };

function fail(status: number, code: string, message: string): { ok: false; status: number; code: string; message: string } {
  return { ok: false, status, code, message };
}

function rateLimited(retryAfterSeconds: number): Outcome<never> {
  return { ok: false, status: 429, code: "rate_limited", message: "Too many attempts. Please try again later.", retryAfterSeconds };
}

const OWNER_ONLY = fail(403, "forbidden", "Only the household owner can do this.");

export function inviteUrl(origin: string, secret: string): string {
  return `${origin}/invite/${secret}`;
}

export function toInviteItem(i: HouseholdInvitePublic): HouseholdInviteItem {
  return {
    id: i.id,
    kind: i.kind,
    email: i.email,
    tokenPrefix: i.tokenPrefix,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    invitedByName: i.invitedByName,
  };
}

export async function listInvites(session: NeoSession): Promise<HouseholdInviteItem[]> {
  if (session.role !== "owner") return [];
  const db = getDb();
  const rows = db ? await listPendingHouseholdInvites(db, session.tenantId) : memoryListInvites(session.tenantId);
  return rows.map(toInviteItem);
}

async function sendInviteEmail(session: NeoSession, invite: HouseholdInvitePublic, url: string): Promise<boolean> {
  const mailer = getMailer();
  if (!mailer || !invite.email) return false;
  try {
    const { name } = await household(session);
    const email = renderInviteEmail({ inviterName: invite.invitedByName ?? session.name, householdName: name, url, expiresAt: invite.expiresAt });
    await mailer.send({ to: invite.email, ...email, idempotencyKey: `invite:${invite.id}:${invite.sendCount}` });
    return true;
  } catch (err) {
    logger.error("Invite email failed", "household", {
      tenantId: session.tenantId,
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return false;
  }
}

const CREATE_ERRORS: Record<CreateInviteError, { status: number; message: string }> = {
  invalid_email: { status: 400, message: "Enter one email address." },
  already_member: { status: 409, message: "That person is already in your household." },
  invite_pending: { status: 409, message: "An invite to that address is already pending. Resend or revoke it." },
  household_full: { status: 400, message: "A household can have up to 10 people, including pending invites." },
};

export async function createInvite(
  session: NeoSession,
  input: { kind: "email" | "link"; email?: string },
  origin: string,
): Promise<Outcome<CreateInviteResponse>> {
  if (session.role !== "owner") return OWNER_ONLY;
  const slot = takeRateSlot("household-invite-send", session.tenantId, INVITE_SEND_LIMIT.limit, INVITE_SEND_LIMIT.windowMs);
  if (!slot.ok) return rateLimited(slot.retryAfterSeconds);

  const db = getDb();
  const created = db
    ? await createHouseholdInvite(db, { tenantId: session.tenantId, invitedBy: session.userId, kind: input.kind, ...(input.email !== undefined ? { email: input.email } : {}) })
    : memoryCreateInvite(session, input);
  if ("error" in created) {
    const e = CREATE_ERRORS[created.error];
    return fail(e.status, created.error, e.message);
  }
  const url = inviteUrl(origin, created.secret);
  if (created.invite.kind === "email" && !(await sendInviteEmail(session, created.invite, url))) {
    await revokeInvite(session, created.invite.id, { audit: false });
    return fail(502, "email_failed", "Neo could not send the invite email. Try again, or create a link instead.");
  }
  await recordAudit(session.tenantId, session.userId, "household.invite_created", {
    inviteId: created.invite.id,
    kind: created.invite.kind,
    ...(created.invite.email ? { emailHash: hashPii(created.invite.email) } : {}),
    tokenPrefix: created.invite.tokenPrefix,
  });
  return { ok: true, value: { invite: toInviteItem(created.invite), url } };
}

export async function resendInvite(session: NeoSession, id: string, origin: string): Promise<Outcome<ResendInviteResponse>> {
  if (session.role !== "owner") return OWNER_ONLY;
  const slot = takeRateSlot("household-invite-send", session.tenantId, INVITE_SEND_LIMIT.limit, INVITE_SEND_LIMIT.windowMs);
  if (!slot.ok) return rateLimited(slot.retryAfterSeconds);
  const db = getDb();
  const rotated = db ? await rotateHouseholdInvite(db, session.tenantId, id) : memoryRotateInvite(session.tenantId, id);
  if ("error" in rotated) return fail(404, "not_found", "That invite is no longer pending.");
  if (!(await sendInviteEmail(session, rotated.invite, inviteUrl(origin, rotated.secret)))) {
    return fail(502, "email_failed", "Neo could not send the invite email. Try again in a moment.");
  }
  await recordAudit(session.tenantId, session.userId, "household.invite_resent", { inviteId: id, tokenPrefix: rotated.invite.tokenPrefix });
  return { ok: true, value: { invite: toInviteItem(rotated.invite) } };
}

export async function revokeInvite(session: NeoSession, id: string, opts: { audit?: boolean } = {}): Promise<Outcome<null>> {
  if (session.role !== "owner") return OWNER_ONLY;
  const db = getDb();
  const done = db ? await revokeHouseholdInvite(db, session.tenantId, id) : memoryRevokeInvite(session.tenantId, id);
  if (!done) return fail(404, "not_found", "That invite is no longer pending.");
  if (opts.audit !== false) await recordAudit(session.tenantId, session.userId, "household.invite_revoked", { inviteId: id });
  return { ok: true, value: null };
}

export async function previewInvite(session: NeoSession, secret: string): Promise<Outcome<InvitePreviewResponse>> {
  const slot = takeRateSlot("household-invite-use", session.userId, INVITE_USE_LIMIT.limit, INVITE_USE_LIMIT.windowMs);
  if (!slot.ok) return rateLimited(slot.retryAfterSeconds);
  const db = getDb();
  const p = db ? await previewHouseholdInvite(db, { secret, userId: session.userId }) : memoryPreviewInvite(session, secret);
  if (!p) return fail(404, "not_found", "This invite is not valid. It may have expired, been used, or been revoked.");
  const current = p.currentHousehold;
  return {
    ok: true,
    value: {
      householdName: p.householdName,
      inviterName: p.inviterName,
      kind: p.kind,
      emailMatches: p.emailMatches,
      alreadyMember: p.alreadyMember,
      currentHousehold: current
        ? {
            name: current.name,
            role: current.role,
            memberCount: current.memberCount,
            conversationCount: current.conversationCount,
            verdictCount: current.verdictCount,
            hasForwardingAddress: current.hasForwardingAddress,
          }
        : null,
    },
  };
}

const ACCEPT_ERRORS: Record<AcceptInviteError, { status: number; message: string }> = {
  not_found: { status: 404, message: "This invite is not valid. It may have expired, been used, or been revoked." },
  email_mismatch: { status: 403, message: "This invite was sent to a different email address. Sign in with that address to accept it." },
  already_member: { status: 409, message: "You are already in this household." },
  owns_household_with_members: {
    status: 409,
    message: "You own a household with other members. Remove them before joining another household.",
  },
  already_in_household: { status: 409, message: "You are a member of another household. Leave it before joining this one." },
  confirm_required: { status: 400, message: "Confirm that your current household will be deleted." },
};

export async function acceptInvite(session: NeoSession, secret: string, confirmLeave: boolean): Promise<Outcome<AcceptInviteResponse>> {
  const slot = takeRateSlot("household-invite-use", session.userId, INVITE_USE_LIMIT.limit, INVITE_USE_LIMIT.windowMs);
  if (!slot.ok) return rateLimited(slot.retryAfterSeconds);
  const db = getDb();
  const r = db ? await acceptHouseholdInvite(db, { secret, userId: session.userId, confirmLeave }) : memoryAcceptInvite(session, secret, confirmLeave);
  if (r.status !== "accepted") {
    const e = ACCEPT_ERRORS[r.status];
    return fail(e.status, r.status, e.message);
  }
  logger.info("Household invite accepted", "household", {
    tenantId: r.tenantId,
    userIdHash: hashPii(session.userId),
    ...(r.previousTenantId ? { previousTenantIdHash: hashPii(r.previousTenantId) } : {}),
  });
  await deleteOrphanedBlobs(r.orphanedBlobUrls);
  // The owner hears about it through an alert (_specs/owner-alerts.md: `member_joined`, emailed by default).
  await alertMemberJoined(r.tenantId, { userId: session.userId, name: session.name || null, email: session.email || null });
  return { ok: true, value: { tenantId: r.tenantId, householdName: r.householdName } };
}

export async function removeMember(session: NeoSession, userId: string, origin: string): Promise<Outcome<null>> {
  if (session.role !== "owner") return OWNER_ONLY;
  const members = await householdMembers(session);
  const target = members.find((m) => m.userId === userId);
  const db = getDb();
  const r = db
    ? await removeHouseholdMember(db, { tenantId: session.tenantId, userId, removedBy: session.userId })
    : memoryRemoveMember(session.tenantId, userId);
  if (r.status === "not_found") return fail(404, "not_found", "That person is not in your household.");
  if (r.status === "cannot_remove_owner") return fail(400, "cannot_remove_owner", "The household owner cannot be removed.");
  await alertMemberLeft(session.tenantId, { userId, name: target?.name ?? null, email: target?.email ?? null }, true);
  const mailer = getMailer();
  if (mailer && target?.email) {
    try {
      const { name } = await household(session);
      const email = renderMemberRemovedEmail({ householdName: name, url: origin });
      await mailer.send({ to: target.email, ...email, idempotencyKey: `household-removed:${session.tenantId}:${userId}:${Date.now()}` });
    } catch (err) {
      logger.error("Member removed email failed", "household", {
        tenantId: session.tenantId,
        errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
  }
  return { ok: true, value: null };
}

export async function leave(session: NeoSession): Promise<Outcome<null>> {
  const db = getDb();
  const r = db ? await leaveHousehold(db, { tenantId: session.tenantId, userId: session.userId }) : memoryLeave(session.tenantId, session.userId);
  if (r.status === "not_found") return fail(404, "not_found", "You are not in this household.");
  if (r.status === "owner_cannot_leave") return fail(400, "owner_cannot_leave", "The owner cannot leave their own household.");
  await alertMemberLeft(session.tenantId, { userId: session.userId, name: session.name || null, email: session.email || null }, false);
  return { ok: true, value: null };
}
