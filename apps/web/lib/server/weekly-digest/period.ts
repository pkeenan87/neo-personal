import { z } from "zod";
export const weeklyDigestCron = "TZ=UTC 0 14 * * 1";
export const DIGEST_GENERATE_EVENT = "neo/digest.generate";
export const DIGEST_RESUME_LEASE_MS = 15 * 60_000;
export type DigestPeriod = { scheduledAt: Date; periodStart: Date; periodEnd: Date; isoWeek: string };
/** v4 cron has no event timestamp. Only the first durable step's receipt time is authoritative. */
export function digestPeriod(_eventTs: number | undefined, firstStepReceivedAt: Date): DigestPeriod {
  const end = new Date(firstStepReceivedAt);
  end.setUTCHours(14, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - (end.getUTCDay() + 6) % 7);
  if (+end > +firstStepReceivedAt) end.setUTCDate(end.getUTCDate() - 7);
  const thursday = new Date(end);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil((+thursday - Date.UTC(year, 0, 1) + 1) / (7 * 86400000));
  return { scheduledAt: end, periodEnd: end, periodStart: new Date(+end - 7 * 86400000), isoWeek: `${year}-W${String(week).padStart(2, "0")}` };
}
export const digestGenerateEventSchema = z.object({
  tenantId: z.string().uuid(), userId: z.string().min(1).max(200),
  scheduledAt: z.string().datetime(), periodStart: z.string().datetime(), periodEnd: z.string().datetime(), isoWeek: z.string().regex(/^\d{4}-W\d{2}$/),
}).strict().refine(value => {
  const period = digestPeriod(undefined, new Date(value.scheduledAt));
  return period.scheduledAt.toISOString() === value.scheduledAt && period.periodStart.toISOString() === value.periodStart && value.periodEnd === value.scheduledAt && period.isoWeek === value.isoWeek;
}, "invalid digest period");
export type DigestGenerateEvent = z.infer<typeof digestGenerateEventSchema>;
export function digestResendIdempotencyKey(userId: string, isoWeek: string): string { return `digest:${userId}:${isoWeek}`; }
