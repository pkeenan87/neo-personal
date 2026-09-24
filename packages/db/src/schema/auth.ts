/**
 * Auth.js v5 tables for `@auth/drizzle-adapter` (Postgres flavour).
 *
 * Property names and column types match the adapter's `DefaultPostgresSchema`
 * exactly; only the SQL table/column names are our own (plural, snake_case).
 * Pass them to the adapter as:
 *
 *   DrizzleAdapter(db, {
 *     usersTable: users,
 *     accountsTable: accounts,
 *     sessionsTable: sessions,
 *     verificationTokensTable: verificationTokens,
 *     authenticatorsTable: authenticators,
 *   })
 *
 * These tables are user-owned, not tenant-owned: they carry no tenant_id and no RLS.
 */
import { boolean, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Mirrors `AdapterAccountType` from @auth/core without depending on it. */
export type AuthAccountType = "oauth" | "oidc" | "email" | "webauthn";

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { mode: "date", withTimezone: true }),
  image: text("image"),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AuthAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/** WebAuthn credentials (passkeys, Phase 2). */
export const authenticators = pgTable(
  "authenticators",
  {
    credentialID: text("credential_id").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerAccountId: text("provider_account_id").notNull(),
    credentialPublicKey: text("credential_public_key").notNull(),
    counter: integer("counter").notNull(),
    credentialDeviceType: text("credential_device_type").notNull(),
    credentialBackedUp: boolean("credential_backed_up").notNull(),
    transports: text("transports"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.credentialID] })],
);
