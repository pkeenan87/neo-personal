/**
 * The owner's member console (_specs/v2-m1-elder.md section 8): members, protection mode, helpers,
 * helper contact and notify thresholds. Postgres via @neo/db when DATABASE_URL is set, else the
 * memory twin in memory-members.ts. Route handlers stay thin: the owner check (re-read from the
 * database by `requireHouseholdAdmin`), validation, limits, audit and the Elder-off email live here,
 * and every failure comes back as `{ ok: false, status, code, message }`.
 *
 * Audit metadata never carries a contact address; the address is encrypted at rest (members.ts).
 */
import { effectivePolicy, logger } from "@neo/core";
import {
  MAX_HELPERS_PER_MEMBER,
  countHouseholdOwners,
  getMemberContact,
  insertPolicyVersion,
  latestMemberRules,
  listAlertOwners,
  listMemberRecords,
  normalizeContact,
  normalizeDisplayName,
  tenantScoped,
  updateMember,
  type Member,
  type MemberPatch,
} from "@neo/db";
import { PolicyRulesSchema, SEVERITIES, type PolicyRules } from "@neo/verdict";
import { z } from "zod";
import { inboundEnv } from "@/lib/env";
import {
  type MemberDetailResponse,
  type MemberListResponse,
  type MemberModeName,
  type MemberProfile,
  type MemberRoleName,
  type NotifySeverity,
} from "@/lib/member-types";
import { describePolicy, maskEmail } from "@/lib/policy-summary";
import { recordAudit } from "./audit";
import { getDb } from "./db";
import { renderElderModeOffEmail } from "./email/household-email";
import { getMailer } from "./email/resend";
import { requireHouseholdAdmin, type HouseholdActor } from "./household-admin";
import type { Outcome } from "./household";
import { memoryAlertOwners } from "./memory-alerts";
import { memoryInsertMemberPolicy, memoryMemberPolicyVersions, memoryMemberRecords, memoryUpdateMember } from "./memory-members";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, code: string, message: string): Outcome<never> {
  return { ok: false, status, code, message };
}

const NOT_FOUND = fail(404, "not_found", "That person is not in your household.");
const INVALID = fail(400, "invalid", "Check the details and try again.");

/** A member row plus what the console needs beside it. */
interface Rec {
  id: string;
  userId: string | null;
  displayName: string;
  role: MemberRoleName;
  mode: MemberModeName;
  helperMemberIds: string[];
  hasContact: boolean;
  updatedAt: Date;
}

interface Store {
  list(): Promise<Rec[]>;
  ownerCount(): Promise<number>;
  update(id: string, patch: MemberPatch): Promise<Rec | undefined>;
  contact(id: string): Promise<string | null>;
  memberRules(id: string): Promise<unknown>;
  insertPolicy(id: string, rules: unknown, createdBy: string): Promise<number>;
  owners(): Promise<{ userId: string; email: string | null; name: string | null }[]>;
}

const fromMember = (m: Member): Rec => ({
  id: m.id,
  userId: m.userId,
  displayName: m.displayName,
  role: m.role,
  mode: m.mode,
  helperMemberIds: m.helperMemberIds,
  hasContact: m.hasContact,
  updatedAt: m.updatedAt,
});

