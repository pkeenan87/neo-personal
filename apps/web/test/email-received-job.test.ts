// @vitest-environment node
import { utcWindows, type CapCheckResult } from "@neo/db";
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
import { memoryInbound, memoryInboundState, resetMemoryInbound, setMemoryMembers } from "@/lib/server/inbound/memory";
import { analyzeEmail, runTriage } from "@/lib/server/phase1-stubs-inbound";
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
  return memoryInboundState().messages.find((m) => m.id === id)!;
}

function makeDeps(mail: ReceivedMailClient, overrides: Partial<EmailJobDeps> = {}): EmailJobDeps {
  return {
    mail,
    artifacts: memoryInbound.artifacts,
    mailer: createMockMailer("Neo <neo@example.test>"),
    listMembers: memoryInbound.listMembers,
    updateMessage: memoryInbound.updateMessage,
    findMessage: async (id, t) => (await memoryInbound.listRecent(t, 100)).find((m) => m.id === id),
    checkCaps: vi.fn(async () => caps(true)),
    noteCapHit: vi.fn(async () => {}),
    recordUsage: vi.fn(async () => {}),
    analyzeEmail: vi.fn(analyzeEmail),
    runTriage: vi.fn(runTriage),
    triageGuidance: "guidance",
    saveVerdict: memoryInbound.saveVerdict,
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
  resetMemoryInbound();
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
    expect(steps.names).toEqual(["fetch-raw", "store-artifact", "identify-forwarder", "check-caps", "analyze", "triage", "save-verdict", "notify"]);
    const r = row(data.inboundMessageId);
    expect(r).toMatchObject({ status: "done", forwarderUserId: MEMBER.userId });
    expect(r.completedAt).toBeInstanceOf(Date);
    expect(r.artifactId).toBeTruthy();

    // artifact
    const art = await memoryInbound.artifacts.get(r.artifactId!, TENANT);
    expect(art).toMatchObject({ kind: "inbound_eml", source: "inbound", mimeType: "message/rfc822" });
    expect(await memoryInbound.artifacts.get(r.artifactId!, "another-tenant")).toBeUndefined();

    // analysis + triage inputs
    expect(deps.analyzeEmail).toHaveBeenCalledWith({ raw: expect.any(Uint8Array) }, { maxUrls: MAX_URLS });
    expect(deps.runTriage).toHaveBeenCalledWith(expect.objectContaining({ evidenceKind: "email", guidance: "guidance" }));

    // verdict
    const v = memoryInboundState().verdicts.find((x) => x.id === r.verdictId)!;
    expect(v).toMatchObject({ tenantId: TENANT, userId: MEMBER.userId, source: "inbound", artifactId: r.artifactId });
    expect(v.verdict.raw_ref).toBe(r.artifactId);
    expect(VerdictSchema.safeParse(v.verdict).success).toBe(true);
    expect(v.verdict.verdict).toBe("malicious"); // lookalike_domain from the stub analyzer

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
    expect(memoryInboundState().artifacts.size).toBe(0);
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
    expect(memoryInboundState().artifacts.size).toBe(0);
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
    const v = memoryInboundState().verdicts.find((x) => x.id === r.verdictId)!;
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
    expect(memoryInboundState().artifacts.size).toBe(0);
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
      memoryInbound.artifacts.put({
        tenantId: TENANT,
        userId: OWNER.userId,
        kind: "inbound_eml",
        mimeType: "message/rfc822",
        bytes: new TextEncoder().encode(bytes),
        source: "inbound",
      });
    const old = await put("old");
    const fresh = await put("fresh");
    memoryInboundState().artifacts.get(old.id)!.meta.expiresAt = new Date(Date.now() - 1000);

    const oldRejected = await newMessage("em_r_old");
    const oldDone = await newMessage("em_d_old");
    const newFailed = await newMessage("em_f_new");
    const longAgo = new Date(Date.now() - 91 * 86_400_000);
    Object.assign(row(oldRejected.inboundMessageId), { status: "rejected", receivedAt: longAgo });
    Object.assign(row(oldDone.inboundMessageId), { status: "done", receivedAt: longAgo });
    Object.assign(row(newFailed.inboundMessageId), { status: "failed" });

    const steps = recordingSteps();
    const result = await runArtifactsExpire({ artifacts: memoryInbound.artifacts, purgeOldInbound: memoryInbound.purgeOld }, steps);

    expect(steps.names).toEqual(["purge-artifacts", "purge-inbound-rows"]);
    expect(result).toEqual({ artifactsPurged: 1, artifactErrors: 0, inboundRowsDeleted: 1 });
    expect(memoryInboundState().artifacts.has(old.id)).toBe(false);
    expect(memoryInboundState().artifacts.has(fresh.id)).toBe(true);
    const ids = memoryInboundState().messages.map((m) => m.id);
    expect(ids).not.toContain(oldRejected.inboundMessageId);
    expect(ids).toContain(oldDone.inboundMessageId);
    expect(ids).toContain(newFailed.inboundMessageId);
  });

  it("counts purge errors and keeps going", async () => {
    const store = {
      ...memoryInbound.artifacts,
      listExpired: async () => [{ id: "a" }, { id: "b" }] as never,
      purge: vi.fn(async (id: string) => {
        if (id === "a") throw new Error("blob down");
      }),
    };
    const result = await runArtifactsExpire({ artifacts: store, purgeOldInbound: async () => 0 });
    expect(result).toMatchObject({ artifactsPurged: 1, artifactErrors: 1 });
  });
});
