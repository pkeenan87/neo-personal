/**
 * The owner's member console (_specs/v2-m1-elder.md section 8): members, protection mode, helpers,
 * helper contact and notify thresholds. Postgres via @neo/db when DATABASE_URL is set, else the
 * memory twin in memory-members.ts. Route handlers stay thin: the owner check (re-read from the
 * database by `requireHouseholdAdmin`), validation, limits, audit and the Elder-off email live here,
 * and every failure comes back as `{ ok: false, status, code, message }`.
 *
 * Audit metadata never carries a contact address; the address is encrypted at rest (members.ts).
 */
import { ageBandInfo, childDefaults, effectivePolicy, logger } from "@neo/core";
import {
  MAX_HELPERS_PER_MEMBER,
  MAX_MEMBERS_WITHOUT_ACCOUNT,
  countHouseholdOwners,
  createMemberWithoutAccount,
  getHouseholdTimeZone,
  getMemberContact,
  insertPolicyVersion,
  latestMemberRules,
  listAlertOwners,
  listMemberRecords,
  normalizeContact,
  normalizeDisplayName,
  normalizeTimeZone,
  recordConsent,
  setHouseholdTimeZone,
  tenantScoped,
  updateMember,
  type Member,
  type MemberPatch,
  type MemberRole,
} from "@neo/db";
import {
  AppsRulesSchema,
  CHILD_REQUEST_TARGETS,
  PolicyRulesSchema,
  SEVERITIES,
  ScreenTimeRulesSchema,
  WEEKDAYS,
  WebRulesSchema,
  type PolicyRules,
} from "@neo/verdict";
import { z } from "zod";
import { inboundEnv } from "@/lib/env";
import {
  type ChildSettings,
  type ChildView,
  type CreatableMemberRole,
  type MemberDeviceItem,
  type HouseholdTimeZoneResponse,
  type MemberDetailResponse,
  type MemberListResponse,
  type MemberModeName,
  type MemberProfile,
  type MemberRoleName,
  type NotifySeverity,
} from "@/lib/member-types";
import { describePolicy, maskEmail } from "@/lib/policy-summary";
import { recordAudit } from "./audit";
import { deviceStatus, listDevices } from "./devices";
import { currentPolicyVersion, devicePolicyState } from "./policy-bundles";
import { getDb } from "./db";
import { renderChildModeOffEmail, renderElderModeOffEmail } from "./email/household-email";
import { getMailer } from "./email/resend";
import { requireHouseholdAdmin, type HouseholdActor } from "./household-admin";
import type { Outcome } from "./household";
import { memoryAlertOwners } from "./memory-alerts";
import {
  memoryCreateMemberWithoutAccount,
  memoryHouseholdTimeZone,
  memoryInsertMemberPolicy,
  memoryMemberPolicyVersions,
  memoryMemberRecords,
  memoryRecordConsent,
  memorySetHouseholdTimeZone,
  memoryUpdateMember,
} from "./memory-members";

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
  birthYear: number | null;
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
  create(input: { displayName: string; role: CreatableMemberRole; birthYear: number | null; contact: string | null }): Promise<Rec>;
  timeZone(): Promise<string | null>;
  setTimeZone(timeZone: string): Promise<void>;
  recordConsent(memberId: string, grantedBy: string, evidence: Record<string, unknown>): Promise<void>;
}

const fromMember = (m: Member): Rec => ({
  id: m.id,
  userId: m.userId,
  displayName: m.displayName,
  role: m.role,
  mode: m.mode,
  helperMemberIds: m.helperMemberIds,
  hasContact: m.hasContact,
  birthYear: m.birthYear,
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
      create: async (input) => fromMember(await createMemberWithoutAccount(tdb, input)),
      timeZone: async () => (await getHouseholdTimeZone(db, tenantId)) ?? null,
      setTimeZone: async (timeZone) => {
        await setHouseholdTimeZone(db, tenantId, timeZone);
      },
      recordConsent: async (memberId, grantedBy, evidence) => {
        await recordConsent(tdb, { memberId, kind: "monitoring_notice", grantedBy, evidence });
      },
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
    birthYear: m.birthYear,
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
    create: async (input) => toRec(memoryCreateMemberWithoutAccount(tenantId, input)),
    timeZone: async () => memoryHouseholdTimeZone(tenantId),
    setTimeZone: async (timeZone) => memorySetHouseholdTimeZone(tenantId, timeZone),
    recordConsent: async (memberId, grantedBy, evidence) => memoryRecordConsent({ tenantId, memberId, kind: "monitoring_notice", grantedBy, evidence }),
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
  birthYear: r.birthYear,
});

