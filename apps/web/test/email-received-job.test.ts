// @vitest-environment node
import { createMockTriageClient, runTriage } from "@neo/core";
import { createMemoryBlobClient, utcWindows, type ArtifactStore, type CapCheckResult } from "@neo/db";
import { analyzeEmail } from "@neo/tools";
import { VerdictSchema } from "@neo/verdict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMailer,
  memorySentEmails,
  TooLargeError,
  type ReceivedEmail,
  type ReceivedMailClient,
} from "@/lib/server/email/resend";
import { runArtifactsExpire } from "@/lib/server/inbound/artifacts-expire-job";
import {
  MAX_RAW_BYTES,
  MAX_URLS,
  handleEmailReceivedFailure,
  runEmailReceived,
  runEmailReceivedInline,
  type EmailJobDeps,
  type StepRunner,
} from "@/lib/server/inbound/email-received-job";
import { memoryInbound } from "@/lib/server/inbound/memory";
import { createInMemoryArtifactStore } from "@/lib/server/memory-artifact-store";
import { memoryListMembers, memoryState, resetMemoryState, saveMemoryVerdict, setMemoryMembers } from "@/lib/server/memory-state";
import { memorySigninStore } from "@/lib/server/signin/store";
import { triaged } from "./signin-fixtures";
import {
  GMAIL_CONFIRMATION_BODY,
  GMAIL_CONFIRMATION_SUBJECT,
  MEMBER,
  OWNER,
  TENANT,
  forwardedPhish,
  meta,
  rawEmail,
} from "./inbound-fixtures";

const ADDRESS = "check-abcdefghjkmn@inbound.example.test";

function caps(allowed: boolean, monthlyUsed = 3): CapCheckResult {
  const w = utcWindows(new Date("2026-09-24T12:00:00Z"));
  const limits = { monthlyChecks: 50, dailyTokens: 300_000 };
  return {
    allowed,
    ...(allowed ? {} : { reason: "monthly_checks" as const }),
    remaining: { monthlyChecks: Math.max(0, limits.monthlyChecks - monthlyUsed), dailyTokens: 290_000 },
    used: { monthlyChecks: monthlyUsed, dailyTokens: 10_000 },
    limits,
    resetAt: { monthlyChecks: w.monthEnd, dailyTokens: w.dayEnd },
  };
}

function mailClient(entries: Record<string, { meta: ReceivedEmail; raw: string | Uint8Array }>): ReceivedMailClient {
  return {
    getReceived: vi.fn(async (id: string) => {
      const e = entries[id];
      if (!e) throw new Error("not found");
      return e.meta;
    }),
    downloadRaw: vi.fn(async (m: ReceivedEmail, max: number) => {
      const raw = entries[m.id]!.raw;
      const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
      if (bytes.byteLength > max) throw new TooLargeError(max);
      return bytes;
    }),
  };
}

async function newMessage(emailId: string): Promise<{ inboundMessageId: string; tenantId: string; emailId: string }> {
  const addr = await memoryInbound.ensureAddress(TENANT);
  const { id } = await memoryInbound.recordMessage({
    tenantId: TENANT,
    addressId: addr.id,
    providerMessageId: emailId,
    fromAddressHash: "h",
    status: "received",
  });
  return { inboundMessageId: id, tenantId: TENANT, emailId };
}

function row(id: string) {
  return memoryState().inboundMessages.find((m) => m.id === id)!;
}

let blob: ReturnType<typeof createMemoryBlobClient>;
let artifacts: ArtifactStore;

