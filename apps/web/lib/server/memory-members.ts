/**
 * In-memory protection modes for MOCK_MODE and tests (the database twin is `members.mode` via
 * @neo/db `getProtectionLayers`). Keyed by tenant and user; an unset member is Standard.
 * Helpers (`helper_member_ids`) and contact-only helper members are kept here too, for the
 * alert recipients (lib/server/alerts/outbox.ts).
 */
import type { MemberRole, ProtectionMode } from "@neo/db";
import { memoryListMembers } from "./memory-state";

interface MemoryProtection {
  mode: ProtectionMode;
  /** Console edit (Child mode's age band). */
  birthYear?: number | null;
  memberId: string | null;
  helperMemberIds: string[];
  /** Console edits (lib/server/member-console.ts); unset means the account's own name and role. */
  displayName?: string;
  role?: MemberRole;
  updatedAt?: Date;
}

interface MemoryContactMember {
  id: string;
  displayName: string;
  contact: string;
  /** A member created in the console without an account (defaults: adult, Standard, no birth year). */
  role?: MemberRole;
  mode?: ProtectionMode;
  birthYear?: number | null;
  /** Console edits. */
  helperMemberIds?: string[];
  updatedAt?: Date;
}

const g = globalThis as typeof globalThis & {
  __neoMemoryProtection?: Map<string, MemoryProtection>;
  __neoMemoryContactMembers?: Map<string, MemoryContactMember[]>;
  __neoMemoryMemberPolicies?: Map<string, unknown[]>;
  __neoMemoryTimeZones?: Map<string, string>;
  __neoMemoryConsents?: MemoryConsent[];
};

function state() {
  g.__neoMemoryProtection ??= new Map();
  return g.__neoMemoryProtection;
}

