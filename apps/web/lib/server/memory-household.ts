/**
 * In-memory household invites and membership moves when DATABASE_URL is unset
 * (MOCK_MODE, tests). Mirrors @neo/db household.ts over the shared members map
 * in memory-state.ts. There is no users table here, so the session's email is
 * trusted as verified, and a session whose tenant has no registered members is
 * treated as the sole owner of it. Leaving or removal also revokes the member's
 * devices and pending enrollment codes (memory-devices.ts), like @neo/db.
 */
import {
  HOUSEHOLD_INVITE_TTL_MS,
  MAX_HOUSEHOLD_SIZE,
  hashInviteSecret,
  inviteSecretPrefix,
  isInviteSecretFormat,
  mintInviteSecret,
  normalizeInviteEmail,
  type AcceptInviteResult,
  type CreateInviteError,
  type DetachResult,
  type HouseholdInvitePublic,
  type InvitePreview,
} from "@neo/db";
import type { NeoSession } from "@/lib/session";
// Circular with memory-devices.ts (household names); only used at call time.
import { memoryDeleteTenantDevices, memoryDetachMemberDevices } from "./memory-devices";
import { deleteMemoryHardeningAnswers, deleteMemoryOutlookData, deleteMemorySigninData, memoryListMembers, memoryState, memoryVerdicts, setMemoryMembers } from "./memory-state";

interface MemInvite extends HouseholdInvitePublic {
  tenantId: string;
  tokenHash: string;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

const g = globalThis as typeof globalThis & { __neoMemoryInvites?: Map<string, MemInvite> };

function invites(): Map<string, MemInvite> {
  g.__neoMemoryInvites ??= new Map();
  return g.__neoMemoryInvites;
}

export function resetMemoryHousehold(): void {
  g.__neoMemoryInvites = undefined;
}

function pending(i: MemInvite, now: Date): boolean {
  return !i.acceptedAt && !i.revokedAt && i.expiresAt.getTime() > now.getTime();
}

function toPublic(i: MemInvite): HouseholdInvitePublic {
  return {
    id: i.id,
    kind: i.kind,
    email: i.email,
    tokenPrefix: i.tokenPrefix,
    sendCount: i.sendCount,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    invitedBy: i.invitedBy,
    invitedByName: i.invitedByName,
  };
}

/** In-memory households have no name column: "<owner>'s household", like the name given at signup. */
export function memoryHouseholdName(tenantId: string): string {
  const owner = memoryListMembers(tenantId).find((m) => m.role === "owner");
  return owner?.name ? `${owner.name}'s household` : "Your household";
}

/** The session user's members list, with the session user as sole owner when nothing is registered. */
function membersOf(session: NeoSession) {
  const members = memoryListMembers(session.tenantId);
  if (members.some((m) => m.userId === session.userId)) return members;
  return [{ userId: session.userId, name: session.name, email: session.email || null, role: session.role }, ...members];
}

function tenantOf(userId: string): string | undefined {
  for (const [tenantId, members] of memoryState().members) if (members.some((m) => m.userId === userId)) return tenantId;
  return undefined;
}

function bySecret(secret: string, now: Date): MemInvite | undefined {
  if (!isInviteSecretFormat(secret)) return undefined;
  const hash = hashInviteSecret(secret);
  for (const i of invites().values()) if (i.tokenHash === hash && pending(i, now)) return i;
  return undefined;
}

export function memoryCreateInvite(
  session: NeoSession,
  input: { kind: "email" | "link"; email?: string; now?: Date },
): { invite: HouseholdInvitePublic; secret: string } | { error: CreateInviteError } {
  const now = input.now ?? new Date();
  let email: string | null = null;
  if (input.kind === "email") {
    email = normalizeInviteEmail(input.email ?? "");
    if (!email) return { error: "invalid_email" };
  }
  const members = membersOf(session);
  if (email && members.some((m) => m.email?.toLowerCase() === email)) return { error: "already_member" };
  const open = [...invites().values()].filter((i) => i.tenantId === session.tenantId && pending(i, now));
  if (email && open.some((i) => i.email === email)) return { error: "invite_pending" };
  if (members.length + open.length >= MAX_HOUSEHOLD_SIZE) return { error: "household_full" };
  const secret = mintInviteSecret();
  const invite: MemInvite = {
    id: crypto.randomUUID(),
    tenantId: session.tenantId,
    kind: input.kind,
    email,
    tokenHash: hashInviteSecret(secret),
    tokenPrefix: inviteSecretPrefix(secret),
    sendCount: input.kind === "email" ? 1 : 0,
    createdAt: now,
    expiresAt: new Date(now.getTime() + HOUSEHOLD_INVITE_TTL_MS),
    invitedBy: session.userId,
    invitedByName: session.name || null,
    acceptedAt: null,
    revokedAt: null,
  };
  invites().set(invite.id, invite);
  return { invite: toPublic(invite), secret };
}

export function memoryListInvites(tenantId: string, now = new Date()): HouseholdInvitePublic[] {
  return [...invites().values()]
    .filter((i) => i.tenantId === tenantId && pending(i, now))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toPublic);
}