function makeDeps(mail: ReceivedMailClient, overrides: Partial<EmailJobDeps> = {}): EmailJobDeps {
  return {
    mail,
    artifacts,
    mailer: createMockMailer("Neo <neo@example.test>"),
    listMembers: async (t) => memoryListMembers(t),
    updateMessage: memoryInbound.updateMessage,
    findMessage: memoryInbound.getMessage,
    checkCaps: vi.fn(async () => caps(true)),
    noteCapHit: vi.fn(async () => {}),
    recordUsage: vi.fn(async () => {}),
    // The real analyzer (offline fixtures) and triage (deterministic MOCK_MODE client).
    analyzeEmail: vi.fn((input, opts) => analyzeEmail(input, { ...opts, deps: { mock: true } })),
    runTriage: vi.fn((input) => runTriage({ ...input, client: createMockTriageClient(), model: "claude-sonnet-5" })),
    triageGuidance: "guidance",
    saveVerdict: async (input) => saveMemoryVerdict(input),
    audit: vi.fn(async () => {}),
    appUrl: "https://neo.example.test",
    ...overrides,
  };
}

/** Records step names like Inngest would see them. */
function recordingSteps(): StepRunner & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    run: async (name, fn) => {
      names.push(name);
      // Inngest memoizes JSON: round-trip every step result to catch non-serializable returns.
      const v = await fn();
      return v === undefined ? v : JSON.parse(JSON.stringify(v));
    },
  };
}