export function resetMemoryProtection(): void {
  g.__neoMemoryProtection = undefined;
  g.__neoMemoryContactMembers = undefined;
  g.__neoMemoryMemberPolicies = undefined;
  g.__neoMemoryTimeZones = undefined;
  g.__neoMemoryConsents = undefined;
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

/** The stable `members` row id of an account holder, assigned on first use (the twin of ensureMemberForUserTx). */
export function memoryMemberIdForUser(tenantId: string, userId: string): string {
  const key = `${tenantId}:${userId}`;
  const p = state().get(key);
  if (p?.memberId) return p.memberId;
  const memberId = crypto.randomUUID();
  state().set(key, { mode: p?.mode ?? "standard", helperMemberIds: p?.helperMemberIds ?? [], ...(p ?? {}), memberId });
  return memberId;
}

/** A member by row id, with or without an account (the twin of a `members` lookup); undefined when unknown. */
export function memoryMemberById(tenantId: string, memberId: string): { id: string; userId: string | null; displayName: string } | undefined {
  const m = memoryMemberRecords(tenantId).find((x) => x.id === memberId);
  return m && { id: m.id, userId: m.userId, displayName: m.displayName };
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

// ─── Console twin (lib/server/member-console.ts) ──────────────────

/** A member as the console edits it: the in-memory twin of a `members` row. */
export interface MemoryMemberRecord {
  id: string;
  userId: string | null;
  displayName: string;
  role: MemberRole;
  mode: ProtectionMode;
  helperMemberIds: string[];
  birthYear: number | null;
  /** The helper contact address; never persisted, memory only. */
  contact: string | null;
  email: string | null;
  updatedAt: Date;
}

const EPOCH = new Date(0);

/** Account members (given a stable id on first sight) then contact-only members, as `members` rows. */
export function memoryMemberRecords(tenantId: string): MemoryMemberRecord[] {
  const accounts = memoryListMembers(tenantId).map((m): MemoryMemberRecord => {
    let p = state().get(`${tenantId}:${m.userId}`);
    if (!p?.memberId) {
      p = { mode: p?.mode ?? "standard", helperMemberIds: p?.helperMemberIds ?? [], ...(p ?? {}), memberId: crypto.randomUUID() };
      state().set(`${tenantId}:${m.userId}`, p);
    }
    return {
      id: p.memberId!,
      userId: m.userId,
      displayName: p.displayName ?? (m.name || m.email?.split("@")[0] || "Member"),
      role: p.role ?? (m.role === "owner" ? "owner" : "adult"),
      mode: p.mode,
      helperMemberIds: p.helperMemberIds,
      birthYear: p.birthYear ?? null,
      contact: null,
      email: m.email,
      updatedAt: p.updatedAt ?? EPOCH,
    };
  });
  const contacts = memoryContactMembers(tenantId).map(
    (c): MemoryMemberRecord => ({
      id: c.id,
      userId: null,
      displayName: c.displayName,
      role: c.role ?? "adult",
      mode: c.mode ?? "standard",
      helperMemberIds: c.helperMemberIds ?? [],
      birthYear: c.birthYear ?? null,
      contact: c.contact || null,
      email: null,
      updatedAt: c.updatedAt ?? EPOCH,
    }),
  );
  return [...accounts, ...contacts];
}

export interface MemoryMemberPatch {
  displayName?: string;
  role?: MemberRole;
  mode?: ProtectionMode;
  helperMemberIds?: string[];
  birthYear?: number | null;
  contact?: string | null;
}

/** Apply a console edit; undefined when the member is unknown. The caller has validated the patch. */
export function memoryUpdateMember(tenantId: string, memberId: string, patch: MemoryMemberPatch): MemoryMemberRecord | undefined {
  const current = memoryMemberRecords(tenantId).find((m) => m.id === memberId);
  if (!current) return undefined;
  const now = new Date();
  if (current.userId !== null) {
    const key = `${tenantId}:${current.userId}`;
    const p = state().get(key)!;
    state().set(key, {
      ...p,
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.helperMemberIds !== undefined ? { helperMemberIds: patch.helperMemberIds } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.birthYear !== undefined ? { birthYear: patch.birthYear } : {}),
      updatedAt: now,
    });
  } else {
    const c = memoryContactMembers(tenantId).find((x) => x.id === memberId);
    if (c) {
      if (patch.displayName !== undefined) c.displayName = patch.displayName;
      if (patch.role !== undefined) c.role = patch.role;
      if (patch.mode !== undefined) c.mode = patch.mode;
      if (patch.birthYear !== undefined) c.birthYear = patch.birthYear;
      if (patch.helperMemberIds !== undefined) c.helperMemberIds = patch.helperMemberIds;
      if (patch.contact !== undefined) c.contact = patch.contact ?? "";
      c.updatedAt = now;
    }
  }
  return memoryMemberRecords(tenantId).find((m) => m.id === memberId);
}

/** Member-scope policy versions (oldest first). */
export function memoryMemberPolicyVersions(tenantId: string, memberId: string): unknown[] {
  return g.__neoMemoryMemberPolicies?.get(`${tenantId}:${memberId}`) ?? [];
}

export function memoryInsertMemberPolicy(tenantId: string, memberId: string, rules: unknown): number {
  g.__neoMemoryMemberPolicies ??= new Map();
  const list = [...memoryMemberPolicyVersions(tenantId, memberId), rules];
  g.__neoMemoryMemberPolicies.set(`${tenantId}:${memberId}`, list);
  return list.length;
}

/** Create a member without an account (the twin of `createMemberWithoutAccount` in @neo/db; the caller has validated the input). */
export function memoryCreateMemberWithoutAccount(
  tenantId: string,
  input: { displayName: string; role: MemberRole; birthYear: number | null; contact: string | null },
): MemoryMemberRecord {
  const member: MemoryContactMember = { id: crypto.randomUUID(), displayName: input.displayName, contact: input.contact ?? "", role: input.role, mode: "standard", birthYear: input.birthYear, updatedAt: new Date() };
  addMemoryContactMember(tenantId, member);
  return memoryMemberRecords(tenantId).find((m) => m.id === member.id)!;
}

/** The household's IANA time zone, or null while unset. */
export function memoryHouseholdTimeZone(tenantId: string): string | null {
  return g.__neoMemoryTimeZones?.get(tenantId) ?? null;
}

export function memorySetHouseholdTimeZone(tenantId: string, timeZone: string | null): void {
  g.__neoMemoryTimeZones ??= new Map();
  if (timeZone === null) g.__neoMemoryTimeZones.delete(tenantId);
  else g.__neoMemoryTimeZones.set(tenantId, timeZone);
}

export interface MemoryConsent {
  tenantId: string;
  memberId: string;
  kind: string;
  grantedBy: string | null;
  grantedAt: Date;
  evidence: Record<string, unknown>;
}

export function memoryRecordConsent(consent: Omit<MemoryConsent, "grantedAt">): void {
  g.__neoMemoryConsents ??= [];
  g.__neoMemoryConsents.push({ ...consent, grantedAt: new Date() });
}

export function memoryConsents(tenantId: string, memberId: string): MemoryConsent[] {
  return (g.__neoMemoryConsents ?? []).filter((c) => c.tenantId === tenantId && c.memberId === memberId);
}
