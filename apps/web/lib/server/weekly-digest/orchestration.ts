import { logger } from "@neo/core";
import type { DigestServices } from "./data";
import { digestResendIdempotencyKey, digestPeriod, type DigestGenerateEvent, type DigestPeriod } from "./period";
import type { DigestContent } from "./content";
import type { DigestRecipientStore } from "./store";
import { signDigestUnsubscribe } from "./unsubscribe";
import { renderWeeklyDigest } from "../email/weekly-digest-email";
import { MailerHttpError, type Mailer, type OutgoingEmail } from "../email/resend";
import type { EnvSource } from "@/lib/env";

export interface DigestStepTools {
  run<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
}
export interface DigestCronStepTools extends DigestStepTools {
  sendEvent(id: string, events: Array<{ id: string; name: string; data: DigestGenerateEvent }>): Promise<unknown>;
}
export type DigestSendPayload = {
  email: OutgoingEmail;
  role: "owner" | "member";
  deliveryCreatedAt: string;
};
export type DigestDeliveryResult =
  | { status: "sent"; providerMessageId: string }
  | { status: "empty" | "failed" | "skipped" };

const DISCOVERY_PAGE_SIZE = 1000;
const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Freeze the period in a durable step, then fan out recipient IDs only. */
export async function runWeeklyDigestCron(
  step: DigestCronStepTools,
  recipients: DigestRecipientStore,
  now: () => Date = () => new Date(),
): Promise<{ period: { scheduledAt: string; periodStart: string; periodEnd: string; isoWeek: string }; recipients: number }> {
  const period: DigestPeriod = await step.run("digest-period", () => digestPeriod(undefined, now()));
  let cursor: string | undefined;
  let page = 0;
  let total = 0;
  do {
    const currentCursor = cursor;
    const result = await step.run(`digest-recipients-${page}`, () => recipients.listDigestRecipientPairs(currentCursor, DISCOVERY_PAGE_SIZE));
    if (result.items.length > DISCOVERY_PAGE_SIZE) throw new Error("digest recipient page exceeded 1000");
    if (result.nextCursor && result.nextCursor === cursor) throw new Error("digest recipient cursor did not advance");
    const events = result.items.map(({ tenantId, userId }) => ({
      id: `digest:${userId}:${period.isoWeek}`,
      name: "neo/digest.generate",
      data: {
        tenantId,
        userId,
        scheduledAt: period.scheduledAt.toISOString(),
        periodStart: period.periodStart.toISOString(),
        periodEnd: period.periodEnd.toISOString(),
        isoWeek: period.isoWeek,
      },
    }));
    if (events.length) await step.sendEvent(`digest-send-batch-${page}`, events);
    total += events.length;
    cursor = result.nextCursor;
    page++;
  } while (cursor);
  return {
    period: {
      scheduledAt: period.scheduledAt.toISOString(),
      periodStart: period.periodStart.toISOString(),
      periodEnd: period.periodEnd.toISOString(),
      isoWeek: period.isoWeek,
    },
    recipients: total,
  };
}

function hasReportableContent(content: DigestContent): boolean {
  return Boolean(content.personal || content.household || content.breachStatus || content.hardeningScore);
}

async function finish(
  services: DigestServices,
  event: DigestGenerateEvent,
  runId: string,
  state: "empty" | "failed" | "sent",
  now: Date,
  providerMessageId?: string,
): Promise<void> {
  await services.store.finishDelivery({
    tenantId: event.tenantId,
    userId: event.userId,
    isoWeek: event.isoWeek,
    runId,
    state,
    now,
    ...(providerMessageId ? { providerMessageId } : {}),
  });
}

