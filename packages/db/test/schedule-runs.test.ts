import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertScheduleRun, listScheduleRuns, pruneScheduleRuns } from "../src/schedule-runs.js";
import { becomeAppUser, createTestDb, type TestDb } from "./helpers.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const base = {
  job: "outbox-sweep",
  runner: "eve" as const,
  mode: "shadow" as const,
  outcome: "ok" as const,
  summary: { counts: { "planned.outbox.drain": 1 }, digest: "ab".repeat(32), actions: 1 },
};

describe("migration 0025_schedule_runs", () => {
  it("creates a tenant-less table without RLS", async () => {
    const cols = await t.client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'schedule_runs' order by ordinal_position",
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual(["id", "job", "runner", "mode", "started_at", "finished_at", "outcome", "summary", "error"]);
    const rls = await t.client.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'schedule_runs'");
    expect(rls.rows[0]?.relrowsecurity).toBe(false);
  });

  it("inserts, lists and prunes runs", async () => {
    const now = new Date("2026-11-03T10:00:00Z");
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
    await insertScheduleRun(t.db, { ...base, startedAt: old, finishedAt: old });
    await insertScheduleRun(t.db, { ...base, runner: "inngest", mode: "live", startedAt: now, finishedAt: now, error: "x".repeat(500), outcome: "error" });
    const recent = await listScheduleRuns(t.db, "outbox-sweep", new Date(now.getTime() - 60_000));
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ runner: "inngest", mode: "live", outcome: "error" });
    expect(recent[0]!.error).toHaveLength(300);
    expect(recent[0]!.summary.digest).toHaveLength(64);
    expect(await pruneScheduleRuns(t.db, 90, now)).toBe(1);
    expect(await listScheduleRuns(t.db, "outbox-sweep", old)).toHaveLength(1);
  });

  it("rejects values outside the runner, mode and outcome sets", async () => {
    const at = new Date();
    for (const bad of [{ runner: "cron" }, { mode: "dry" }, { outcome: "maybe" }]) {
      await expect(insertScheduleRun(t.db, { ...base, startedAt: at, finishedAt: at, ...bad } as never)).rejects.toThrow();
    }
  });

  it("is readable and writable by app_user", async () => {
    await becomeAppUser(t.client);
    const at = new Date("2026-11-03T11:00:00Z");
    await insertScheduleRun(t.db, { ...base, job: "retention", startedAt: at, finishedAt: at });
    expect(await listScheduleRuns(t.db, "retention", at)).toHaveLength(1);
    const priv = await t.client.query<{ i: boolean; s: boolean; d: boolean }>(
      "select has_table_privilege('app_user','schedule_runs','INSERT') i, has_table_privilege('app_user','schedule_runs','SELECT') s, has_table_privilege('app_user','schedule_runs','DELETE') d",
    );
    expect(priv.rows[0]).toEqual({ i: true, s: true, d: true });
    await t.client.exec("reset role");
  });

  it("grants app_user the table when the role exists before the migrations run", async () => {
    const pre = await createTestDb({ createAppUserBeforeMigrations: true });
    const priv = await pre.client.query<{ i: boolean; u: boolean }>(
      "select has_table_privilege('app_user','schedule_runs','INSERT') i, has_table_privilege('app_user','schedule_runs','UPDATE') u",
    );
    expect(priv.rows[0]).toEqual({ i: true, u: false });
    await pre.close();
  });
});
