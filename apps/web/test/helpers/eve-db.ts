/**
 * A Postgres (PGlite, committed migrations) with two households for the eve agent tests:
 * household A has an owner and a member ("Kid") with a device each and alerts about each of
 * them; household B has an owner and an alert. Tests stub `@/lib/server/db` with `fixture.db`.
 */
import { PGlite } from "@electric-sql/pglite";
import {
  alerts,
  createAlert,
  createMemberForUser,
  createTenantForUser,
  devices,
  insertDeviceSignal,
  memberships,
  schema,
  sessions,
  tenantScoped,
  users,
  type Db,
} from "@neo/db";
import { migrationsFolder } from "@neo/db/migrate";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";

export interface Person {
  userId: string;
  tenantId: string;
  role: "owner" | "member";
  memberId: string;
  deviceId: string;
  deviceName: string;
}

export interface EveFixture {
  db: Db;
  close: () => Promise<void>;
  owner: Person;
  kid: Person;
  other: Person;
  /** Alerts: about the member, about the owner, and in the other household. */
  kidAlertId: string;
  ownerAlertId: string;
  otherAlertId: string;
  /** Signals of the member's device: one 2h old, one 30h old. */
  recentSignalId: string;
  oldSignalId: string;
  addSession(userId: string, token: string, expires: Date): Promise<void>;
}

let seq = 0;

async function person(db: Db, name: string, tenantId: string | null, role: "owner" | "member"): Promise<Person> {
  seq += 1;
  const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}${seq}@example.test` }).returning({ id: users.id });
  const userId = u!.id;
  let tid = tenantId;
  if (!tid) tid = (await createTenantForUser(db, { userId, name: `${name}'s household` })).tenantId;
  else await tenantScoped(db, tid).insert(memberships, { userId, role });
  const t = tenantScoped(db, tid);
  const member = await createMemberForUser(t, { userId, displayName: name, role: role === "owner" ? "owner" : "adult" });
  const deviceName = `${name}'s laptop`;
  const [device] = await t.insert(devices, {
    userId,
    memberId: member.id,
    kind: "desktop_agent",
    platform: "linux",
    name: deviceName,
    clientVersion: "1.0.0",
    enrollment: "self",
  });
  return { userId, tenantId: tid, role, memberId: member.id, deviceId: device!.id, deviceName };
}

export async function createEveFixture(): Promise<EveFixture> {
  const client = new PGlite();
  const d = drizzle({ client, schema });
  await migrate(d, { migrationsFolder });
  const db = d as unknown as Db;

  const owner = await person(db, "Pat", null, "owner");
  const kid = await person(db, "Kid", owner.tenantId, "member");
  const other = await person(db, "Zed", null, "owner");

  const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);
  const signal = async (clientEventId: string, detector: string, subject: string, at: Date) =>
    (
      await insertDeviceSignal(db, {
        tenantId: kid.tenantId,
        deviceId: kid.deviceId,
        userId: kid.userId,
        clientEventId,
        type: "web",
        detector,
        subject,
        payload: { secret: "full-url-and-payload-should-not-leak", url: "https://evil.example/login?token=abc" },
        observedAt: at,
      })
    ).row.id;
  const recentSignalId = await signal(crypto.randomUUID(), "scam_page", "evil.example", hoursAgo(2));
  const oldSignalId = await signal(crypto.randomUUID(), "scam_page", "old.example", hoursAgo(30));

  const kidAlert = await createAlert(db, {
    tenantId: kid.tenantId,
    subjectUserId: kid.userId,
    kind: "scam_page",
    severity: "high",
    title: "Kid opened a scam page",
    body: "Kid's laptop opened evil.example.",
    dedupeKey: "kid-1",
    deviceId: kid.deviceId,
    signalIds: [recentSignalId],
  });
  const ownerAlert = await createAlert(db, {
    tenantId: owner.tenantId,
    subjectUserId: owner.userId,
    kind: "remote_access",
    severity: "critical",
    title: "Pat's laptop had a remote session",
    body: "A remote access tool connected.",
    dedupeKey: "owner-1",
    deviceId: owner.deviceId,
  });
  const otherAlert = await createAlert(db, {
    tenantId: other.tenantId,
    subjectUserId: other.userId,
    kind: "scam_page",
    severity: "high",
    title: "Zed alert",
    body: "Another household.",
    dedupeKey: "other-1",
  });

  return {
    db,
    close: () => client.close(),
    owner,
    kid,
    other,
    kidAlertId: kidAlert!.id,
    ownerAlertId: ownerAlert!.id,
    otherAlertId: otherAlert!.id,
    recentSignalId,
    oldSignalId,
    async addSession(userId, token, expires) {
      await db.insert(sessions).values({ sessionToken: token, userId, expires });
    },
  };
}

export async function alertRow(db: Db, tenantId: string, id: string) {
  return tenantScoped(db, tenantId).first(alerts, eq(alerts.id, id));
}