async function prepareSendPayload(
  event: DigestGenerateEvent,
  runId: string,
  services: DigestServices,
  appUrl: string,
  source: EnvSource,
  now: () => Date,
): Promise<{ status: "ready"; payload: DigestSendPayload } | { status: "empty" | "failed" | "skipped" }> {
  const recipient = await services.resolveRecipient(event.tenantId, event.userId);
  if (!recipient || recipient.tenantId !== event.tenantId || recipient.userId !== event.userId) return { status: "skipped" };

  const claimed = await services.store.claimDelivery({
    tenantId: event.tenantId,
    userId: event.userId,
    isoWeek: event.isoWeek,
    periodStart: new Date(event.periodStart),
    periodEnd: new Date(event.periodEnd),
    runId,
    now: now(),
  });
  if (claimed.result === "household_move_collision") {
    logger.warn("Weekly digest skipped after a household-move collision", "weekly-digest");
    return { status: "skipped" };
  }
  if (claimed.result === "owned_live") return { status: "skipped" };
  if (claimed.result === "terminal") {
    return { status: claimed.delivery?.state === "empty" ? "empty" : claimed.delivery?.state === "failed" ? "failed" : "skipped" };
  }
  if (!claimed.delivery) throw new Error("claimed weekly digest delivery has no row");

  // Re-resolve membership, role, verified address, and consent at content-selection time.
  const current = await services.resolveRecipient(event.tenantId, event.userId);
  if (!current || current.tenantId !== event.tenantId || current.userId !== event.userId) {
    await finish(services, event, runId, "failed", now());
    return { status: "failed" };
  }
  const content = await services.content.loadDigestContent({
    tenantId: event.tenantId,
    userId: event.userId,
    role: current.role,
    periodStart: new Date(event.periodStart),
    periodEnd: new Date(event.periodEnd),
  });
  const afterContent = await services.resolveRecipient(event.tenantId, event.userId);
  if (!afterContent || afterContent.tenantId !== event.tenantId || afterContent.userId !== event.userId ||
    afterContent.email !== current.email || afterContent.role !== current.role) {
    await finish(services, event, runId, "failed", now());
    return { status: "failed" };
  }
  if (!hasReportableContent(content)) {
    await finish(services, event, runId, "empty", now());
    return { status: "empty" };
  }

  const token = signDigestUnsubscribe({ tenantId: event.tenantId, userId: event.userId }, source);
  if (!token) {
    await finish(services, event, runId, "failed", now());
    logger.warn("Weekly digest unsubscribe signing is unavailable", "weekly-digest");
    return { status: "failed" };
  }
  try {
    const unsubscribeUrl = new URL(`/api/digest/unsubscribe?token=${encodeURIComponent(token)}`, appUrl).href;
    const rendered = renderWeeklyDigest(content, unsubscribeUrl);
    const email: OutgoingEmail = {
      to: current.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: digestResendIdempotencyKey(event.userId, event.isoWeek),
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
    // Successful step outputs are durable Inngest state; this contains the exact request for retries.
    return { status: "ready", payload: { email, role: current.role, deliveryCreatedAt: claimed.delivery.createdAt.toISOString() } };
  } catch {
    await finish(services, event, runId, "failed", now());
    logger.warn("Weekly digest request could not be prepared", "weekly-digest");
    return { status: "failed" };
  }
}

/** Persist the exact request in Inngest step state; transient send failures replay it byte-for-byte. */
export async function runWeeklyDigestDelivery(
  event: DigestGenerateEvent,
  runId: string,
  step: DigestStepTools,
  deps: {
    services: DigestServices;
    mailer: Mailer | null;
    appUrl: string;
    env?: EnvSource;
    now?: () => Date;
  },
): Promise<DigestDeliveryResult> {
  const now = deps.now ?? (() => new Date());
  const source = deps.env ?? process.env;
  const prepared = await step.run("digest-prepare-payload", () => prepareSendPayload(
    event,
    runId,
    deps.services,
    deps.appUrl,
    source,
    now,
  ));
  if (prepared.status !== "ready") return { status: prepared.status };

  return step.run("digest-send-email", async () => {
    const time = now();
    const current = await deps.services.resolveRecipient(event.tenantId, event.userId);
    if (!current || current.tenantId !== event.tenantId || current.userId !== event.userId ||
      current.email !== prepared.payload.email.to || current.role !== prepared.payload.role) {
      await finish(deps.services, event, runId, "failed", time);
      return { status: "failed" } as const;
    }
    if (+time - Date.parse(prepared.payload.deliveryCreatedAt) >= RESEND_IDEMPOTENCY_WINDOW_MS) {
      await finish(deps.services, event, runId, "failed", time);
      logger.warn("Weekly digest retry stopped after the provider idempotency window", "weekly-digest");
      return { status: "failed" } as const;
    }
    if (!deps.mailer) {
      await finish(deps.services, event, runId, "failed", time);
      logger.warn("Weekly digest mailer is unavailable", "weekly-digest");
      return { status: "failed" } as const;
    }
    try {
      const result = await deps.mailer.send(prepared.payload.email);
      await finish(deps.services, event, runId, "sent", now(), result.id);
      return { status: "sent", providerMessageId: result.id } as const;
    } catch (error) {
      if (error instanceof MailerHttpError && error.status >= 400 && error.status < 500) {
        await finish(deps.services, event, runId, "failed", now());
        return { status: "failed" } as const;
      }
      throw error;
    }
  });
}
