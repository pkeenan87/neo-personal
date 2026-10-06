/**
 * Sign-in events and known devices behind one seam: @neo/db (`tenantScoped(...).signinEvents`) with a
 * database, else the shared in-memory twin (memory-state.ts) for MOCK_MODE and tests. Mirrors the DB rules:
 * per-member reads, a remembered pair is unique, events cascade with their verdict and membership.
 */
import type { SigninEvent, SigninEventInput } from "@neo/db";
import { tenantScoped } from "@neo/db";
import { getDb } from "../db";
import { memoryState } from "../memory-state";

export interface SigninStore {
  list(tenantId: string, userId: string, opts?: { limit?: number }): Promise<SigninEvent[]>;
  record(tenantId: string, input: SigninEventInput): Promise<SigninEvent>;
  isKnownDevice(tenantId: string, userId: string, provider: string, deviceLabel: string): Promise<boolean>;
  rememberDevice(tenantId: string, userId: string, provider: string, deviceLabel: string): Promise<void>;
  forgetDevice(tenantId: string, userId: string, provider: string, deviceLabel: string): Promise<void>;
}

const key = (tenantId: string, userId: string, provider: string, label: string) => `${tenantId}:${userId}:${provider}:${label}`;
const MAX_MEMORY_EVENTS = 1000;

export const memorySigninStore: SigninStore = {
  async list(tenantId, userId, opts = {}) {
    const st = memoryState();
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    return st.signinEvents
      .filter((e) => e.tenantId === tenantId && e.userId === userId)
      .sort((a, b) => +b.createdAt - +a.createdAt)
      .slice(0, limit)
      .map((e) => ({ ...e, deviceKnown: !!e.deviceLabel && st.knownSigninDevices.has(key(tenantId, userId, e.provider, e.deviceLabel)) }));
  },
  async record(tenantId, input) {
    const st = memoryState();
    const row: SigninEvent = {
      id: crypto.randomUUID(),
      tenantId,
      userId: input.userId,
      provider: input.provider,
      event: input.event,
      deviceLabel: input.deviceLabel ?? null,
      coarseLocation: input.coarseLocation ?? null,
      eventTime: input.eventTime ?? null,
      source: input.source,
      authenticated: input.authenticated,
      verdictId: input.verdictId ?? null,
      createdAt: new Date(),
      deviceKnown: !!input.deviceLabel && st.knownSigninDevices.has(key(tenantId, input.userId, input.provider, input.deviceLabel)),
    };
    st.signinEvents.push(row);
    if (st.signinEvents.length > MAX_MEMORY_EVENTS) st.signinEvents.splice(0, st.signinEvents.length - MAX_MEMORY_EVENTS);
    return { ...row };
  },
  async isKnownDevice(tenantId, userId, provider, deviceLabel) {
    return memoryState().knownSigninDevices.has(key(tenantId, userId, provider, deviceLabel));
  },
  async rememberDevice(tenantId, userId, provider, deviceLabel) {
    memoryState().knownSigninDevices.add(key(tenantId, userId, provider, deviceLabel));
  },
  async forgetDevice(tenantId, userId, provider, deviceLabel) {
    memoryState().knownSigninDevices.delete(key(tenantId, userId, provider, deviceLabel));
  },
};

function dbSigninStore(db: NonNullable<ReturnType<typeof getDb>>): SigninStore {
  const q = (tenantId: string) => tenantScoped(db, tenantId).signinEvents;
  return {
    list: (tenantId, userId, opts) => q(tenantId).list(userId, opts),
    record: (tenantId, input) => q(tenantId).record(input),
    isKnownDevice: (tenantId, userId, provider, label) => q(tenantId).isKnownDevice(userId, provider, label),
    rememberDevice: (tenantId, userId, provider, label) => q(tenantId).rememberDevice(userId, provider, label),
    forgetDevice: (tenantId, userId, provider, label) => q(tenantId).forgetDevice(userId, provider, label),
  };
}

export function getSigninStore(): SigninStore {
  const db = getDb();
  return db ? dbSigninStore(db) : memorySigninStore;
}
