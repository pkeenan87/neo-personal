import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { describe, expect, it } from "vitest";
import { selectDriver } from "../src/client.js";
import { accounts, authenticators, sessions, users, verificationTokens } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTestDb } from "./helpers.js";

describe("selectDriver", () => {
  it("picks neon for *.neon.tech hosts and pg otherwise", () => {
    expect(selectDriver("postgresql://u:p@ep-cool-1234.us-east-2.aws.neon.tech/neondb?sslmode=require", {})).toBe("neon");
    expect(selectDriver("postgres://u:p@localhost:5432/neo", {})).toBe("pg");
    expect(selectDriver("postgres://u:p@evilneon.tech.example.com/x", {})).toBe("pg");
    expect(selectDriver("not a url", {})).toBe("pg");
  });

  it("honours NEO_DB_DRIVER", () => {
    expect(selectDriver("postgres://localhost/neo", { NEO_DB_DRIVER: "neon" })).toBe("neon");
    expect(selectDriver("postgres://x.neon.tech/neo", { NEO_DB_DRIVER: "pg" })).toBe("pg");
  });
});

describe("tenantScoped", () => {
  it("rejects non-UUID tenant ids", async () => {
    const t = await createTestDb();
    try {
      expect(() => tenantScoped(t.db, "' or 1=1 --")).toThrow(/UUID/);
    } finally {
      await t.close();
    }
  });
});

describe("Auth.js adapter tables", () => {
  it("are accepted by DrizzleAdapter and support a user/session round trip", async () => {
    const t = await createTestDb();
    try {
      const adapter = DrizzleAdapter(t.db, {
        usersTable: users,
        accountsTable: accounts,
        sessionsTable: sessions,
        verificationTokensTable: verificationTokens,
        authenticatorsTable: authenticators,
      });
      const user = await adapter.createUser!({ id: "ignored", email: "a@example.test", emailVerified: null, name: "A" });
      expect(user.id).toMatch(/[0-9a-f-]{36}/);
      await adapter.linkAccount!({ userId: user.id, type: "oidc", provider: "google", providerAccountId: "g-1" });
      expect(await adapter.getUserByAccount!({ provider: "google", providerAccountId: "g-1" })).toMatchObject({ id: user.id });
      const expires = new Date(Date.now() + 60_000);
      await adapter.createSession!({ sessionToken: "tok", userId: user.id, expires });
      expect(await adapter.getSessionAndUser!("tok")).toMatchObject({ user: { id: user.id } });
      await adapter.createVerificationToken!({ identifier: "a@example.test", token: "vt", expires });
      expect(await adapter.useVerificationToken!({ identifier: "a@example.test", token: "vt" })).toMatchObject({ token: "vt" });
    } finally {
      await t.close();
    }
  });
});