export function memoryRevokeInvite(tenantId: string, id: string, now = new Date()): boolean {
  const i = invites().get(id);
  if (!i || i.tenantId !== tenantId || !pending(i, now)) return false;
  i.revokedAt = now;
  return true;
}

export function memoryRotateInvite(
  tenantId: string,
  id: string,
  now = new Date(),
): { invite: HouseholdInvitePublic; secret: string } | { error: "not_found" } {
  const i = invites().get(id);
  if (!i || i.tenantId !== tenantId || i.kind !== "email" || !pending(i, now)) return { error: "not_found" };
  const secret = mintInviteSecret();
  i.tokenHash = hashInviteSecret(secret);
  i.tokenPrefix = inviteSecretPrefix(secret);
  i.expiresAt = new Date(now.getTime() + HOUSEHOLD_INVITE_TTL_MS);
  i.sendCount += 1;
  return { invite: toPublic(i), secret };
}

export function memoryPreviewInvite(session: NeoSession, secret: string, now = new Date()): InvitePreview | null {
  const inv = bySecret(secret, now);
  if (!inv) return null;
  const alreadyMember = session.tenantId === inv.tenantId || tenantOf(session.userId) === inv.tenantId;
  const members = membersOf(session);
  const me = members.find((m) => m.userId === session.userId);
  return {
    inviteId: inv.id,
    tenantId: inv.tenantId,
    householdName: memoryHouseholdName(inv.tenantId),
    inviterName: inv.invitedByName,
    kind: inv.kind,
    emailMatches: inv.kind === "link" || (session.email.trim().toLowerCase() === inv.email && Boolean(inv.email)),
    alreadyMember,
    currentHousehold: alreadyMember
      ? null
      : {
          tenantId: session.tenantId,
          name: memoryHouseholdName(session.tenantId),
          role: me?.role ?? session.role,
          memberCount: members.length,
          conversationCount: 0,
          verdictCount: memoryVerdicts().filter((v) => v.tenantId === session.tenantId).length,
          hasForwardingAddress: memoryState().inboundAddresses.some((a) => a.tenantId === session.tenantId && a.active),
        },
  };
}

export function memoryAcceptInvite(session: NeoSession, secret: string, confirmLeave: boolean, now = new Date()): AcceptInviteResult {
  const inv = bySecret(secret, now);
  if (!inv) return { status: "not_found" };
  if (inv.kind === "email" && session.email.trim().toLowerCase() !== inv.email) return { status: "email_mismatch" };
  if (session.tenantId === inv.tenantId || tenantOf(session.userId) === inv.tenantId) return { status: "already_member" };
  const members = membersOf(session);
  const me = members.find((m) => m.userId === session.userId);
  if (me?.role !== "owner") return { status: "already_in_household" };
  if (members.length > 1) return { status: "owns_household_with_members" };
  if (!confirmLeave) return { status: "confirm_required" };

  // Delete the one-person household's in-memory rows, then join.
  const state = memoryState();
  state.members.delete(session.tenantId);
  deleteMemoryHardeningAnswers(session.tenantId);
  deleteMemorySigninData(session.tenantId);
  deleteMemoryOutlookData(session.tenantId);
  state.verdicts = state.verdicts.filter((v) => v.tenantId !== session.tenantId);
  state.inboundAddresses = state.inboundAddresses.filter((a) => a.tenantId !== session.tenantId);
  memoryDeleteTenantDevices(session.tenantId, now);
  setMemoryMembers(inv.tenantId, [
    ...memoryListMembers(inv.tenantId),
    { userId: session.userId, name: session.name || null, email: session.email || null, role: "member" },
  ]);
  inv.acceptedAt = now;
  return {
    status: "accepted",
    inviteId: inv.id,
    kind: inv.kind,
    tenantId: inv.tenantId,
    householdName: memoryHouseholdName(inv.tenantId),
    invitedBy: inv.invitedBy,
    previousTenantId: session.tenantId,
    orphanedBlobUrls: [],
  };
}

function memoryDetach(tenantId: string, userId: string): "not_found" | "owner" | "done" {
  const members = memoryListMembers(tenantId);
  const m = members.find((x) => x.userId === userId);
  if (!m) return "not_found";
  if (m.role === "owner") return "owner";
  setMemoryMembers(
    tenantId,
    members.filter((x) => x.userId !== userId),
  );
  memoryDetachMemberDevices(tenantId, userId);
  return "done";
}

export function memoryRemoveMember(tenantId: string, userId: string): DetachResult<"removed" | "cannot_remove_owner"> {
  const r = memoryDetach(tenantId, userId);
  if (r === "not_found") return { status: "not_found" };
  return { status: r === "owner" ? "cannot_remove_owner" : "removed", conversationsDeleted: 0 };
}

export function memoryLeave(tenantId: string, userId: string): DetachResult<"left" | "owner_cannot_leave"> {
  const r = memoryDetach(tenantId, userId);
  if (r === "not_found") return { status: "not_found" };
  return { status: r === "owner" ? "owner_cannot_leave" : "left", conversationsDeleted: 0 };
}