function storeFor(tenantId: string): Store {
  const db = getDb();
  if (db) {
    const tdb = tenantScoped(db, tenantId);
    return {
      list: async () => (await listMemberRecords(tdb)).map(fromMember),
      ownerCount: () => countHouseholdOwners(tdb),
      update: async (id, patch) => {
        const m = await updateMember(tdb, id, patch);
        return m && fromMember(m);
      },
      contact: (id) => getMemberContact(tdb, id),
      memberRules: (id) => latestMemberRules(tdb, id),
      insertPolicy: async (id, rules, createdBy) => (await insertPolicyVersion(tdb, { scope: "member", scopeId: id, rules, createdBy })).version,
      owners: () => listAlertOwners(db, tenantId),
    };
  }
  const toRec = (m: ReturnType<typeof memoryMemberRecords>[number]): Rec => ({
    id: m.id,
    userId: m.userId,
    displayName: m.displayName,
    role: m.role,
    mode: m.mode,
    helperMemberIds: m.helperMemberIds,
    hasContact: m.contact !== null,
    updatedAt: m.updatedAt,
  });
  return {
    list: async () => memoryMemberRecords(tenantId).map(toRec),
    ownerCount: async () => memoryMemberRecords(tenantId).filter((m) => m.role === "owner").length,
    update: async (id, patch) => {
      const m = memoryUpdateMember(tenantId, id, patch);
      return m && toRec(m);
    },
    contact: async (id) => memoryMemberRecords(tenantId).find((m) => m.id === id)?.contact ?? null,
    memberRules: async (id) => memoryMemberPolicyVersions(tenantId, id).at(-1),
    insertPolicy: async (id, rules) => memoryInsertMemberPolicy(tenantId, id, rules),
    owners: async () => memoryAlertOwners(tenantId),
  };
}

const profile = (r: Rec): MemberProfile => ({
  id: r.id,
  displayName: r.displayName,
  role: r.role,
  mode: r.mode,
  hasAccount: r.userId !== null,
  helperMemberIds: r.helperMemberIds,
  hasContact: r.hasContact,
});

