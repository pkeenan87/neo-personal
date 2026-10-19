/**
 * Inbox forwarding audit (_specs/outlook-connector.md): read the inbox message rules (read-only), classify every rule,
 * keep one finding per external or unreadable forwarding destination, resolve findings whose rule was disabled or
 * removed, and raise `mailbox_forwarding` once per new activation. An activation counts as alerted only once the alert
 * succeeded (`alerted_at`): every audit re-raises active findings that are still unalerted (the alert's dedupe key keeps
 * that idempotent). The audit also purges seen-message fingerprints older than 45 days. Neo audits inbox rules only;
 * Graph does not expose account-level SMTP forwarding.
 */
import { hashPii, logger } from "@neo/core";
import type { OutlookDeps } from "./deps";
import { classifyRule, ownAddressSet, type RuleFindingCandidate } from "./rules";
import { withGraph } from "./token";
import type { GraphRule, OutlookRunCtx } from "./types";

const MAX_RULE_PAGES = 10;
export const SEEN_MESSAGE_RETENTION_DAYS = 45;

export type OutlookAuditResult = { status: "ok" | "skipped" | "reauth_required"; findings: number; raised: number };

export async function auditOutlookRules(ctx: OutlookRunCtx, deps: OutlookDeps): Promise<OutlookAuditResult> {
  const connector = await deps.store.getConnectorById(ctx.tenantId, ctx.connectorId);
  if (!connector || connector.userId !== ctx.userId || connector.status !== "connected") return { status: "skipped", findings: 0, raised: 0 };
  const generation = connector.connectionGeneration;
  const read = await withGraph(ctx, deps, async (graph) => {
    const me = await graph.getMe();
    const rules: GraphRule[] = [];
    let next: string | undefined;
    for (let page = 0; page < MAX_RULE_PAGES; page++) {
      const res = await graph.listInboxRules(next);
      rules.push(...res.rules);
      next = res.nextLink;
      if (!next) return { me, rules, complete: true };
    }
    return { me, rules, complete: false };
  });
  if (!read.ok) return { status: read.reason === "reauth_required" ? "reauth_required" : "skipped", findings: 0, raised: 0 };

  const own = ownAddressSet(read.value.me.addresses);
  const now = deps.now();
  const found = new Map<string, RuleFindingCandidate>();
  for (const rule of read.value.rules) for (const f of classifyRule(rule, own).findings) found.set(f.ruleKey, f);

  for (const f of found.values()) {
    await deps.store.upsertFinding(ctx.tenantId, { userId: ctx.userId, connectorId: ctx.connectorId, ruleKey: f.ruleKey, action: f.action, destinationDomain: f.destinationDomain, now });
  }
  // Only a complete read may resolve findings: a truncated rule list must not clear a real one.
  if (read.value.complete) await deps.store.resolveMissingFindings(ctx.tenantId, ctx.connectorId, [...found.keys()], now);

  // Alert every active finding that has not been alerted yet: new activations and ones whose earlier alert failed.
  let raised = 0;
  for (const f of await deps.store.listUnalertedFindings(ctx.tenantId, ctx.connectorId)) {
    const result = await deps.alertForwarding({ tenantId: ctx.tenantId, userId: ctx.userId, findingId: f.id, observedAt: f.observedAt, destinationDomain: f.destinationDomain ?? null });
    if (result === "failed") continue; // stays unalerted; the next audit retries
    await deps.store.markFindingAlerted(ctx.tenantId, f.id, now);
    if (result === "raised") raised++;
  }

  await deps.store.purgeSeenMessages(ctx.tenantId, ctx.connectorId, new Date(now.getTime() - SEEN_MESSAGE_RETENTION_DAYS * 86_400_000));
  await deps.store.touch(ctx.tenantId, ctx.connectorId, generation, { lastAuditAt: now });
  logger.info("Outlook rule audit finished", "outlook", { tenantId: ctx.tenantId, userIdHash: hashPii(ctx.userId), findings: found.size, raised });
  return { status: "ok", findings: found.size, raised };
}
