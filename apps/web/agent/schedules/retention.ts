/**
 * Eve schedule `retention`: the daily retention purges (Inngest: artifacts-expire).
 *
 * A `run` handler, not a prompt: it never calls `to(...).send`, so no session and no model call start.
 * Shadow (read-only, records what it would do) unless NEO_EVE_SCHEDULES lists the job; see
 * apps/web/lib/server/schedules and _specs/v2-m3-cutover.md. The cron is UTC and is kept equal to the
 * Inngest cron by a test (apps/web/test/schedules-definitions.test.ts).
 */
import { defineSchedule } from "eve/schedules";
import { runEveSchedule } from "@/lib/server/schedules/eve";

export default defineSchedule({
  cron: "0 4 * * *",
  async run() {
    await runEveSchedule("retention");
  },
});