/** Validated stored member-layer rules, or {} when none or unreadable (a bad layer never counts). */
function parseRules(raw: unknown): PolicyRules {
  const parsed = PolicyRulesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

const DEFAULT_NOTIFY: NotifySeverity = "high";

async function detail(store: Store, all: Rec[], rec: Rec): Promise<MemberDetailResponse> {
  const rules = effectivePolicy({ mode: rec.mode, member: await store.memberRules(rec.id) });
  const address = rec.hasContact ? await store.contact(rec.id).catch(() => null) : null;
  return {
    member: profile(rec),
    contactHint: address ? maskEmail(address) : null,
    others: all.filter((m) => m.id !== rec.id).map((m) => ({ id: m.id, displayName: m.displayName, hasAccount: m.userId !== null })),
    notify: { helpersNotifyAt: rules.notify?.helpersNotifyAt ?? DEFAULT_NOTIFY, ownersNotifyAt: rules.notify?.ownersNotifyAt ?? DEFAULT_NOTIFY },
    policySummary: describePolicy(rec.mode, rules),
    isLastOwner: rec.role === "owner" && (await store.ownerCount()) <= 1,
  };
}

async function adminOr<T>(actor: HouseholdActor, fn: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  const admin = await requireHouseholdAdmin(actor);
  return admin.ok ? fn() : admin;
}

// ─── Reads ─────────────────────────────────────────────────────────

export async function listMemberProfiles(actor: HouseholdActor): Promise<Outcome<MemberListResponse>> {
  return adminOr(actor, async () => ({ ok: true, value: { members: (await storeFor(actor.tenantId).list()).map(profile) } }));
}

export async function getMemberDetail(actor: HouseholdActor, id: string): Promise<Outcome<MemberDetailResponse>> {
  return adminOr(actor, async () => {
    if (!UUID_RE.test(id)) return NOT_FOUND;
    const store = storeFor(actor.tenantId);
    const all = await store.list();
    const rec = all.find((m) => m.id === id.toLowerCase());
    return rec ? { ok: true, value: await detail(store, all, rec) } : NOT_FOUND;
  });
}

// ─── PATCH ─────────────────────────────────────────────────────────

const text = (max: number) => z.string().max(max).nullish().transform((v) => (v === null || v === undefined || v.trim() === "" ? undefined : v));

const PatchSchema = z
  .object({
    displayName: text(200),
    role: z.enum(["owner", "adult", "child", "elder"]).or(z.literal("")).nullish().transform((v) => (v ? v : undefined)),
    mode: z.enum(["standard", "child", "elder"]).or(z.literal("")).nullish().transform((v) => (v ? v : undefined)),
    helperMemberIds: z.array(z.string().regex(UUID_RE)).max(MAX_HELPERS_PER_MEMBER).nullish().transform((v) => v ?? undefined),
    // A blank string is absent; an explicit null clears the stored address.
    contact: z.string().max(300).nullable().optional(),
  })
  .strict();

/** Send the templated "Elder mode was turned off" email to every owner. Best effort; never throws. */
async function emailOwnersElderOff(actor: HouseholdActor, store: Store, rec: Rec, previous: Rec): Promise<void> {
  try {
    const mailer = getMailer();
    if (!mailer) return;
    const owners = await store.owners();
    const changedBy = owners.find((o) => o.userId === actor.userId)?.name ?? null;
    const url = `${inboundEnv().APP_URL}/settings/household/members/${rec.id}`;
    const mail = renderElderModeOffEmail({ memberName: rec.displayName, changedByName: changedBy, url });
    // The key names the transition it follows (the row's previous update time), so a double submit or
    // two racing requests share it and the mailer sends once; a later off-switch has a new key.
    for (const o of owners) {
      if (!o.email) continue;
      await mailer
        .send({ to: o.email, ...mail, idempotencyKey: `elder-off:${rec.id}:${previous.updatedAt.getTime()}:${o.userId}` })
        .catch((err: unknown) =>
          logger.error("Elder-off email failed", "household", { tenantId: actor.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) }),
        );
    }
  } catch (err) {
    logger.error("Elder-off email failed", "household", { tenantId: actor.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
}

export async function patchMember(actor: HouseholdActor, id: string, body: Record<string, unknown> | null): Promise<Outcome<MemberDetailResponse>> {
  return adminOr(actor, async () => {
    if (!UUID_RE.test(id)) return NOT_FOUND;
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return INVALID;
    const input = parsed.data;
    const store = storeFor(actor.tenantId);
    const all = await store.list();
    const current = all.find((m) => m.id === id.toLowerCase());
    if (!current) return NOT_FOUND;

    const patch: MemberPatch = {};
    const fields: string[] = [];

    if (input.displayName !== undefined) {
      const name = normalizeDisplayName(input.displayName);
      if (!name) return fail(400, "invalid_name", "Enter a name of up to 80 characters.");
      if (name !== current.displayName) {
        patch.displayName = name;
        fields.push("displayName");
      }
    }
    if (input.role !== undefined && input.role !== current.role) {
      if ((input.role === "owner") !== (current.role === "owner")) {
        return fail(409, "owner_role", "The owner role cannot be given or taken away here.");
      }
      patch.role = input.role;
      fields.push("role");
    }
    if (input.mode !== undefined && input.mode !== current.mode) {
      if (input.mode === "child") return fail(400, "mode_unavailable", "Child mode is coming soon.");
      if (input.mode !== "standard" && current.role === "owner" && (await store.ownerCount()) <= 1) {
        return fail(409, "last_owner", "The only owner has to stay in Standard mode.");
      }
      patch.mode = input.mode;
    }
    let helpersChange: { added: number; removed: number } | undefined;
    if (input.helperMemberIds !== undefined) {
      const ids = [...new Set(input.helperMemberIds.map((h) => h.toLowerCase()))];
      if (ids.includes(current.id)) return fail(400, "invalid_helper", "A person can't be their own helper.");
      const known = new Set(all.map((m) => m.id));
      if (ids.some((h) => !known.has(h))) return fail(400, "invalid_helper", "Helpers must be people in this household.");
      const before = new Set(current.helperMemberIds);
      const added = ids.filter((h) => !before.has(h)).length;
      const removed = current.helperMemberIds.filter((h) => !ids.includes(h)).length;
      if (added + removed > 0) {
        patch.helperMemberIds = ids;
        helpersChange = { added, removed };
      }
    }
    if (input.contact !== undefined) {
      if (current.userId !== null) return fail(400, "has_account", "This person has an account, so Neo emails their account address.");
      if (input.contact === null) {
        if (current.hasContact) {
          patch.contact = null;
          fields.push("contact");
        }
      } else if (input.contact.trim() !== "") {
        if (!normalizeContact(input.contact)) return fail(400, "invalid_email", "Enter one email address.");
        patch.contact = input.contact;
        fields.push("contact");
      }
    }

    if (Object.keys(patch).length === 0) return { ok: true, value: await detail(store, all, current) };

    let updated: Rec | undefined;
    try {
      updated = await store.update(current.id, patch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      // updateMember's own validation (the checks above make these a backstop).
      if (msg.startsWith("@neo/db:")) return msg.includes("owner role") ? fail(409, "owner_role", "The owner role cannot be given or taken away here.") : INVALID;
      throw err;
    }
    if (!updated) return NOT_FOUND;

    if (fields.length > 0) await recordAudit(actor.tenantId, actor.userId, "member.updated", { memberId: current.id, fields });
    if (patch.mode !== undefined) await recordAudit(actor.tenantId, actor.userId, "member.mode_changed", { memberId: current.id, from: current.mode, to: patch.mode });
    if (helpersChange) await recordAudit(actor.tenantId, actor.userId, "member.helpers_changed", { memberId: current.id, count: updated.helperMemberIds.length, ...helpersChange });
    if (current.mode === "elder" && patch.mode !== undefined) await emailOwnersElderOff(actor, store, updated, current);

    const fresh = await store.list();
    return { ok: true, value: await detail(store, fresh, fresh.find((m) => m.id === current.id) ?? updated) };
  });
}

// ─── PUT policy ────────────────────────────────────────────────────

const Sev = z.enum(SEVERITIES).or(z.literal("")).nullish();

const PolicySchema = z.object({ helpersNotifyAt: Sev, ownersNotifyAt: Sev }).strict();

/**
 * Set the notify thresholds of one member. Stored as the next `member`-scope policy version: the
 * member's current member-layer rules with `notify` merged over them, validated by `PolicyRulesSchema`.
 * A blank or absent field keeps its value; an explicit `null` removes the member's own setting (the
 * mode default applies again). Nothing is written when nothing changes.
 */
export async function putMemberPolicy(actor: HouseholdActor, id: string, body: Record<string, unknown> | null): Promise<Outcome<MemberDetailResponse>> {
  return adminOr(actor, async () => {
    if (!UUID_RE.test(id)) return NOT_FOUND;
    const parsed = PolicySchema.safeParse(body);
    if (!parsed.success) return INVALID;
    const store = storeFor(actor.tenantId);
    const all = await store.list();
    const rec = all.find((m) => m.id === id.toLowerCase());
    if (!rec) return NOT_FOUND;

    const { helpersNotifyAt, ownersNotifyAt } = parsed.data;
    if ((helpersNotifyAt === undefined || helpersNotifyAt === "") && (ownersNotifyAt === undefined || ownersNotifyAt === "")) {
      return fail(400, "invalid", "Choose helpersNotifyAt, ownersNotifyAt or both.");
    }
    const before = parseRules(await store.memberRules(rec.id));
    const notify: NonNullable<PolicyRules["notify"]> = { ...before.notify };
    const changed: Record<string, string | null> = {};
    for (const [key, value] of [["helpersNotifyAt", helpersNotifyAt], ["ownersNotifyAt", ownersNotifyAt]] as const) {
      if (value === undefined || value === "") continue;
      if (value === null) {
        if (notify[key] !== undefined) {
          delete notify[key];
          changed[key] = null;
        }
      } else if (notify[key] !== value) {
        notify[key] = value;
        changed[key] = value;
      }
    }
    if (Object.keys(changed).length > 0) {
      const next = PolicyRulesSchema.safeParse({ ...before, notify });
      if (!next.success) return INVALID;
      const version = await store.insertPolicy(rec.id, next.data, actor.userId);
      await recordAudit(actor.tenantId, actor.userId, "member.policy_changed", { memberId: rec.id, version, ...changed });
    }
    return { ok: true, value: await detail(store, all, rec) };
  });
}