beforeEach(() => {
  resetMemoryState();
  blob = createMemoryBlobClient();
  artifacts = createInMemoryArtifactStore({ blob });
  memorySentEmails().length = 0;
  setMemoryMembers(TENANT, [OWNER, MEMBER]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("email-received job", () => {
  it("done: stores the artifact, triages, saves an inbound verdict, records usage and emails the forwarder", async () => {
    const data = await newMessage("em_done");
    const mail = mailClient({ em_done: { meta: meta("em_done", { from: `Sam <${MEMBER.email}>` }), raw: forwardedPhish(ADDRESS, MEMBER.email) } });
    const deps = makeDeps(mail);
    const steps = recordingSteps();

    const out = await runEmailReceived(data, deps, steps);

    expect(out.status).toBe("done");
    expect(steps.names).toEqual(["fetch-raw", "store-artifact", "identify-forwarder", "check-caps", "analyze", "triage", "signin-alert", "save-verdict", "notify"]);
    const r = row(data.inboundMessageId);
    expect(r).toMatchObject({ status: "done", forwarderUserId: MEMBER.userId });
    expect(r.completedAt).toBeInstanceOf(Date);
    expect(r.artifactId).toBeTruthy();

    // artifact
    const art = await artifacts.get(r.artifactId!, TENANT);
    expect(art).toMatchObject({ kind: "inbound_eml", source: "inbound", mimeType: "message/rfc822" });
    expect(await artifacts.get(r.artifactId!, "another-tenant")).toBeUndefined();

    // analysis + triage inputs
    expect(deps.analyzeEmail).toHaveBeenCalledWith({ raw: expect.any(Uint8Array) }, { maxUrls: MAX_URLS });
    expect(deps.runTriage).toHaveBeenCalledWith(expect.objectContaining({ evidenceKind: "email", guidance: "guidance" }));

    // verdict
    const v = memoryState().verdicts.find((x) => x.id === r.verdictId)!;
    expect(v).toMatchObject({ tenantId: TENANT, userId: MEMBER.userId, source: "inbound", artifactId: r.artifactId });
    expect(v.verdict.raw_ref).toBe(r.artifactId);
    expect(VerdictSchema.safeParse(v.verdict).success).toBe(true);
    expect(v.verdict.verdict).toBe("malicious"); // lookalike sender + phishing URL from the real analyzer

    // usage
    expect(deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: MEMBER.userId, model: "claude-sonnet-5", kind: "check" }),
    );

    // notification goes to the member's stored email, never a header value
    const sent = memorySentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: MEMBER.email, idempotencyKey: `verdict-${r.verdictId}` });
    expect(sent[0]!.subject).toBe('Neo: Malicious — "Fwd: Your account is locked"');
    expect(sent[0]!.html).toContain(`https://neo.example.test/verdicts/${r.verdictId}`);
  });

  it("notifies once even when the notify step is retried (idempotency key)", async () => {
    const data = await newMessage("em_twice");
    const mail = mailClient({ em_twice: { meta: meta("em_twice"), raw: forwardedPhish(ADDRESS) } });
    const deps = makeDeps(mail);
    await runEmailReceived(data, deps);
    const key = memorySentEmails()[0]!.idempotencyKey;
    await deps.mailer!.send({ to: OWNER.email, subject: "x", html: "x", text: "x", idempotencyKey: key });
    expect(memorySentEmails()).toHaveLength(1);
  });

  it("unknown forwarder: rejected, artifact purged, audited, no email, no model call", async () => {
    const data = await newMessage("em_stranger");
    const mail = mailClient({
      em_stranger: { meta: meta("em_stranger", { from: "stranger@elsewhere.test" }), raw: forwardedPhish(ADDRESS, "stranger@elsewhere.test") },
    });
    const deps = makeDeps(mail);

    const out = await runEmailReceived(data, deps);

    expect(out).toEqual({ status: "rejected", reason: "unknown_sender" });
    expect(row(data.inboundMessageId)).toMatchObject({ status: "rejected", error: "unknown_sender", artifactId: null });
    expect(blob.size).toBe(0);
    expect(memorySentEmails()).toHaveLength(0);
    expect(deps.analyzeEmail).not.toHaveBeenCalled();
    expect(deps.runTriage).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(TENANT, null, "inbound.rejected_unknown_sender", expect.objectContaining({ fromHash: expect.any(String) }));
  });

  it("rejects a member address when Resend reports DMARC fail (spoofed From)", async () => {
    const data = await newMessage("em_spoof");
    const mail = mailClient({
      em_spoof: { meta: meta("em_spoof", { authentication: { dmarc: "fail" } }), raw: forwardedPhish(ADDRESS) },
    });
    const out = await runEmailReceived(data, makeDeps(mail));
    expect(out.status).toBe("rejected");
  });

  it("does not strip plus-addresses (exact match only)", async () => {
    const data = await newMessage("em_plus");
    const mail = mailClient({ em_plus: { meta: meta("em_plus", { from: "alex+neo@example.test" }), raw: forwardedPhish(ADDRESS) } });
    expect((await runEmailReceived(data, makeDeps(mail))).status).toBe("rejected");
  });

  it("accepts a Gmail filter auto-forward (original From kept; forwarder in X-Forwarded-For / Return-Path)", async () => {
    const data = await newMessage("em_auto");
    const mail = mailClient({
      em_auto: {
        meta: meta("em_auto", {
          from: "service@paypa1-security.example",
          headers: {
            "x-forwarded-for": `${OWNER.email} ${ADDRESS}`,
            "return-path": "<alex+caf_=check-abcdefghjkmn=inbound.example.test@gmail.com>",
          },
        }),
        raw: forwardedPhish(ADDRESS),
      },
    });
    const out = await runEmailReceived(data, makeDeps(mail));
    expect(out.status).toBe("done");
    expect(memorySentEmails()[0]!.to).toBe(OWNER.email);
  });

  it("Gmail forwarding confirmation: code stored for the owner, not analyzed, artifact purged, no email", async () => {
    const data = await newMessage("em_gmail");
    const mail = mailClient({
      em_gmail: {
        meta: meta("em_gmail", {
          from: "Gmail Team <forwarding-noreply@google.com>",
          subject: GMAIL_CONFIRMATION_SUBJECT,
          authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
        }),
        raw: rawEmail({ from: "forwarding-noreply@google.com", to: ADDRESS, subject: GMAIL_CONFIRMATION_SUBJECT, body: GMAIL_CONFIRMATION_BODY }),
      },
    });
    const deps = makeDeps(mail);
    const out = await runEmailReceived(data, deps);

    expect(out).toEqual({ status: "rejected", reason: "gmail_confirmation" });
    expect(row(data.inboundMessageId)).toMatchObject({ status: "rejected", error: "gmail_confirmation:482915736", artifactId: null });
    expect(blob.size).toBe(0);
    expect(deps.analyzeEmail).not.toHaveBeenCalled();
    expect(memorySentEmails()).toHaveLength(0);
    expect(deps.audit).toHaveBeenCalledWith(TENANT, null, "inbound.gmail_forwarding_confirmation", expect.any(Object));
  });

  it("a fake Gmail confirmation that fails DMARC is treated as an unknown sender", async () => {
    const data = await newMessage("em_fakegmail");
    const mail = mailClient({
      em_fakegmail: {
        meta: meta("em_fakegmail", { from: "forwarding-noreply@google.com", subject: GMAIL_CONFIRMATION_SUBJECT, authentication: { dmarc: "fail" } }),
        raw: GMAIL_CONFIRMATION_BODY,
      },
    });
    const out = await runEmailReceived(data, makeDeps(mail));
    expect(out).toEqual({ status: "rejected", reason: "unknown_sender" });
  });

  it("over cap: over_cap verdict + notification with the reset date, no model call", async () => {
    const data = await newMessage("em_cap");
    const mail = mailClient({ em_cap: { meta: meta("em_cap"), raw: forwardedPhish(ADDRESS) } });
    const deps = makeDeps(mail, { checkCaps: vi.fn(async () => caps(false, 50)) });

    const out = await runEmailReceived(data, deps);

    expect(out.status).toBe("over_cap");
    expect(deps.analyzeEmail).not.toHaveBeenCalled();
    expect(deps.runTriage).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
    expect(deps.noteCapHit).toHaveBeenCalled();
    const r = row(data.inboundMessageId);
    expect(r.status).toBe("over_cap");
    const v = memoryState().verdicts.find((x) => x.id === r.verdictId)!;
    expect(v.source).toBe("inbound");
    expect(v.verdict.verdict).toBe("insufficient_evidence");
    expect(v.verdict.headline).toBe("Not analyzed: your household reached its monthly limit");
    const sent = memorySentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("October 1"); // start of the next UTC month
  });

  it("includes remaining usage when under 20%", async () => {
    const data = await newMessage("em_low");
    const mail = mailClient({ em_low: { meta: meta("em_low"), raw: forwardedPhish(ADDRESS) } });
    await runEmailReceived(data, makeDeps(mail, { checkCaps: vi.fn(async () => caps(true, 45)) }));
    expect(memorySentEmails()[0]!.text).toContain("4 of 50 checks left");
  });

  it("too large: failed too_large, forwarder notified with the paste/upload alternative", async () => {
    const data = await newMessage("em_big");
    const big = new Uint8Array(MAX_RAW_BYTES + 1).fill(65);
    const mail = mailClient({ em_big: { meta: meta("em_big"), raw: big } });
    const deps = makeDeps(mail);

    const out = await runEmailReceived(data, deps);

    expect(out).toEqual({ status: "failed", reason: "too_large" });
    expect(row(data.inboundMessageId)).toMatchObject({ status: "failed", error: "too_large" });
    expect(blob.size).toBe(0);
    expect(deps.runTriage).not.toHaveBeenCalled();
    const sent = memorySentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: OWNER.email, idempotencyKey: `inbound-${data.inboundMessageId}-too_large` });
    expect(sent[0]!.text).toMatch(/paste the text or upload/);
  });

  it("storage unavailable: failed storage_unavailable, notified", async () => {
    const data = await newMessage("em_nostore");
    const mail = mailClient({ em_nostore: { meta: meta("em_nostore"), raw: forwardedPhish(ADDRESS) } });
    const out = await runEmailReceived(data, makeDeps(mail, { artifacts: null }));
    expect(out).toEqual({ status: "failed", reason: "storage_unavailable" });
    expect(row(data.inboundMessageId).error).toBe("storage_unavailable");
    expect(memorySentEmails()).toHaveLength(1);
  });

  it("an unknown sender is not notified even when storage failed", async () => {
    const data = await newMessage("em_nostore2");
    const mail = mailClient({ em_nostore2: { meta: meta("em_nostore2", { from: "x@elsewhere.test" }), raw: "x" } });
    const out = await runEmailReceived(data, makeDeps(mail, { artifacts: null }));
    expect(out.status).toBe("rejected");
    expect(memorySentEmails()).toHaveLength(0);
  });

  it("final failure (inline): status failed and 'could not analyze' email to the identified forwarder", async () => {
    const data = await newMessage("em_boom");
    const mail = mailClient({ em_boom: { meta: meta("em_boom"), raw: forwardedPhish(ADDRESS) } });
    const deps = makeDeps(mail, { runTriage: vi.fn(async () => Promise.reject(new Error("model down"))) });

    const out = await runEmailReceivedInline(data, deps);

    expect(out).toBeUndefined();
    expect(row(data.inboundMessageId)).toMatchObject({ status: "failed", error: "job_failed" });
    const sent = memorySentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: OWNER.email, idempotencyKey: `inbound-${data.inboundMessageId}-failed` });
    expect(sent[0]!.text).toContain("We could not analyze this message");
  });

  it("failure handler before the forwarder is known: failed, no email", async () => {
    const data = await newMessage("em_early");
    const mail = mailClient({});
    await handleEmailReceivedFailure(data, makeDeps(mail), new Error("resend down"));
    expect(row(data.inboundMessageId).status).toBe("failed");
    expect(memorySentEmails()).toHaveLength(0);
  });

  it("failure handler does not overwrite a finished message", async () => {
    const data = await newMessage("em_fin");
    await memoryInbound.updateMessage(data.inboundMessageId, TENANT, { status: "done" });
    await handleEmailReceivedFailure(data, makeDeps(mailClient({})), new Error("late"));
    expect(row(data.inboundMessageId).status).toBe("done");
  });

  it("no mailer configured: still completes (done) without sending", async () => {
    const data = await newMessage("em_nomail");
    const mail = mailClient({ em_nomail: { meta: meta("em_nomail"), raw: forwardedPhish(ADDRESS) } });
    const out = await runEmailReceived(data, makeDeps(mail, { mailer: null }));
    expect(out.status).toBe("done");
  });
});

