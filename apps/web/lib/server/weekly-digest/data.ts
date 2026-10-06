import { alerts, devices, memberships, tenantScoped, users, verdicts, weeklyDigest, type Db } from "@neo/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { memoryAlertRows } from "../memory-alerts";
import { memoryListDevices } from "../memory-devices";
import { memoryListMembers, memoryVerdicts } from "../memory-state";
import { logger } from "@neo/core";
import { createDbHardeningStore, scoreMember, type HardeningStore } from "../hardening-score";
import { createMemoryHardeningStore } from "../memory-hardening";
import { selectDigestContent, type DigestContent, type DigestContentInput, type DigestContentStore, type HardeningScoreSlot } from "./content";
import { createMemoryWeeklyDigestStore, type DigestRecipientStore, type WeeklyDigestStore } from "./store";
export type DigestRecipient = { tenantId: string; userId: string; role: "owner" | "member"; email: string };
export interface DigestServices {
  store: WeeklyDigestStore; recipients: DigestRecipientStore; content: DigestContentStore;
  resolveRecipient(tenantId: string, userId: string): Promise<DigestRecipient | undefined>;
}
/**
 * The recipient's own hardening percentage and a link to Settings; no item detail, and never another
 * member's score. Omitted while there are not enough answers and when the score cannot be read.
 */
async function hardeningSlot(store: HardeningStore, tenantId: string, userId: string): Promise<HardeningScoreSlot | undefined> {
  try {
    const { scorePercent } = await scoreMember(store, tenantId, userId, new Date());
    return scorePercent === null ? undefined : { scorePercent, href: "/settings/hardening" };
  } catch {
    logger.warn("Weekly digest hardening score unavailable", "weekly-digest", { tenantId });
    return undefined;
  }
}
async function withHardening(content: DigestContent, store: HardeningStore, input: { tenantId: string; userId: string }): Promise<DigestContent> {
  const hardeningScore = await hardeningSlot(store, input.tenantId, input.userId);
  return hardeningScore ? { ...content, hardeningScore } : content;
}
export function createDbDigestServices(db: Db): DigestServices {
  const resolveRecipient: DigestServices["resolveRecipient"] = (tenantId, userId) => tenantScoped(db, tenantId).transaction(async t => {
    const member = await t.first(memberships, eq(memberships.userId, userId));
    if (!member?.weeklyDigestEnabled) return undefined;
    const [user] = await t.tx.select({ email: users.email, verified: users.emailVerified }).from(users).where(eq(users.id, userId));
    if (!user?.verified || !user.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) return undefined;
    return { tenantId, userId, role: member.role, email: user.email };
  });
  return {
    store: {
      getPreference: (...args) => weeklyDigest.getPreference(db, ...args),
      setPreference: (...args) => weeklyDigest.setPreference(db, ...args),
      getDelivery: (...args) => weeklyDigest.getDelivery(db, ...args),
      claimDelivery: input => weeklyDigest.claimDelivery(db, input),
      savePayload: input => weeklyDigest.savePayload(db, input),
      getPayload: input => weeklyDigest.getPayload(db, input),
      purgeStalePayloads: now => weeklyDigest.purgeStalePayloads(db, now),
      finishDelivery: input => weeklyDigest.finishDelivery(db, input),
    },
    recipients: { listDigestRecipientPairs: (cursor, limit = 1000) => weeklyDigest.listDigestRecipientPairs(db, { cursor, limit }) },
    resolveRecipient,
    content: {
      async loadDigestContent(input) {
        const base = await loadDbDigestContent(db, input);
        const recipient = await resolveRecipient(input.tenantId, input.userId);
        return recipient?.role === input.role ? withHardening(base, createDbHardeningStore(db), input) : base;
      },
    },
  };
}
async function loadDbDigestContent(db: Db, input: DigestContentInput): Promise<DigestContent> {
  return tenantScoped(db, input.tenantId).transaction(async t => {
    const member = await t.first(memberships, eq(memberships.userId, input.userId));
    if (!member?.weeklyDigestEnabled || member.role !== input.role) return {};
    const personal = await t.tx.select({ id: verdicts.id, userId: verdicts.userId, label: verdicts.verdict, headline: verdicts.headline, createdAt: verdicts.createdAt }).from(verdicts)
      .where(and(eq(verdicts.tenantId, input.tenantId), eq(verdicts.userId, input.userId), gte(verdicts.createdAt, input.periodStart), lt(verdicts.createdAt, input.periodEnd)));
    if (member.role === "member") return selectDigestContent(input, { members: [member], verdicts: personal, alerts: [], devices: [] });
    const members = await t.tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(eq(memberships.tenantId, input.tenantId));
    const householdAlerts = await t.tx.select({ id: alerts.id, subjectUserId: alerts.subjectUserId, kind: alerts.kind, severity: alerts.severity, createdAt: alerts.createdAt }).from(alerts)
      .where(and(eq(alerts.tenantId, input.tenantId), gte(alerts.createdAt, input.periodStart), lt(alerts.createdAt, input.periodEnd)));
    const householdDevices = await t.tx.select({ userId: devices.userId, lastSeenAt: devices.lastSeenAt, createdAt: devices.createdAt, revokedAt: devices.revokedAt }).from(devices).where(eq(devices.tenantId, input.tenantId));
    return selectDigestContent(input, { members, verdicts: personal, alerts: householdAlerts, devices: householdDevices });
  });
}
export async function resolveMemoryDigestRecipient(tenantId: string, userId: string): Promise<DigestRecipient | undefined> {
  const member = memoryListMembers(tenantId).find(m => m.userId === userId);
  // Existing mock identities represent verified sessions; no real address is queried.
  if (!member?.email || !await createMemoryWeeklyDigestStore().getPreference(tenantId, userId)) return undefined;
  return { tenantId, userId, role: member.role, email: member.email };
}
export function createMemoryDigestContentStore(): DigestContentStore {
  return {
    async loadDigestContent(input) {
      const recipient = await resolveMemoryDigestRecipient(input.tenantId, input.userId);
      if (!recipient || recipient.role !== input.role) return {};
      return withHardening(selectDigestContent(input, {
        members: memoryListMembers(input.tenantId),
        verdicts: memoryVerdicts().filter(v => v.tenantId === input.tenantId && v.userId === input.userId).map(v => ({ id: v.id, userId: v.userId, label: v.verdict.verdict, headline: v.verdict.headline, createdAt: v.createdAt })),
        alerts: input.role === "owner" ? memoryAlertRows().filter(a => a.tenantId === input.tenantId) : [],
        devices: input.role === "owner" ? memoryListDevices(input.tenantId) : [],
      }), createMemoryHardeningStore(), input);
    },
  };
}
