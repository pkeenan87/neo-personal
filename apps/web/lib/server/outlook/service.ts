/**
 * Connect, disconnect and view for the Outlook.com connector (_specs/outlook-connector.md). Routes call these with the
 * browser session; nothing here logs tokens, codes, PKCE material or cursors.
 */
import { randomUUID } from "node:crypto";
import { hashPii, logger } from "@neo/core";
import type { NeoSession } from "@/lib/session";
import { tenantMembers } from "../alerts";
import { auditOutlookRules } from "./audit";
import { decryptPkceVerifier, encryptPkceVerifier, encryptTokens, hashState } from "./crypto";
import type { OutlookDeps } from "./deps";
import { newPkce, newState, OutlookOAuthError } from "./oauth";
import type { OutlookConnectorStatus } from "./types";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Where a member removes Neo's access at Microsoft; disconnecting here only deletes Neo's local copy. */
export const MICROSOFT_APP_ACCESS_URL = "https://account.microsoft.com/privacy/app-access";

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** Create a single-use state transaction and the Microsoft authorize URL. */
export async function startOutlookConnect(session: NeoSession, deps: OutlookDeps): Promise<{ authorizeUrl: string }> {
  const now = deps.now();
  await deps.store.purgeStates(session.tenantId, now);
  const state = newState();
  const pkce = newPkce();
  const stateId = randomUUID();
  await deps.store.createState(session.tenantId, {
    id: stateId,
    userId: session.userId,
    stateHash: hashState(state),
    encryptedPkceVerifier: encryptPkceVerifier(pkce.verifier, { tenantId: session.tenantId, userId: session.userId, stateId }, deps.source),
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
  });
  return { authorizeUrl: deps.oauth.authorizeUrl({ state, codeChallenge: pkce.challenge }) };
}

export type ConnectOutcome = "connected" | "denied" | "invalid_state" | "failed";

/**
 * The OAuth callback. Validates and consumes the state (hash match, session user, expiry, single use) before the code is
 * exchanged. `error` is Microsoft's error code only; its description is never read or echoed.
 */
export async function completeOutlookConnect(
  session: NeoSession,
  params: { code?: string | null; state?: string | null; error?: string | null },
  deps: OutlookDeps,
): Promise<ConnectOutcome> {
  if (!params.state) return "invalid_state";
  const now = deps.now();
  const row = await deps.store.consumeState(session.tenantId, hashState(params.state), session.userId, now);
  if (!row) return "invalid_state";
  if (params.error) return params.error === "access_denied" ? "denied" : "failed";
  if (!params.code) return "failed";
  try {
    const verifier = decryptPkceVerifier(row.encryptedPkceVerifier, { tenantId: session.tenantId, userId: session.userId, stateId: row.id }, deps.source);
    const tokens = await deps.oauth.exchangeCode({ code: params.code, codeVerifier: verifier });
    if (!tokens.refreshToken) return "failed";
    const me = await deps.graphFor(tokens.accessToken).getMe();
    const existing = await deps.store.getConnector(session.tenantId, session.userId);
    const connectorId = existing?.id ?? randomUUID();
    const connector = await deps.store.upsertConnected(session.tenantId, {
      id: connectorId,
      userId: session.userId,
      microsoftUserId: me.id,
      displayAddress: me.displayAddress.slice(0, 254),
      encryptedTokens: encryptTokens(
        { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: new Date(now.getTime() + tokens.expiresIn * 1000).toISOString() },
        { tenantId: session.tenantId, userId: session.userId, connectorId },
        deps.source,
      ),
    });
    // Audit on connect. A failure here must not undo the connection; the daily run retries.
    await auditOutlookRules({ tenantId: session.tenantId, userId: session.userId, connectorId: connector.id }, deps).catch((err) =>
      logger.error("Outlook connect audit failed", "outlook", { tenantId: session.tenantId, errorMessage: errText(err) }),
    );
    return "connected";
  } catch (err) {
    logger.error("Outlook connect failed", "outlook", { tenantId: session.tenantId, userIdHash: hashPii(session.userId), errorType: err instanceof OutlookOAuthError ? err.code : "error", errorMessage: err instanceof OutlookOAuthError ? undefined : errText(err) });
    return "failed";
  }
}

/** Delete the local token and cursor ciphertext and stop scheduled work. Idempotent. Findings and alerts follow their retention. */
export async function disconnectOutlook(session: NeoSession, deps: OutlookDeps): Promise<{ disconnected: boolean }> {
  return { disconnected: await deps.store.disconnect(session.tenantId, session.userId) };
}

export type OutlookView = {
  mode: "live" | "mock" | "off";
  connector: null | { status: OutlookConnectorStatus; displayAddress: string; lastAuditAt: string | null; lastPollAt: string | null };
  /** The member's own findings (resolved ones included, newest first). */
  findings: { id: string; state: "active" | "resolved"; action: string; destinationDomain: string | null; observedAt: string; resolvedAt: string | null }[];
  /** Owners only: who in the household is connected and when it was last checked. No address, no mailbox content, no rules. */
  household?: { userId: string; name: string; status: OutlookConnectorStatus; lastCheckAt: string | null }[];
  appAccessUrl: string;
};

const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

export async function getOutlookView(session: NeoSession, mode: OutlookView["mode"], store: OutlookDeps["store"]): Promise<OutlookView> {
  const base: OutlookView = { mode, connector: null, findings: [], appAccessUrl: MICROSOFT_APP_ACCESS_URL };
  const [connector, findings] = await Promise.all([store.getConnector(session.tenantId, session.userId), store.listFindings(session.tenantId, session.userId)]);
  const view: OutlookView = {
    ...base,
    connector: connector && connector.status !== "disconnected" ? { status: connector.status, displayAddress: connector.displayAddress, lastAuditAt: iso(connector.lastAuditAt), lastPollAt: iso(connector.lastPollAt) } : null,
    findings: findings
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
      .map((f) => ({ id: f.id, state: f.state, action: f.action, destinationDomain: f.destinationDomain ?? null, observedAt: f.observedAt.toISOString(), resolvedAt: iso(f.resolvedAt) })),
  };
  if (session.role !== "owner") return view;
  const [summaries, members] = await Promise.all([store.listSummaries(session.tenantId), tenantMembers(session.tenantId)]);
  view.household = summaries
    .filter((s) => s.userId !== session.userId && s.status !== "disconnected")
    .map((s) => {
      const m = members.find((x) => x.userId === s.userId);
      const last = [s.lastAuditAt, s.lastPollAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
      return { userId: s.userId, name: (m?.name ?? m?.email?.split("@")[0] ?? "A member").slice(0, 60), status: s.status, lastCheckAt: iso(last) };
    });
  return view;
}