/** Validated stored member-layer rules, or {} when none or unreadable (a bad layer never counts). */
function parseRules(raw: unknown): PolicyRules {
  const parsed = PolicyRulesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

const DEFAULT_NOTIFY: NotifySeverity = "high";

/** The settings an editor shows: every Child field filled from an effective policy. */
function childSettings(rules: PolicyRules): ChildSettings {
  const d = childDefaults();
  const web = rules.web ?? d.web!;
  const apps = rules.apps ?? d.apps!;
  const st = rules.screenTime ?? d.screenTime!;
  const dm = st.dailyMinutes ?? {};
  return {
    web: { categories: web.categories ?? [], safeSearch: web.safeSearch ?? true, youtubeRestricted: web.youtubeRestricted ?? "moderate", allow: web.allow ?? [], block: web.block ?? [] },
    apps: { block: apps.block ?? [], requireApproval: apps.requireApproval ?? false, approved: apps.approved ?? [] },
    screenTime: {
      dailyMinutes: Object.fromEntries(WEEKDAYS.map((day) => [day, dm[day] ?? null])) as ChildSettings["screenTime"]["dailyMinutes"],
      downtime: st.downtime ?? [],
      warnMinutes: st.warnMinutes ?? 10,
      allowDuringDowntime: st.allowDuringDowntime ?? [],
    },
    childRequestsTo: rules.notify?.childRequestsTo ?? "owners",
  };
}

async function childView(store: Store, rec: Rec, memberRaw: unknown): Promise<ChildView> {
  const timeZone = await store.timeZone();
  const now = new Date();
  const info = ageBandInfo(rec.birthYear, now, timeZone);
  const own = parseRules(memberRaw);
  const customized = own.web !== undefined || own.apps !== undefined || own.screenTime !== undefined || own.notify?.childRequestsTo !== undefined;
  return {
    birthYear: rec.birthYear,
    band: info.band,
    bandAssumed: info.assumed,
    adult: info.adult,
    timeZone,
    defaults: childSettings(childDefaults(info.band)),
    settings: childSettings(effectivePolicy({ mode: "child", birthYear: rec.birthYear, timeZone, now, member: memberRaw })),
    customized,
  };
}

async function detail(store: Store, all: Rec[], rec: Rec, tenantId: string): Promise<MemberDetailResponse> {
  const memberRaw = await store.memberRules(rec.id);
  const timeZone = rec.mode === "child" ? await store.timeZone() : null;
  const rules = effectivePolicy({ mode: rec.mode, birthYear: rec.birthYear, timeZone, member: memberRaw });
  const address = rec.hasContact ? await store.contact(rec.id).catch(() => null) : null;
  return {
    member: profile(rec),
    contactHint: address ? maskEmail(address) : null,
    others: all.filter((m) => m.id !== rec.id).map((m) => ({ id: m.id, displayName: m.displayName, hasAccount: m.userId !== null })),
    notify: { helpersNotifyAt: rules.notify?.helpersNotifyAt ?? DEFAULT_NOTIFY, ownersNotifyAt: rules.notify?.ownersNotifyAt ?? DEFAULT_NOTIFY },
    policySummary: describePolicy(rec.mode, rules),
    child: await childView(store, rec, memberRaw),
    isLastOwner: rec.role === "owner" && (await store.ownerCount()) <= 1,
    devices: await memberDevices(tenantId, rec),
  };
}

/**
 * The member's active devices with whether each has applied the current policy bundle. A failure to
 * read devices or compile the policy leaves the list out rather than failing the page.
 */
async function memberDevices(tenantId: string, rec: Rec): Promise<MemberDeviceItem[]> {
  try {
    const devices = await listDevices(tenantId, { memberId: rec.id });
    const now = new Date();
    return await Promise.all(
      devices.map(async (d): Promise<MemberDeviceItem> => {
        const current = await currentPolicyVersion(d, now).catch(() => null);
        return {
          id: d.id,
          name: d.name,
          kind: d.kind,
          platform: d.platform,
          status: deviceStatus(d, now),
          lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
          policy: devicePolicyState(rec.mode, d.policyVersionApplied, current),
        };
      }),
    );
  } catch (err) {
    logger.error("Member devices unavailable", "household", { tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    return [];
  }
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
    return rec ? { ok: true, value: await detail(store, all, rec, actor.tenantId) } : NOT_FOUND;
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
    // Absent keeps it; an explicit null clears it.
    birthYear: z.number().int().nullable().optional(),
    // A blank string is absent; an explicit null clears the stored address.
    contact: z.string().max(300).nullable().optional(),
  })
  .strict();

/**
 * Send the templated "<Elder|Child> mode was turned off" email to every owner. Best effort; never throws.
 * The idempotency key names the transition it follows (the row's previous update time), so a double
 * submit or two racing requests share it and the mailer sends once; a later off-switch has a new key.
 */
async function emailOwnersModeOff(actor: HouseholdActor, store: Store, rec: Rec, previous: Rec, mode: "elder" | "child"): Promise<void> {
  const label = mode === "elder" ? "Elder" : "Child";
  try {
    const mailer = getMailer();
    if (!mailer) return;
    const owners = await store.owners();
    const changedBy = owners.find((o) => o.userId === actor.userId)?.name ?? null;
    const url = `${inboundEnv().APP_URL}/settings/household/members/${rec.id}`;
    const mail = (mode === "elder" ? renderElderModeOffEmail : renderChildModeOffEmail)({ memberName: rec.displayName, changedByName: changedBy, url });
    for (const o of owners) {
      if (!o.email) continue;
      await mailer
        .send({ to: o.email, ...mail, idempotencyKey: `${mode}-off:${rec.id}:${previous.updatedAt.getTime()}:${o.userId}` })
        .catch((err: unknown) =>
          logger.error(`${label}-off email failed`, "household", { tenantId: actor.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) }),
        );
    }
  } catch (err) {
    logger.error(`${label}-off email failed`, "household", { tenantId: actor.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
}

/** A birth year that can belong to a living person this year (the year is UTC, as in @neo/db `updateMember`). */
function validBirthYear(y: number): boolean {
  return y >= 1900 && y <= new Date().getUTCFullYear();
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
    if (input.birthYear !== undefined && input.birthYear !== current.birthYear) {
      if (input.birthYear !== null && !validBirthYear(input.birthYear)) return fail(400, "invalid_birth_year", "Enter a four-digit birth year.");
      patch.birthYear = input.birthYear;
      fields.push("birthYear");
    }
    let consentBand: string | undefined;
    if (input.mode !== undefined && input.mode !== current.mode) {
      if (input.mode === "child") {
        // Child mode needs a birth year (for the age band) and the household time zone (for screen time and downtime).
        const birthYear = patch.birthYear !== undefined ? patch.birthYear : current.birthYear;
        if (birthYear === null) return fail(400, "birth_year_required", `Enter ${current.displayName}'s birth year to turn on Child mode.`);
        const timeZone = await store.timeZone();
        if (!timeZone) return fail(400, "time_zone_required", "Confirm your household's time zone before turning on Child mode.");
        consentBand = ageBandInfo(birthYear, new Date(), timeZone).band;
      }
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

    if (Object.keys(patch).length === 0) return { ok: true, value: await detail(store, all, current, actor.tenantId) };

    // The household acknowledges the monitoring before it starts. Appended first: if the update below
    // fails the notice stays on record, which is harmless, whereas Child mode without one is not.
    if (consentBand !== undefined) {
      await store.recordConsent(current.id, actor.userId, { mode: "child", band: consentBand });
      await recordAudit(actor.tenantId, actor.userId, "member.consent_recorded", { memberId: current.id, kind: "monitoring_notice" });
    }

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
    if ((current.mode === "elder" || current.mode === "child") && patch.mode !== undefined) await emailOwnersModeOff(actor, store, updated, current, current.mode);

    const fresh = await store.list();
    return { ok: true, value: await detail(store, fresh, fresh.find((m) => m.id === current.id) ?? updated, actor.tenantId) };
  });
}

// ─── PUT policy ────────────────────────────────────────────────────

const Sev = z.enum(SEVERITIES).or(z.literal("")).nullish();

/**
 * A section of the Child policy as the console sends it: the whole section (replacing the member's own
 * copy of it) or `null` (drop the member's own copy, so the age-band defaults apply again). Unknown
 * keys are errors here, though `PolicyRulesSchema` strips them when reading a stored layer.
 */
const PolicySchema = z
  .object({
    helpersNotifyAt: Sev,
    ownersNotifyAt: Sev,
    childRequestsTo: z.enum(CHILD_REQUEST_TARGETS).or(z.literal("")).nullish(),
    web: WebRulesSchema.strict().nullish(),
    apps: AppsRulesSchema.strict().nullish(),
    screenTime: ScreenTimeRulesSchema.strict().nullish(),
  })
  .strict();

const isSet = (v: unknown): boolean => v !== undefined && v !== "";

/**
 * Set the policy of one member. Stored as the next `member`-scope policy version: the member's current
 * member-layer rules with the changes merged over them, validated by `PolicyRulesSchema`. A blank or
 * absent field keeps its value; an explicit `null` removes the member's own setting (the mode default
 * applies again). `web`, `apps` and `screenTime` replace their whole section. Nothing is written when
 * nothing changes. A validation failure is 400 `invalid_policy` with `fields` naming each bad path.
 */
export async function putMemberPolicy(actor: HouseholdActor, id: string, body: Record<string, unknown> | null): Promise<Outcome<MemberDetailResponse>> {
  return adminOr(actor, async () => {
    if (!UUID_RE.test(id)) return NOT_FOUND;
    const parsed = PolicySchema.safeParse(body);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
      return { ok: false, status: 400, code: "invalid_policy", message: "Some of these settings are not valid.", fields };
    }
    const store = storeFor(actor.tenantId);
    const all = await store.list();
    const rec = all.find((m) => m.id === id.toLowerCase());
    if (!rec) return NOT_FOUND;

    const input = parsed.data;
    const sections = ["web", "apps", "screenTime"] as const;
    if (![input.helpersNotifyAt, input.ownersNotifyAt, input.childRequestsTo].some(isSet) && !sections.some((k) => input[k] !== undefined)) {
      return fail(400, "invalid", "Choose at least one setting to change.");
    }
    const before = parseRules(await store.memberRules(rec.id));
    const next: Record<string, unknown> = { ...before };
    const notify: NonNullable<PolicyRules["notify"]> = { ...before.notify };
    const changed: Record<string, string | null> = {};
    for (const [key, value] of [["helpersNotifyAt", input.helpersNotifyAt], ["ownersNotifyAt", input.ownersNotifyAt], ["childRequestsTo", input.childRequestsTo]] as const) {
      if (value === undefined || value === "") continue;
      if (value === null) {
        if (notify[key] !== undefined) {
          delete notify[key];
          changed[key] = null;
        }
      } else if (notify[key] !== value) {
        (notify as Record<string, string>)[key] = value;
        changed[key] = value;
      }
    }
    if (Object.keys(notify).length > 0) next.notify = notify;
    else delete next.notify;
    for (const key of sections) {
      const value = input[key];
      if (value === undefined) continue;
      if (value === null) {
        if (before[key] !== undefined) {
          delete next[key];
          changed[key] = null;
        }
      } else if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
        next[key] = value;
        changed[key] = "set";
      }
    }
    if (Object.keys(changed).length > 0) {
      const valid = PolicyRulesSchema.safeParse(next);
      if (!valid.success) return INVALID;
      const version = await store.insertPolicy(rec.id, valid.data, actor.userId);
      // Audit metadata names what changed, never the lists themselves.
      await recordAudit(actor.tenantId, actor.userId, "member.policy_changed", { memberId: rec.id, version, ...changed });
    }
    return { ok: true, value: await detail(store, all, rec, actor.tenantId) };
  });
}

// ─── POST (create a member without an account) ─────────────────────

const CreateSchema = z
  .object({
    displayName: z.string().max(200),
    role: z.enum(["adult", "child", "elder"]),
    birthYear: z.number().int().nullish(),
    contact: z.string().max(300).nullish(),
  })
  .strict();

/**
 * Create a member who has no account (_specs/v2-m2-child.md section 2): a display name, a role (adult,
 * child or elder), a birth year for a child, and an optional contact email for an adult or elder (who
 * can then be a helper). They start in Standard mode. 400 `invalid`, `invalid_name`, `invalid_birth_year`,
 * `birth_year_required`, `invalid_email`, `contact_not_allowed`; 409 `member_limit`.
 */
export async function createProtectedMember(actor: HouseholdActor, body: Record<string, unknown> | null): Promise<Outcome<MemberDetailResponse>> {
  return adminOr(actor, async () => {
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return INVALID;
    const input = parsed.data;
    const displayName = normalizeDisplayName(input.displayName);
    if (!displayName) return fail(400, "invalid_name", "Enter a name of up to 80 characters.");
    const birthYear = input.birthYear ?? null;
    if (birthYear !== null && !validBirthYear(birthYear)) return fail(400, "invalid_birth_year", "Enter a four-digit birth year.");
    if (input.role === "child" && birthYear === null) return fail(400, "birth_year_required", "Enter the child's birth year.");
    let contact: string | null = null;
    if (input.contact !== undefined && input.contact !== null && input.contact.trim() !== "") {
      if (input.role === "child") return fail(400, "contact_not_allowed", "Neo doesn't email children. Add the email of an adult or elder.");
      if (!normalizeContact(input.contact)) return fail(400, "invalid_email", "Enter one email address.");
      contact = input.contact;
    }
    const store = storeFor(actor.tenantId);
    const all = await store.list();
    if (all.filter((m) => m.userId === null).length >= MAX_MEMBERS_WITHOUT_ACCOUNT) {
      return fail(409, "member_limit", `A household can have up to ${MAX_MEMBERS_WITHOUT_ACCOUNT} people without an account.`);
    }
    let created: Rec;
    try {
      created = await store.create({ displayName, role: input.role as MemberRole & CreatableMemberRole, birthYear, contact });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("@neo/db: too many")) return fail(409, "member_limit", `A household can have up to ${MAX_MEMBERS_WITHOUT_ACCOUNT} people without an account.`);
      if (err instanceof Error && err.message.startsWith("@neo/db:")) return INVALID;
      throw err;
    }
    await recordAudit(actor.tenantId, actor.userId, "member.created", { memberId: created.id, role: created.role, hasBirthYear: birthYear !== null, hasContact: contact !== null });
    const fresh = await store.list();
    return { ok: true, value: await detail(store, fresh, fresh.find((m) => m.id === created.id) ?? created, actor.tenantId) };
  });
}

// ─── PUT time zone ─────────────────────────────────────────────────

const TimeZoneSchema = z.object({ timeZone: z.string().max(100) }).strict();

/**
 * Set the household's IANA time zone, which screen time, downtime and a child's age band use. Owner only.
 * 400 `invalid` (not an object with a string `timeZone`) or `invalid_time_zone` (not an IANA zone name).
 */
export async function putHouseholdTimeZone(actor: HouseholdActor, body: Record<string, unknown> | null): Promise<Outcome<HouseholdTimeZoneResponse>> {
  return adminOr(actor, async () => {
    const parsed = TimeZoneSchema.safeParse(body);
    if (!parsed.success) return INVALID;
    const timeZone = normalizeTimeZone(parsed.data.timeZone);
    if (!timeZone) return fail(400, "invalid_time_zone", "Choose a time zone such as America/New_York.");
    const store = storeFor(actor.tenantId);
    const before = await store.timeZone();
    if (before !== timeZone) {
      await store.setTimeZone(timeZone);
      await recordAudit(actor.tenantId, actor.userId, "household.time_zone_changed", { from: before, to: timeZone });
    }
    return { ok: true, value: { timeZone } };
  });
}
