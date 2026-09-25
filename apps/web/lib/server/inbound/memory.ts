/**
 * No-database fallback for forward-to-address (MOCK_MODE demos and tests),
 * per process, with the same semantics as @neo/db `inbound`: unique local
 * parts, idempotent `recordMessage` on the provider message id, tenant checks
 * on every per-tenant call. Rows live in the shared in-memory state
 * (lib/server/memory-state.ts), next to the verdicts and members the
 * dashboard reads, so an inbound verdict shows up on /dashboard in MOCK_MODE.
 */
import { generateLocalPart, type InboundMessagePatch, type InboundMessageRow, type RecordMessageInput } from "@neo/db";
import { memoryState, type MemoryInboundAddress } from "../memory-state";

export const memoryInbound = {
  async ensureAddress(tenantId: string): Promise<{ id: string; localPart: string }> {
    const s = memoryState();
    const existing = s.inboundAddresses.find((a) => a.tenantId === tenantId && a.active);
    if (existing) return { id: existing.id, localPart: existing.localPart };
    let localPart = generateLocalPart();
    while (s.inboundAddresses.some((a) => a.localPart === localPart)) localPart = generateLocalPart();
    const row: MemoryInboundAddress = { id: crypto.randomUUID(), tenantId, localPart, active: true, createdAt: new Date(), rotatedAt: null };
    s.inboundAddresses.push(row);
    return { id: row.id, localPart: row.localPart };
  },

  async rotateAddress(tenantId: string): Promise<{ id: string; localPart: string }> {
    for (const a of memoryState().inboundAddresses) {
      if (a.tenantId === tenantId && a.active) {
        a.active = false;
        a.rotatedAt = new Date();
      }
    }
    return memoryInbound.ensureAddress(tenantId);
  },

  async findActiveByLocalPart(localPart: string): Promise<{ id: string; tenantId: string } | undefined> {
    const lp = localPart.trim().toLowerCase();
    const a = memoryState().inboundAddresses.find((x) => x.localPart === lp && x.active);
    return a ? { id: a.id, tenantId: a.tenantId } : undefined;
  },

  async recordMessage(input: RecordMessageInput): Promise<{ id: string; duplicate: boolean }> {
    const s = memoryState();
    const existing = s.inboundMessages.find((m) => m.providerMessageId === input.providerMessageId);
    if (existing) {
      if (existing.tenantId !== input.tenantId) throw new Error("provider message id already recorded for another tenant");
      return { id: existing.id, duplicate: true };
    }
    const row: InboundMessageRow = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      addressId: input.addressId,
      providerMessageId: input.providerMessageId,
      fromAddressHash: input.fromAddressHash,
      status: input.status,
      error: input.error ?? null,
      forwarderUserId: null,
      artifactId: null,
      verdictId: null,
      receivedAt: new Date(),
      completedAt: null,
    };
    s.inboundMessages.push(row);
    return { id: row.id, duplicate: false };
  },

  async updateMessage(id: string, tenantId: string, patch: InboundMessagePatch): Promise<void> {
    const row = memoryState().inboundMessages.find((m) => m.id === id && m.tenantId === tenantId);
    if (!row) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (row as Record<string, unknown>)[k] = v;
    }
  },

  async getMessage(id: string, tenantId: string): Promise<InboundMessageRow | undefined> {
    const row = memoryState().inboundMessages.find((m) => m.id === id && m.tenantId === tenantId);
    return row ? { ...row } : undefined;
  },

  async countRecent(tenantId: string, addressId: string, windowMs: number): Promise<number> {
    const since = Date.now() - Math.max(0, windowMs);
    return memoryState().inboundMessages.filter(
      (m) => m.tenantId === tenantId && m.addressId === addressId && m.receivedAt.getTime() >= since,
    ).length;
  },

  async listRecent(tenantId: string, limit = 20): Promise<InboundMessageRow[]> {
    return memoryState()
      .inboundMessages.filter((m) => m.tenantId === tenantId)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((m) => ({ ...m }));
  },

  /** Delete rejected/failed rows older than `olderThanDays` across tenants (retention job). */
  async purgeOld(olderThanDays = 90): Promise<number> {
    const s = memoryState();
    const before = Date.now() - Math.max(1, Math.floor(olderThanDays)) * 86_400_000;
    const keep = s.inboundMessages.filter((m) => !((m.status === "rejected" || m.status === "failed") && m.receivedAt.getTime() < before));
    const removed = s.inboundMessages.length - keep.length;
    s.inboundMessages = keep;
    return removed;
  },
};
