/**
 * In-memory protection modes for MOCK_MODE and tests (the database twin is `members.mode` via
 * @neo/db `getProtectionLayers`). Keyed by tenant and user; an unset member is Standard.
 * Helpers (`helper_member_ids`) and contact-only helper members are kept here too, for the
 * alert recipients (lib/server/alerts/outbox.ts).
 */
import type { ProtectionMode } from "@neo/db";

interface MemoryProtection {
  mode: ProtectionMode;
  memberId: string | null;
  helperMemberIds: string[];
}

interface MemoryContactMember {
  id: string;
  displayName: string;
  contact: string;
}

const g = globalThis as typeof globalThis & {
  __neoMemoryProtection?: Map<string, MemoryProtection>;
  __neoMemoryContactMembers?: Map<string, MemoryContactMember[]>;
};

function state() {
  g.__neoMemoryProtection ??= new Map();
  return g.__neoMemoryProtection;
}

export function resetMemoryProtection(): void {
  g.__neoMemoryProtection = undefined;
  g.__neoMemoryContactMembers = undefined;
}

/** Test/demo helper: set a member's protection mode (and optionally the member row id alerts carry, and their helpers). */
export function setMemoryMemberMode(
  tenantId: string,
  userId: string,
  mode: ProtectionMode,
  memberId: string | null = null,
  helperMemberIds: string[] = [],
): void {
  state().set(`${tenantId}:${userId}`, { mode, memberId, helperMemberIds });
}

export function memoryProtection(tenantId: string, userId: string): MemoryProtection {
  return state().get(`${tenantId}:${userId}`) ?? { mode: "standard", memberId: null, helperMemberIds: [] };
}

/** Test/demo helper: a helper member with no account, reachable at `contact`. */
export function addMemoryContactMember(tenantId: string, member: MemoryContactMember): void {
  g.__neoMemoryContactMembers ??= new Map();
  const list = g.__neoMemoryContactMembers.get(tenantId) ?? [];
  list.push(member);
  g.__neoMemoryContactMembers.set(tenantId, list);
}

export function memoryContactMembers(tenantId: string): MemoryContactMember[] {
  return g.__neoMemoryContactMembers?.get(tenantId) ?? [];
}
