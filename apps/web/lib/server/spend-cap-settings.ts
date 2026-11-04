/**
 * Owner settings for the household's monthly model spend cap (_specs/v2-m3-cutover.md section 6).
 * Both operations re-check the owner role server-side (`requireHouseholdAdmin`); the tenant comes from the session.
 */
import { isValidSpendCapCents } from "@neo/core";
import { z } from "zod";
import { recordAudit } from "./audit";
import { requireHouseholdAdmin, type HouseholdActor } from "./household-admin";
import type { Outcome } from "./household";
import { setSpendCapCents, spendView } from "./spend-cap";

export interface SpendCapResponse {
  /** The cap in cents; null = off (the default). */
  capCents: number | null;
  /** Estimated month-to-date model spend in cents (rounded down to a whole cent). */
  spentCents: number;
  /** Percent of the cap used (rounded down); null while the cap is off. */
  percent: number | null;
  /** `YYYY-MM` of the household-time-zone month. */
  month: string;
  /** When the spend counter resets (ISO-8601). */
  resetAt: string;
}

const NOT_VALID = { ok: false, status: 400, code: "invalid", message: "Check the details and try again." } as const;

async function respond(tenantId: string): Promise<SpendCapResponse> {
  const v = await spendView(tenantId);
  return {
    capCents: v.capCents,
    spentCents: Math.floor(v.spentCents),
    percent: v.percent === null ? null : Math.floor(v.percent),
    month: v.month,
    resetAt: v.resetAt.toISOString(),
  };
}

/** The cap and this month's spend. Owner only. */
export async function getSpendCap(actor: HouseholdActor): Promise<Outcome<SpendCapResponse>> {
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return admin;
  return { ok: true, value: await respond(actor.tenantId) };
}

const Body = z.object({ capCents: z.number().nullable() }).strict();

/** Set (`capCents` from 100 to 1000000) or clear (`null`) the cap. Owner only. 400 `invalid`, `invalid_spend_cap`. */
export async function putSpendCap(actor: HouseholdActor, body: Record<string, unknown> | null): Promise<Outcome<SpendCapResponse>> {
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return admin;
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NOT_VALID;
  const { capCents } = parsed.data;
  if (capCents !== null && !isValidSpendCapCents(capCents)) {
    return { ok: false, status: 400, code: "invalid_spend_cap", message: "Choose a limit from $1 to $10,000, or turn the limit off." };
  }
  const before = (await spendView(actor.tenantId)).capCents;
  if (before !== capCents) {
    await setSpendCapCents(actor.tenantId, capCents);
    await recordAudit(actor.tenantId, actor.userId, "household.spend_cap_changed", { from: before, to: capCents });
  }
  return { ok: true, value: await respond(actor.tenantId) };
}
