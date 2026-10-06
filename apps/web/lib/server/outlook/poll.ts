/**
 * Bounded Inbox delta poll (_specs/outlook-connector.md), every 15 minutes from Inngest.
 *
 * Order per page: (1) delta page with a body-less `$select` and `Prefer: odata.maxpagesize=50`; (2) prefilter on step 4's
 * `SIGNIN_ALERT_SENDERS`; (3) per candidate GET of `internetMessageHeaders` plus body; (4) `analyzeEmail` then the step-4
 * sign-in path. At most 10 pages per run. The encrypted cursor is saved after each fully processed page, so a failed page
 * is retried from the last durable cursor. The first run is the 30-day baseline: pages advance the cursor without fetching
 * any message and raise nothing. A 429 stops the run and reports the (capped) wait for the caller's Inngest sleep.
 *
 * Idempotency across runs: each candidate's keyed message-id fingerprint is claimed (insert-if-absent) before it is
 * processed, so a message Graph re-emits in a later delta run is skipped; a transient Graph failure releases the claim so
 * the retry still processes it. Every cursor and time write is fenced on `status = 'connected'` and the connection
 * generation read at the start, so a poll in flight across a disconnect or reconnect writes nothing.
 */
import { hashPii, logger } from "@neo/core";
import { decryptCursor, encryptCursor, messageKey, type DeltaCursor } from "./crypto";
import { isAlertSenderCandidate } from "./candidates";
import { processCandidate } from "./candidate";
import type { OutlookDeps } from "./deps";
import { withGraph } from "./token";
import { GraphHttpError, GraphRateLimitError, type OutlookRunCtx } from "./types";

export const MAX_PAGES_PER_RUN = 10;
export const BASELINE_DAYS = 30;

export type OutlookPollResult = {
  status: "ok" | "skipped" | "reauth_required" | "rate_limited" | "reset";
  pages: number;
  candidates: number;
  /** Seconds to wait before the next attempt (status `rate_limited`), at most one hour. */
  retryAfterSeconds?: number;
};

export async function pollOutlookInbox(ctx: OutlookRunCtx, deps: OutlookDeps): Promise<OutlookPollResult> {
  const result: OutlookPollResult = { status: "ok", pages: 0, candidates: 0 };
  const connector = await deps.store.getConnectorById(ctx.tenantId, ctx.connectorId);
  if (!connector || connector.userId !== ctx.userId || connector.status !== "connected") return { ...result, status: "skipped" };
  const identity = { tenantId: ctx.tenantId, userId: ctx.userId, connectorId: ctx.connectorId };
  const generation = connector.connectionGeneration;
  const now = deps.now();

  let cursor: DeltaCursor | undefined;
  if (connector.encryptedDeltaCursor) {
    try {
      cursor = decryptCursor(connector.encryptedDeltaCursor, identity, deps.source);
    } catch {
      // Unreadable (key rotated, tampered): restart as a baseline, which raises nothing, rather than wedge the connector.
      logger.warn("Outlook cursor unreadable; restarting baseline", "outlook", { tenantId: ctx.tenantId, connectorId: ctx.connectorId });
    }
  }
  const since = cursor?.since ?? new Date(now.getTime() - BASELINE_DAYS * 86_400_000).toISOString();
  let baselineComplete = cursor?.baselineComplete ?? false;
  let link = cursor ? { kind: cursor.kind, url: cursor.link } : undefined;
  let done = new Set(cursor?.done ?? []);

  const save = (c: DeltaCursor) => deps.store.updateCursor(ctx.tenantId, ctx.connectorId, generation, encryptCursor(c, identity, deps.source));
  const superseded = (): OutlookPollResult => ({ ...result, status: "skipped" });

  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const fetched = await withGraph(ctx, deps, (graph) =>
        graph.getInboxDelta({ ...(link?.kind === "next" ? { nextLink: link.url } : {}), ...(link?.kind === "delta" ? { deltaLink: link.url } : {}), ...(link ? {} : { since: new Date(since) }) }),
      );
      if (!fetched.ok) return { ...result, status: fetched.reason === "reauth_required" ? "reauth_required" : "skipped" };
      const delta = fetched.value;
      result.pages++;

      if (baselineComplete) {
        for (const m of delta.messages) {
          if (m.removed || done.has(m.id) || !isAlertSenderCandidate(m.fromAddress)) continue;
          const key = messageKey(m.id, ctx.tenantId, deps.source);
          if (!(await deps.store.claimMessage(ctx.tenantId, ctx.connectorId, generation, key, now))) {
            done.add(m.id); // handled by an earlier run (or the connector changed, which the next cursor write detects)
            continue;
          }
          result.candidates++;
          try {
            const run = await withGraph(ctx, deps, (graph) => processCandidate(ctx, graph, m.id, deps));
            if (!run.ok) {
              await deps.store.releaseMessage(ctx.tenantId, ctx.connectorId, key);
              return { ...result, status: run.reason === "reauth_required" ? "reauth_required" : "skipped" };
            }
          } catch (err) {
            // Graph failures fail the page (it is retried from the last cursor, so the claim is released); a bug in analysis of one message must not wedge the mailbox.
            const gone = err instanceof GraphHttpError && (err.status === 404 || err.status === 410); // deleted or moved since the delta page
            if (!gone && (err instanceof GraphRateLimitError || err instanceof GraphHttpError)) {
              await deps.store.releaseMessage(ctx.tenantId, ctx.connectorId, key);
              throw err;
            }
            if (gone) { done.add(m.id); continue; }
            logger.error("Outlook candidate failed", "outlook", { tenantId: ctx.tenantId, connectorId: ctx.connectorId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
          }
          done.add(m.id);
          if (link && !(await save({ kind: link.kind, link: link.url, baselineComplete, since, done: [...done] }))) return superseded();
        }
      }

      const nextUrl = delta.nextLink ?? delta.deltaLink;
      if (!nextUrl) throw new GraphHttpError(502);
      baselineComplete = baselineComplete || delta.deltaLink !== undefined;
      link = { kind: delta.nextLink ? "next" : "delta", url: nextUrl };
      done = new Set();
      if (!(await save({ kind: link.kind, link: link.url, baselineComplete, since }))) return superseded();
      if (delta.deltaLink) break;
    }
  } catch (err) {
    if (err instanceof GraphRateLimitError) return { ...result, status: "rate_limited", retryAfterSeconds: err.retryAfterSeconds };
    if (err instanceof GraphHttpError && err.status === 410) {
      // The delta state expired (Graph "syncStateNotFound"): drop it; the next run re-baselines.
      if (!(await deps.store.updateCursor(ctx.tenantId, ctx.connectorId, generation, null))) return superseded();
      await deps.store.touch(ctx.tenantId, ctx.connectorId, generation, { lastPollAt: now });
      return { ...result, status: "reset" };
    }
    throw err;
  }
  if (!(await deps.store.touch(ctx.tenantId, ctx.connectorId, generation, { lastPollAt: now }))) return superseded();
  logger.info("Outlook poll finished", "outlook", { tenantId: ctx.tenantId, userIdHash: hashPii(ctx.userId), pages: result.pages, candidates: result.candidates });
  return result;
}