describe("artifacts-expire job", () => {
  it("purges expired artifacts, keeps fresh ones, and deletes old rejected/failed inbound rows", async () => {
    const put = (bytes: string) =>
      artifacts.put({
        tenantId: TENANT,
        userId: OWNER.userId,
        kind: "inbound_eml",
        mimeType: "message/rfc822",
        bytes: new TextEncoder().encode(bytes),
        source: "inbound",
      });
    // "old" was stored 40 days ago (default retention 30 days).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - 40 * 86_400_000));
    const old = await put("old");
    vi.useRealTimers();
    const fresh = await put("fresh");

    const oldRejected = await newMessage("em_r_old");
    const oldDone = await newMessage("em_d_old");
    const newFailed = await newMessage("em_f_new");
    const longAgo = new Date(Date.now() - 91 * 86_400_000);
    Object.assign(row(oldRejected.inboundMessageId), { status: "rejected", receivedAt: longAgo });
    Object.assign(row(oldDone.inboundMessageId), { status: "done", receivedAt: longAgo });
    Object.assign(row(newFailed.inboundMessageId), { status: "failed" });

    const steps = recordingSteps();
    const result = await runArtifactsExpire(
      {
        artifacts,
        purgeOldInbound: memoryInbound.purgeOld,
        purgeOldAlerts: async () => 3,
        purgeOldDevices: async () => 2,
        purgeOldDeviceSignals: async () => 4,
        purgeExpiredReputationCache: async () => 5,
        purgeWeeklyDigestPayloads: async () => 6,
      },
      steps,
    );

    expect(steps.names).toEqual(["purge-artifacts", "purge-inbound-rows", "purge-alerts", "purge-devices", "purge-signals", "purge-reputation-cache", "purge-digest-payloads"]);
    expect(result).toEqual({
      artifactsPurged: 1,
      artifactErrors: 0,
      inboundRowsDeleted: 1,
      alertsDeleted: 3,
      devicesDeleted: 2,
      signalsDeleted: 4,
      reputationCacheDeleted: 5,
      digestPayloadsDeleted: 6,
    });
    expect(blob.size).toBe(1); // only "fresh" is left
    expect(await artifacts.get(old.id, TENANT)).toBeUndefined();
    expect(await artifacts.get(fresh.id, TENANT)).toBeDefined();
    const ids = memoryState().inboundMessages.map((m) => m.id);
    expect(ids).not.toContain(oldRejected.inboundMessageId);
    expect(ids).toContain(oldDone.inboundMessageId);
    expect(ids).toContain(newFailed.inboundMessageId);
  });

  it("counts purge errors and keeps going", async () => {
    const store = {
      ...artifacts,
      listExpired: async () => [{ id: "a", tenantId: TENANT }, { id: "b", tenantId: TENANT }] as never,
      purge: vi.fn(async (id: string) => {
        if (id === "a") throw new Error("blob down");
      }),
    };
    const result = await runArtifactsExpire({
      artifacts: store,
      purgeOldInbound: async () => 0,
      purgeOldAlerts: async () => 0,
      purgeOldDevices: async () => 0,
      purgeOldDeviceSignals: async () => 0,
      purgeExpiredReputationCache: async () => 0,
      purgeWeeklyDigestPayloads: async () => 0,
    });
    expect(result).toMatchObject({ artifactsPurged: 1, artifactErrors: 1 });
  });
});

