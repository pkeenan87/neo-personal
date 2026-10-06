import { and, desc, eq } from "drizzle-orm";
import type { TenantTx } from "./tenant.js";
import { knownSigninDevices, signinEvents, type SigninEventSource } from "./schema/signin-alerts.js";

export type { SigninEventSource };

/** A parsed sign-in alert fact set for one member (_specs/signin-alerts.md). `deviceKnown` is derived at read time. */
export type SigninEvent = {
  id: string;
  tenantId: string;
  userId: string;
  provider: string;
  event: string;
  deviceLabel: string | null;
  coarseLocation: string | null;
  eventTime: Date | null;
  source: SigninEventSource;
  authenticated: boolean;
  verdictId: string | null;
  createdAt: Date;
  /** The provider/device pair is in `known_signin_devices` (the member answered "yes" before). */
  deviceKnown: boolean;
};

export type SigninEventInput = {
  userId: string;
  provider: string;
  event: string;
  deviceLabel?: string | null;
  coarseLocation?: string | null;
  eventTime?: Date | null;
  source: SigninEventSource;
  authenticated: boolean;
  verdictId?: string | null;
};

/** Event history and known devices for one tenant. Every method takes the member's `userId`; it never lists across members. */
export interface TenantSigninEvents {
  /** The member's events, newest first (default 50, max 200), with known-device status. */
  list(userId: string, opts?: { limit?: number }): Promise<SigninEvent[]>;
  /** Store an event (and refresh last-seen on a known device). */
  record(input: SigninEventInput): Promise<SigninEvent>;
  /** True when the provider/device pair is remembered (first-seen is the negation). */
  isKnownDevice(userId: string, provider: string, deviceLabel: string): Promise<boolean>;
  /** Remember the pair (idempotent). */
  rememberDevice(userId: string, provider: string, deviceLabel: string): Promise<void>;
  /** Forget the pair (idempotent): the member answered "no" after a "yes". */
  forgetDevice(userId: string, provider: string, deviceLabel: string): Promise<void>;
  /** Delete the member's events and known devices; returns the number of events removed. */
  deleteForUser(userId: string): Promise<number>;
}

const MAX_LIST = 200;

export function createTenantSigninEvents(transaction: <R>(fn: (t: TenantTx) => Promise<R>) => Promise<R>): TenantSigninEvents {
  const pair = (userId: string, provider: string, deviceLabel: string) =>
    and(eq(knownSigninDevices.userId, userId), eq(knownSigninDevices.provider, provider), eq(knownSigninDevices.deviceLabel, deviceLabel));

  return {
    async list(userId, opts = {}) {
      const limit = Math.max(1, Math.min(MAX_LIST, Math.floor(opts.limit ?? 50)));
      return transaction(async (t) => {
        const events = await t.select(signinEvents, eq(signinEvents.userId, userId), { orderBy: [desc(signinEvents.createdAt)], limit });
        const known = await t.select(knownSigninDevices, eq(knownSigninDevices.userId, userId));
        const keys = new Set(known.map((k) => `${k.provider}\u0000${k.deviceLabel}`));
        return events.map((e) => ({ ...e, source: e.source, deviceKnown: !!e.deviceLabel && keys.has(`${e.provider}\u0000${e.deviceLabel}`) }));
      });
    },
    async record(input) {
      return transaction(async (t) => {
        const [row] = await t.insert(signinEvents, {
          userId: input.userId,
          provider: input.provider,
          event: input.event,
          deviceLabel: input.deviceLabel ?? null,
          coarseLocation: input.coarseLocation ?? null,
          eventTime: input.eventTime ?? null,
          source: input.source,
          authenticated: input.authenticated,
          verdictId: input.verdictId ?? null,
        });
        if (!row) throw new Error("@neo/db: sign-in event insert returned no row");
        let deviceKnown = false;
        if (row.deviceLabel) {
          const touched = await t.update(knownSigninDevices, { lastSeenAt: new Date() }, pair(row.userId, row.provider, row.deviceLabel));
          deviceKnown = touched.length > 0;
        }
        return { ...row, deviceKnown };
      });
    },
    async isKnownDevice(userId, provider, deviceLabel) {
      return transaction(async (t) => !!(await t.first(knownSigninDevices, pair(userId, provider, deviceLabel))));
    },
    async rememberDevice(userId, provider, deviceLabel) {
      await transaction(async (t) => {
        const now = new Date();
        await t.tx
          .insert(knownSigninDevices)
          .values({ tenantId: t.tenantId, userId, provider, deviceLabel, firstSeenAt: now, lastSeenAt: now })
          .onConflictDoUpdate({ target: [knownSigninDevices.tenantId, knownSigninDevices.userId, knownSigninDevices.provider, knownSigninDevices.deviceLabel], set: { lastSeenAt: now } });
      });
    },
    async forgetDevice(userId, provider, deviceLabel) {
      await transaction((t) => t.delete(knownSigninDevices, pair(userId, provider, deviceLabel)));
    },
    async deleteForUser(userId) {
      return transaction(async (t) => {
        await t.delete(knownSigninDevices, eq(knownSigninDevices.userId, userId));
        return (await t.delete(signinEvents, eq(signinEvents.userId, userId))).length;
      });
    },
  };
}
