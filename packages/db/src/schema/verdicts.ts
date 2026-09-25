import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts.js";
import { users } from "./auth.js";
import { conversations } from "./conversations.js";
import { tenants } from "./tenants.js";

// Mirrors the literal unions of @neo/verdict's Verdict type (docs/contracts.md).
export const VERDICT_SUBJECT_TYPES = ["email", "sms", "url", "page", "signin_alert", "file", "conversation"] as const;
export type VerdictSubjectType = (typeof VERDICT_SUBJECT_TYPES)[number];
export const VERDICT_LABELS = ["malicious", "suspicious", "likely_safe", "insufficient_evidence"] as const;
export type VerdictLabel = (typeof VERDICT_LABELS)[number];

export const VERDICT_SOURCES = ["chat", "inbound", "api"] as const;
/** Where a verdict came from: a chat turn, a forwarded email (inbound triage), or the API. */
export type VerdictSource = (typeof VERDICT_SOURCES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const verdicts = pgTable(
  "verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** The evidence artifact, if any; nulled when the artifact is purged. */
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    source: text("source").$type<VerdictSource>().notNull().default("chat"),
    subjectType: text("subject_type").$type<VerdictSubjectType>().notNull(),
    verdict: text("verdict").$type<VerdictLabel>().notNull(),
    confidence: real("confidence").notNull(),
    headline: text("headline").notNull(),
    /** The full @neo/verdict `Verdict` object. */
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Dashboard: recent verdicts for the household, per member, by label, by subject type.
    index("verdicts_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    index("verdicts_tenant_user_created_idx").on(t.tenantId, t.userId, t.createdAt.desc()),
    index("verdicts_tenant_verdict_created_idx").on(t.tenantId, t.verdict, t.createdAt.desc()),
    index("verdicts_tenant_subject_created_idx").on(t.tenantId, t.subjectType, t.createdAt.desc()),
    index("verdicts_conversation_idx").on(t.conversationId),
    index("verdicts_tenant_source_created_idx").on(t.tenantId, t.source, t.createdAt.desc()),
    index("verdicts_artifact_idx").on(t.artifactId),
    check("verdicts_subject_type_check", sql`${t.subjectType} in (${inList(VERDICT_SUBJECT_TYPES)})`),
    check("verdicts_verdict_check", sql`${t.verdict} in (${inList(VERDICT_LABELS)})`),
    check("verdicts_source_check", sql`${t.source} in (${inList(VERDICT_SOURCES)})`),
    check("verdicts_confidence_check", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);
