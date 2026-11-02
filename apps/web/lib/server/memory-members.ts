/**
 * In-memory protection modes for MOCK_MODE and tests (the database twin is `members.mode` via
 * @neo/db `getProtectionLayers`). Keyed by tenant and user; an unset member is Standard.
 */
import type { ProtectionMode } from "@neo/db";

const g = globalThis as typeof globalThis & { __neoMemoryProtection?: Map<string, { mode: ProtectionMode; memberId: string | null }> };

function state() {
  g.__neoMemoryProtection ??= new Map();
  return g.__neoMemoryProtection;
}

export function resetMemoryProtection(): void {
  g.__neoMemoryProtection = undefined;
}

/** Test/demo helper: set a member's protection mode (and optionally the member row id alerts carry). */
export function setMemoryMemberMode(tenantId: string, userId: string, mode: ProtectionMode, memberId: string | null = null): void {
  state().set(`${tenantId}:${userId}`, { mode, memberId });
}

export function memoryProtection(tenantId: string, userId: string): { mode: ProtectionMode; memberId: string | null } {
  return state().get(`${tenantId}:${userId}`) ?? { mode: "standard", memberId: null };
}