describe("email-received job: sign-in alerts", () => {
  const alert = (from: string, link: string) =>
    rawEmail({
      from: `Sam <${MEMBER.email}>`,
      to: ADDRESS,
      subject: "Fwd: Security alert",
      body: [
        "---------- Forwarded message ---------",
        `From: Google <${from}>`,
        "Subject: Security alert",
        "",
        "A new sign-in on Windows",
        "Your Google Account was just signed in to from a new Windows device.",
        "Location: Seattle, WA, USA",
        link,
        "If this wasn't you, secure your account now.",
      ].join("\r\n"),
    });
  const likelySafeTriage = (): Partial<EmailJobDeps> => ({
    runTriage: vi.fn(async () => ({ verdict: triaged("likely_safe"), model: "claude-sonnet-5", attempts: 1, fallback: false, usage: { input_tokens: 1, output_tokens: 1 } })),
  });

  it("a forwarded alert without original authentication is insufficient_evidence, with the check and event stored", async () => {
    const data = await newMessage("em_signin");
    const mail = mailClient({ em_signin: { meta: meta("em_signin", { from: `Sam <${MEMBER.email}>` }), raw: alert("no-reply@accounts.google.com", "https://myaccount.google.com/notifications") } });
    const steps = recordingSteps();
    const out = await runEmailReceived(data, makeDeps(mail, likelySafeTriage()), steps);
    expect(out.status).toBe("done");
    expect(steps.names.slice(-3)).toEqual(["signin-alert", "save-verdict", "notify"]);
    const v = memoryState().verdicts.find((x) => x.id === row(data.inboundMessageId).verdictId)!;
    expect(v.verdict).toMatchObject({ subject_type: "signin_alert", verdict: "insufficient_evidence" });
    expect(v.verdict.signin_check).toMatchObject({ provider: "google", device_label: "Windows", first_seen: true });
    const events = await memorySigninStore.list(TENANT, MEMBER.userId);
    expect(events).toEqual([expect.objectContaining({ provider: "google", event: "new_signin", verdictId: v.id, authenticated: false, source: "forwarded" })]);
    // The notification asks "Was this you?" with the device escaped.
    expect(memorySentEmails()[0]!.html).toContain("Was this you?");
  });

  it("a fake alert (off-provider sender and link) is malicious even when the model says likely_safe", async () => {
    const data = await newMessage("em_fake");
    const mail = mailClient({ em_fake: { meta: meta("em_fake", { from: `Sam <${MEMBER.email}>` }), raw: alert("no-reply@accounts-google.example.net", "https://accounts-google.example.net/review") } });
    const out = await runEmailReceived(data, makeDeps(mail, likelySafeTriage()));
    expect(out.status).toBe("done");
    const v = memoryState().verdicts.find((x) => x.id === row(data.inboundMessageId).verdictId)!;
    expect(v.verdict).toMatchObject({ subject_type: "signin_alert", verdict: "malicious" });
    expect(v.verdict.signin_check).toBeUndefined();
    expect(memorySentEmails()[0]!.html).not.toContain("Was this you?");
  });

  it("never stores a model-written signin_check: a non-alert message gets none, so no question and no event", async () => {
    const data = await newMessage("em_forged");
    const mail = mailClient({ em_forged: { meta: meta("em_forged"), raw: forwardedPhish(ADDRESS, MEMBER.email) } });
    const forged = triaged("suspicious", { signin_check: { provider: "google", event: "new_signin", device_label: "Windows", first_seen: true } });
    const runTriage = vi.fn(async () => ({ verdict: forged, model: "claude-sonnet-5", attempts: 1, fallback: false, usage: { input_tokens: 1, output_tokens: 1 } }));
    const out = await runEmailReceived(data, makeDeps(mail, { runTriage }));
    expect(out.status).toBe("done");
    const v = memoryState().verdicts.find((x) => x.id === row(data.inboundMessageId).verdictId)!;
    expect(v.verdict.signin_check).toBeUndefined();
    expect(memorySentEmails()[0]!.html).not.toContain("Was this you?");
    expect(await memorySigninStore.list(TENANT, OWNER.userId)).toEqual([]);
  });

  it("uses an injected hook (and still saves) when the deps provide one", async () => {
    const data = await newMessage("em_hook");
    const mail = mailClient({ em_hook: { meta: meta("em_hook"), raw: forwardedPhish(ADDRESS, MEMBER.email) } });
    const finalizeSignin = vi.fn(async ({ verdict }: { verdict: ReturnType<typeof triaged> }) => ({ verdict: { ...verdict, headline: "hooked" }, event: null }));
    const out = await runEmailReceived(data, makeDeps(mail, { finalizeSignin: finalizeSignin as never }));
    expect(finalizeSignin).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, userId: OWNER.userId, analysis: expect.objectContaining({ forwarded: true }) }));
    expect(out.status).toBe("done");
    expect(memoryState().verdicts.find((x) => x.id === row(data.inboundMessageId).verdictId)!.verdict.headline).toBe("hooked");
  });

  it("fails closed when the sign-in hook throws on an alert: likely_safe becomes suspicious, no check, no event", async () => {
    const data = await newMessage("em_hookfail");
    const mail = mailClient({ em_hookfail: { meta: meta("em_hookfail", { from: `Sam <${MEMBER.email}>` }), raw: alert("no-reply@accounts.google.com", "https://myaccount.google.com/notifications") } });
    const finalizeSignin = vi.fn(async () => {
      throw new Error("boom: Seattle 203.0.113.24");
    });
    const out = await runEmailReceived(data, makeDeps(mail, { ...likelySafeTriage(), finalizeSignin }));
    expect(out.status).toBe("done");
    const v = memoryState().verdicts.find((x) => x.id === row(data.inboundMessageId).verdictId)!;
    expect(v.verdict).toMatchObject({ subject_type: "signin_alert", verdict: "suspicious" });
    expect(v.verdict.signin_check).toBeUndefined();
    expect(JSON.stringify(v.verdict)).not.toContain("boom");
    expect(await memorySigninStore.list(TENANT, MEMBER.userId)).toEqual([]);
  });

  it("a throwing hook on a message that is not a sign-in alert still fails the step (unchanged)", async () => {
    const data = await newMessage("em_hookfail2");
    const mail = mailClient({ em_hookfail2: { meta: meta("em_hookfail2"), raw: forwardedPhish(ADDRESS, MEMBER.email) } });
    const finalizeSignin = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(runEmailReceived(data, makeDeps(mail, { finalizeSignin }))).rejects.toThrow("boom");
  });
});
