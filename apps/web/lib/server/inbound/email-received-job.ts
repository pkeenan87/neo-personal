/**
 * The `email-received` job (_specs/forward-to-address.md) as plain functions
 * with injected dependencies. The Inngest function (inngest/functions/
 * email-received.ts) passes Inngest's `step`; MOCK_MODE without an Inngest
 * event key and the tests pass `inlineSteps`.
 *
 * Steps: fetch-raw → store-artifact → identify-forwarder → check-caps →
 * analyze → triage → save-verdict → notify. Step return values are plain JSON
 * (Inngest memoizes them), so no Dates or byte arrays cross a step boundary.
 */
import { hashPii, logger } from "@neo/core";
import type { Verdict } from "@neo/verdict";
import type { AuditEventType } from "../audit";
import { overCapVerdict, renderNoticeEmail, renderVerdictEmail, type NoticeKind } from "../email/verdict-email";
import { TooLargeError, type Mailer, type ReceivedEmail, type ReceivedMailClient } from "../email/resend";
import type {
  ArtifactStore,
  EmailAnalysis,
  EmailInput,
  InboundMessagePatch,
  InboundMessageRow,
  MemberRow,
  TriageInput,
  TriageResult,
  VerdictSource,
} from "../phase1-stubs-inbound";
import type { CapCheckResult, RecordCheckInput } from "../usage";
import {
  GMAIL_CONFIRMATION_PREFIX,
  forwarderCandidates,
  isGmailForwardingConfirmation,
  matchForwarder,
  parseGmailConfirmation,
} from "./senders";

export const EMAIL_RECEIVED_EVENT = "neo/email.received";
export const MAX_RAW_BYTES = 2 * 1024 * 1024;
export const MAX_URLS = 6;

export interface EmailReceivedData {
  inboundMessageId: string;
  tenantId: string;
  /** Resend `email_id` (= inbound_messages.provider_message_id). */
  emailId: string;
}

