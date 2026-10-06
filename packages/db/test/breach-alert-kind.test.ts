import { afterAll, beforeAll, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTenantForUser } from "../src/tenants.js";
import { tenantScoped } from "../src/tenant.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

let t: TestDb;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  userId = await createUser(t.db, "Breach alert subject");
  tenantId = (await createTenantForUser(t.db, { userId, name: "Breach alerts" })).tenantId;
  await becomeAppUser(t.client);
});
afterAll(async () => { await t?.close(); });

it("allows the migration-owned breach_detected alert kind for the subject user's household", async () => {
  await tenantScoped(t.db, tenantId).transaction(({ tx }) => tx.execute(sql`
    INSERT INTO public.alerts (tenant_id, subject_user_id, kind, severity, title, body, dedupe_key)
    VALUES (${tenantId}::uuid, ${userId}, 'breach_detected', 'high', 'New breach: Example', 'Change this password and enable two-factor authentication.', 'breach:example')
  `));
});
