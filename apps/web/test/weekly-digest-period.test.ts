// @vitest-environment node
import { expect, it } from "vitest";
import { digestPeriod, digestGenerateEventSchema } from "@/lib/server/weekly-digest/period";
it("snaps receipt time to Monday 14 UTC with ISO-year boundaries and ignores unreliable event time", () => {
  for (const ts of [undefined, 0, Date.parse("2026-10-05T14:00:00Z")]) {
    expect(digestPeriod(ts, new Date("2026-10-05T13:59:59Z"))).toEqual({
      scheduledAt: new Date("2026-09-28T14:00:00Z"), periodEnd: new Date("2026-09-28T14:00:00Z"), periodStart: new Date("2026-09-21T14:00:00Z"), isoWeek: "2026-W40",
    });
  }
  expect(digestPeriod(undefined, new Date("2025-12-29T14:00:00Z")).isoWeek).toBe("2026-W01");
  expect(digestGenerateEventSchema.safeParse({ tenantId: "bad", userId: "a" }).success).toBe(false);
});