export interface StepRunner {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** Runs each step once, in order (no memoization or retries). */
export const inlineSteps: StepRunner = { run: (_name, fn) => fn() };

export interface EmailJobDeps {
  mail: ReceivedMailClient;
  artifacts: ArtifactStore | null;
  mailer: Mailer | null;
  listMembers(tenantId: string): Promise<MemberRow[]>;
  updateMessage(id: string, tenantId: string, patch: InboundMessagePatch): Promise<void>;
  findMessage(id: string, tenantId: string): Promise<InboundMessageRow | undefined>;
  checkCaps(tenantId: string): Promise<CapCheckResult>;
  noteCapHit?(tenantId: string, userId: string, caps: CapCheckResult): Promise<void>;
  recordUsage(input: RecordCheckInput): Promise<void>;
  analyzeEmail(input: EmailInput, opts: { maxUrls: number }): Promise<EmailAnalysis>;
  runTriage(input: TriageInput): Promise<TriageResult>;
  triageGuidance: string;
  saveVerdict(input: { tenantId: string; userId: string; artifactId?: string; source: VerdictSource; verdict: Verdict }): Promise<{ id: string }>;
  audit(tenantId: string, userId: string | null, type: AuditEventType, metadata: Record<string, unknown>): Promise<void>;
  appUrl: string;
  now?: () => Date;
}

export type JobOutcome =
  | { status: "done"; verdictId: string }
  | { status: "over_cap"; verdictId: string }
  | { status: "rejected"; reason: "unknown_sender" | "gmail_confirmation" }
  | { status: "failed"; reason: NoticeKind | "no_members" };

type Stored = { artifactId: string; sizeBytes: number } | { error: "too_large" | "storage_unavailable" | "no_members" };
type Forwarder = { kind: "member"; userId: string; email: string } | { kind: "rejected" } | { kind: "gmail_confirmation" };

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function sendNotice(
  deps: EmailJobDeps,
  data: EmailReceivedData,
  to: string,
  kind: NoticeKind,
  forwardedSubject: string | null,
): Promise<void> {
  if (!deps.mailer) return;
  const email = renderNoticeEmail(kind, { appUrl: deps.appUrl, forwardedSubject });
  await deps.mailer.send({ to, ...email, idempotencyKey: `inbound-${data.inboundMessageId}-${kind}` });
}

export async function runEmailReceived(data: EmailReceivedData, deps: EmailJobDeps, step: StepRunner = inlineSteps): Promise<JobOutcome> {
  const { inboundMessageId: id, tenantId } = data;
  const now = () => (deps.now ? deps.now() : new Date());

  // 1. fetch-raw: the received email's metadata and signed raw URL from Resend.
  const meta = await step.run("fetch-raw", async (): Promise<ReceivedEmail> => {
    await deps.updateMessage(id, tenantId, { status: "analyzing" });
    return deps.mail.getReceived(data.emailId);
  });

  // 2. store-artifact: download (≤ 2 MB) and store as an encrypted inbound_eml artifact.
  const stored = await step.run("store-artifact", async (): Promise<Stored> => {
    if (!deps.artifacts) return { error: "storage_unavailable" };
    const members = await deps.listMembers(tenantId);
    // The forwarder is identified in the next step; the artifact is attributed to the owner until then.
    const owner = members.find((m) => m.role === "owner") ?? members[0];
    if (!owner) return { error: "no_members" };
    let bytes: Uint8Array;
    try {
      bytes = await deps.mail.downloadRaw(meta, MAX_RAW_BYTES);
    } catch (err) {
      if (err instanceof TooLargeError) return { error: "too_large" };
      throw err;
    }
    const artifact = await deps.artifacts.put({
      tenantId,
      userId: owner.userId,
      kind: "inbound_eml",
      filename: "forwarded.eml",
      mimeType: "message/rfc822",
      bytes,
      source: "inbound",
    });
    await deps.updateMessage(id, tenantId, { artifactId: artifact.id });
    return { artifactId: artifact.id, sizeBytes: bytes.byteLength };
  });
  const artifactId = "artifactId" in stored ? stored.artifactId : undefined;

  // 3. identify-forwarder: a verified member email of this household, or reject.
  const forwarder = await step.run("identify-forwarder", async (): Promise<Forwarder> => {
    const purge = async () => {
      if (artifactId && deps.artifacts) await deps.artifacts.delete(artifactId, tenantId);
    };
    if (isGmailForwardingConfirmation(meta)) {
      let raw = "";
      if (artifactId && deps.artifacts) {
        const bytes = await deps.artifacts.read(artifactId, tenantId);
        raw = bytes ? new TextDecoder().decode(bytes) : "";
      }
      const confirmation = parseGmailConfirmation(meta.subject, raw);
      await purge();
      await deps.updateMessage(id, tenantId, {
        status: "rejected",
        error: confirmation ? `${GMAIL_CONFIRMATION_PREFIX}${confirmation.code}` : "gmail_confirmation_unparsed",
        artifactId: null,
        completedAt: now(),
      });
      await deps.audit(tenantId, null, "inbound.gmail_forwarding_confirmation", {
        inboundMessageId: id,
        ...(confirmation?.requester ? { requesterHash: hashPii(confirmation.requester) } : {}),
      });
      return { kind: "gmail_confirmation" };
    }
    const members = await deps.listMembers(tenantId);
    const member = matchForwarder(forwarderCandidates(meta), members);
    if (!member?.email) {
      await purge();
      await deps.updateMessage(id, tenantId, { status: "rejected", error: "unknown_sender", artifactId: null, completedAt: now() });
      await deps.audit(tenantId, null, "inbound.rejected_unknown_sender", {
        inboundMessageId: id,
        fromHash: hashPii(meta.from.toLowerCase()),
      });
      return { kind: "rejected" };
    }
    await deps.updateMessage(id, tenantId, { forwarderUserId: member.userId });
    return { kind: "member", userId: member.userId, email: member.email };
  });

  if (forwarder.kind === "gmail_confirmation") return { status: "rejected", reason: "gmail_confirmation" };
  if (forwarder.kind === "rejected") return { status: "rejected", reason: "unknown_sender" };

  if (!artifactId) {
    const reason = "error" in stored ? stored.error : "storage_unavailable";
    await step.run("notify", async () => {
      await deps.updateMessage(id, tenantId, { status: "failed", error: reason, completedAt: now() });
      if (reason !== "no_members") await sendNotice(deps, data, forwarder.email, reason, meta.subject);
      return null;
    });
    return { status: "failed", reason };
  }

  // 4. check-caps: over → an over_cap verdict and notification, no model call.
  const caps = await step.run("check-caps", async () => {
    const c = await deps.checkCaps(tenantId);
    if (!c.allowed && deps.noteCapHit) await deps.noteCapHit(tenantId, forwarder.userId, c);
    const resetAt = c.reason === "daily_tokens" ? c.resetAt.dailyTokens : c.resetAt.monthlyChecks;
    return {
      allowed: c.allowed,
      resetAt: resetAt.toISOString(),
      remainingChecks: c.remaining.monthlyChecks,
      monthlyLimit: c.limits.monthlyChecks,
    };
  });

  if (!caps.allowed) {
    const verdictId = await step.run("save-verdict", async () => {
      const { id: vid } = await deps.saveVerdict({
        tenantId,
        userId: forwarder.userId,
        artifactId,
        source: "inbound",
        verdict: { ...overCapVerdict(new Date(caps.resetAt)), raw_ref: artifactId },
      });
      await deps.updateMessage(id, tenantId, { status: "over_cap", verdictId: vid });
      return vid;
    });
    await step.run("notify", async () => {
      await notifyVerdict(deps, forwarder.email, verdictId, overCapVerdict(new Date(caps.resetAt)), meta.subject);
      await deps.updateMessage(id, tenantId, { completedAt: now() });
      return null;
    });
    return { status: "over_cap", verdictId };
  }

  // 5. analyze
  const analysis = await step.run("analyze", async () => {
    const raw = await deps.artifacts!.read(artifactId, tenantId);
    if (!raw) throw new Error("inbound artifact is missing");
    return deps.analyzeEmail({ raw }, { maxUrls: MAX_URLS });
  });

  // 6. triage (one structured-output call)
  const triage = await step.run("triage", () =>
    deps.runTriage({ evidence: analysis, evidenceKind: "email", guidance: deps.triageGuidance }),
  );

  const verdict: Verdict = { ...triage.verdict, raw_ref: artifactId };
  const verdictId = await step.run("save-verdict", async () => {
    const { id: vid } = await deps.saveVerdict({ tenantId, userId: forwarder.userId, artifactId, source: "inbound", verdict });
    await deps.recordUsage({
      tenantId,
      userId: forwarder.userId,
      model: triage.model,
      inputTokens: triage.usage.input_tokens,
      outputTokens: triage.usage.output_tokens,
      ...(triage.usage.cache_read_input_tokens ? { cacheReadTokens: triage.usage.cache_read_input_tokens } : {}),
      ...(triage.usage.cache_creation_input_tokens ? { cacheCreationTokens: triage.usage.cache_creation_input_tokens } : {}),
      kind: "check",
    });
    await deps.updateMessage(id, tenantId, { verdictId: vid });
    return vid;
  });

  // 7. notify
  await step.run("notify", async () => {
    await notifyVerdict(deps, forwarder.email, verdictId, verdict, meta.subject, {
      remaining: Math.max(0, caps.remainingChecks - 1),
      limit: caps.monthlyLimit,
    });
    await deps.updateMessage(id, tenantId, { status: "done", completedAt: now() });
    return null;
  });
  return { status: "done", verdictId };
}

async function notifyVerdict(
  deps: EmailJobDeps,
  to: string,
  verdictId: string,
  verdict: Verdict,
  forwardedSubject: string,
  usage?: { remaining: number; limit: number },
): Promise<void> {
  if (!deps.mailer) {
    logger.warn("Inbound verdict not emailed: no mailer configured", "inbound", { verdictId });
    return;
  }
  const email = renderVerdictEmail(verdict, {
    detailUrl: `${deps.appUrl}/verdicts/${encodeURIComponent(verdictId)}`,
    forwardedSubject,
    ...(usage ? { usage } : {}),
  });
  await deps.mailer.send({ to, ...email, idempotencyKey: `verdict-${verdictId}` });
}

/** After the final retry: status `failed`, and tell the forwarder when we know who they are. */
export async function handleEmailReceivedFailure(data: EmailReceivedData, deps: EmailJobDeps, error: unknown): Promise<void> {
  const { inboundMessageId: id, tenantId } = data;
  logger.error("Inbound email job failed", "inbound", { tenantId, inboundMessageId: id, errorMessage: errText(error) });
  try {
    const row = await deps.findMessage(id, tenantId);
    if (row && (row.status === "done" || row.status === "rejected" || row.status === "over_cap")) return;
    await deps.updateMessage(id, tenantId, { status: "failed", error: "job_failed", completedAt: new Date() });
    if (!row?.forwarderUserId) return;
    const member = (await deps.listMembers(tenantId)).find((m) => m.userId === row.forwarderUserId);
    if (!member?.email) return;
    const subject = await deps.mail
      .getReceived(data.emailId)
      .then((m) => m.subject)
      .catch(() => null);
    await sendNotice(deps, data, member.email, "failed", subject);
  } catch (err) {
    logger.error("Inbound failure handling failed", "inbound", { tenantId, inboundMessageId: id, errorMessage: errText(err) });
  }
}

/** MOCK_MODE inline path: run every step once; on error, the failure handler. */
export async function runEmailReceivedInline(data: EmailReceivedData, deps: EmailJobDeps): Promise<JobOutcome | undefined> {
  try {
    return await runEmailReceived(data, deps, inlineSteps);
  } catch (err) {
    await handleEmailReceivedFailure(data, deps, err);
    return undefined;
  }
}
