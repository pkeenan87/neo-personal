// @vitest-environment node
import type { Session } from "next-auth";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as healthGET } from "@/app/api/health/route";
import { MOCK_INBOUND_HEADER, POST as inboundPOST } from "@/app/api/inbound/resend/route";
import { GET as settingsGET, POST as settingsPOST } from "@/app/api/settings/forwarding/route";
import { inngest } from "@/inngest/client";
import type { ForwardingSettings } from "@/lib/forwarding-types";
import { memorySentEmails, registerMockReceivedEmail, resetMockReceivedEmails } from "@/lib/server/email/resend";
import { GET as verdictsGET } from "@/app/api/verdicts/route";
import { GET as verdictGET } from "@/app/api/verdicts/[id]/route";
import type { VerdictDetailResponse, VerdictListResponse } from "@/lib/dashboard-types";
import { memoryInbound } from "@/lib/server/inbound/memory";
import { extractAddress } from "@/lib/server/inbound/senders";
import { memoryState, setMemoryMembers } from "@/lib/server/memory-state";
import { DEV_SESSION_IDS } from "@/lib/session";
import { GMAIL_CONFIRMATION_BODY, GMAIL_CONFIRMATION_SUBJECT, forwardedPhish, rawEmail } from "./inbound-fixtures";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const DOMAIN = "inbound.example.test";
const DEV_EMAIL = "dev@neo.local";
let secret: string;
let seq = 0;

/** Random per-run signing secret (never a literal in the repo). */
function newSecret(): string {
  return `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64")}`;
}

function signed(payload: unknown, opts: { secret?: string; tamper?: boolean; url?: string } = {}): Request {
  const body = JSON.stringify(payload);
  const id = `msg_${++seq}`;
  const ts = new Date();
  const signature = new Webhook(opts.secret ?? secret).sign(id, ts, body);
  return new Request(opts.url ?? "https://neo.example.test/api/inbound/resend", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(ts.getTime() / 1000)),
      "svix-signature": signature,
    },
    body: opts.tamper ? body.replace("email.received", "email.receivEd") : body,
  });
}

function received(emailId: string, to: string[], extra: Record<string, unknown> = {}) {
  return {
    type: "email.received",
    created_at: "2026-09-24T10:00:00.000Z",
    data: { email_id: emailId, from: DEV_EMAIL, to, subject: "Fwd: Your account is locked", message_id: "<m@example.test>", attachments: [], ...extra },
  };
}

async function devAddress(): Promise<string> {
  const { localPart } = await memoryInbound.ensureAddress(DEV_SESSION_IDS.tenantId);
  return `${localPart}@${DOMAIN}`;
}

function registerPhish(emailId: string, to: string, from = DEV_EMAIL): void {
  registerMockReceivedEmail(
    { id: emailId, from, to: [to], receivedFor: [to], subject: "Fwd: Your account is locked", messageId: null, headers: {}, authentication: {} },
    forwardedPhish(to, from),
  );
}

function messages() {
  return memoryState().inboundMessages;
}

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  resetMockReceivedEmails();
  memorySentEmails().length = 0;
  authState.session = null;
  secret = newSecret();
  vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
  vi.stubEnv("NEO_INBOUND_DOMAIN", DOMAIN);
  vi.stubEnv("INNGEST_EVENT_KEY", "");
  vi.stubEnv("NEO_INBOUND_RATE_LIMIT_PER_HOUR", "");
  vi.stubEnv("DEV_USER_EMAIL", DEV_EMAIL);
  vi.stubEnv("AUTH_URL", "https://neo.example.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/inbound/resend: authenticity", () => {
  it("401 on a bad signature, a tampered body, or missing headers", async () => {
    const to = await devAddress();
    expect((await inboundPOST(signed(received("em_1", [to]), { secret: newSecret() }))).status).toBe(401);
    expect((await inboundPOST(signed(received("em_1", [to]), { tamper: true }))).status).toBe(401);
    expect((await inboundPOST(post("/api/inbound/resend", received("em_1", [to])))).status).toBe(401);
    expect(messages()).toHaveLength(0);
  });

  it("503 when RESEND_WEBHOOK_SECRET is unset", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    const res = await inboundPOST(post("/api/inbound/resend", received("em_1", [await devAddress()])));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "inbound_unconfigured" });
  });

  it("MOCK_MODE bypass: x-neo-mock-inbound: 1 from localhost only, never on a deployment", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    const to = await devAddress();
    const mk = (url: string) =>
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", [MOCK_INBOUND_HEADER]: "1" },
        body: JSON.stringify(received("em_mock", [to], { raw: forwardedPhish(to, DEV_EMAIL) })),
      });

    expect((await inboundPOST(mk("https://neo.example.test/api/inbound/resend"))).status).toBe(503);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await inboundPOST(mk("http://localhost/api/inbound/resend"))).status).toBe(503);
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("MOCK_MODE", "false");
    expect((await inboundPOST(mk("http://localhost/api/inbound/resend"))).status).toBe(503);
    vi.stubEnv("MOCK_MODE", "true");

    const res = await inboundPOST(mk("http://localhost/api/inbound/resend"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    // raw supplied in the mock payload → the inline job ran end to end
    expect(messages()[0]).toMatchObject({ status: "done" });
    expect(memorySentEmails()[0]!.to).toBe(DEV_EMAIL);
  });
});

describe("POST /api/inbound/resend: routing", () => {
  it("ignores other event types", async () => {
    const res = await inboundPOST(signed({ type: "email.delivered", data: { email_id: "x" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: true });
  });

  it("200 ignored for unknown, inactive, malformed or wrong-domain recipients", async () => {
    const good = await devAddress();
    const local = good.split("@")[0]!;
    for (const to of ["check-zzzzzzzzzzzz@" + DOMAIN, "someone@" + DOMAIN, `${local}@other.example`, "not-an-address"]) {
      const res = await inboundPOST(signed(received(`em_${to}`, [to])));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ignored: true });
    }
    expect(messages()).toHaveLength(0);
  });

  it("valid: records the message and runs the job inline in MOCK_MODE (fixture → artifact → inbound verdict → email → done)", async () => {
    const to = await devAddress();
    registerPhish("em_ok", to);
    const res = await inboundPOST(signed(received("em_ok", [`Neo <${to}>`])));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });

    const [m] = messages();
    expect(m).toMatchObject({ providerMessageId: "em_ok", tenantId: DEV_SESSION_IDS.tenantId, status: "done", forwarderUserId: DEV_SESSION_IDS.userId });
    expect(m!.fromAddressHash).toMatch(/^[0-9a-f]{16}$/);
    expect(m!.artifactId).toBeTruthy();
    const verdict = memoryState().verdicts.find((v) => v.id === m!.verdictId)!;
    expect(verdict.source).toBe("inbound");
    expect(verdict.artifactId).toBe(m!.artifactId);
    const sent = memorySentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: DEV_EMAIL, idempotencyKey: `verdict-${verdict.id}` });
    expect(sent[0]!.html).toContain(`https://neo.example.test/verdicts/${verdict.id}`);
  });

  it("the inbound verdict is on the dashboard: GET /api/verdicts and /api/verdicts/[id] (one shared memory state)", async () => {
    const to = await devAddress();
    registerPhish("em_dash", to);
    expect(await (await inboundPOST(signed(received("em_dash", [to])))).json()).toEqual({ accepted: true });
    const [m] = messages();

    const list = (await (await verdictsGET(new Request("http://localhost/api/verdicts?source=inbound"))).json()) as VerdictListResponse;
    expect(list.items.map((i) => i.id)).toEqual([m!.verdictId]);
    expect(list.items[0]).toMatchObject({ source: "inbound", subjectType: "email", artifactId: m!.artifactId, conversationId: null });

    const detail = (await (
      await verdictGET(new Request("http://localhost/x"), { params: Promise.resolve({ id: m!.verdictId! }) })
    ).json()) as VerdictDetailResponse;
    expect(detail.inbound).toMatchObject({ status: "done", forwardedBy: expect.any(String) });
    expect(detail.artifact).toMatchObject({ id: m!.artifactId, kind: "inbound_eml", expired: false });
  });

  it("uses received_for (envelope recipient) when To: is the original recipient", async () => {
    const to = await devAddress();
    registerPhish("em_env", to);
    const res = await inboundPOST(signed(received("em_env", ["alex@example.test"], { received_for: [to] })));
    expect(await res.json()).toEqual({ accepted: true });
    expect(messages()).toHaveLength(1);
  });

  it("sends neo/email.received when INNGEST_EVENT_KEY is set", async () => {
    vi.stubEnv("INNGEST_EVENT_KEY", "test-event-key");
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: ["evt"] } as never);
    const to = await devAddress();
    const res = await inboundPOST(signed(received("em_evt", [to])));
    expect(res.status).toBe(200);
    const [m] = messages();
    expect(m!.status).toBe("received");
    expect(send).toHaveBeenCalledWith({
      name: "neo/email.received",
      data: { inboundMessageId: m!.id, tenantId: DEV_SESSION_IDS.tenantId, emailId: "em_evt" },
    });
  });

  it("marks the row failed when the event cannot be queued, still 200", async () => {
    vi.stubEnv("INNGEST_EVENT_KEY", "test-event-key");
    vi.spyOn(inngest, "send").mockRejectedValue(new Error("down"));
    const res = await inboundPOST(signed(received("em_q", [await devAddress()])));
    expect(res.status).toBe(200);
    expect(messages()[0]).toMatchObject({ status: "failed", error: "queue_unavailable" });
  });

  it("duplicate provider message id → 200 duplicate, one row, job not rerun", async () => {
    const to = await devAddress();
    registerPhish("em_dup", to);
    await inboundPOST(signed(received("em_dup", [to])));
    const res = await inboundPOST(signed(received("em_dup", [to])));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duplicate: true });
    expect(messages()).toHaveLength(1);
    expect(memorySentEmails()).toHaveLength(1);
  });

  it("rate limit: over the hourly limit → recorded as rejected (rate_limited), 200, no job", async () => {
    vi.stubEnv("NEO_INBOUND_RATE_LIMIT_PER_HOUR", "2");
    vi.stubEnv("INNGEST_EVENT_KEY", "test-event-key");
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    const to = await devAddress();
    for (const id of ["em_r1", "em_r2", "em_r3"]) expect((await inboundPOST(signed(received(id, [to])))).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(messages().find((m) => m.providerMessageId === "em_r3")).toMatchObject({ status: "rejected", error: "rate_limited" });
  });

  it("address rotation invalidates the old address on the next webhook", async () => {
    const oldTo = await devAddress();
    await memoryInbound.rotateAddress(DEV_SESSION_IDS.tenantId);
    const res = await inboundPOST(signed(received("em_old", [oldTo])));
    expect(await res.json()).toEqual({ ignored: true });
    const newTo = await devAddress();
    expect(newTo).not.toBe(oldTo);
    registerPhish("em_new", newTo);
    expect(await (await inboundPOST(signed(received("em_new", [newTo])))).json()).toEqual({ accepted: true });
  });

  it("unknown forwarder → rejected, no email", async () => {
    const to = await devAddress();
    registerPhish("em_x", to, "stranger@elsewhere.test");
    await inboundPOST(signed(received("em_x", [to], { from: "stranger@elsewhere.test" })));
    expect(messages()[0]).toMatchObject({ status: "rejected", error: "unknown_sender" });
    expect(memorySentEmails()).toHaveLength(0);
  });
});

describe("/api/settings/forwarding", () => {
  it("401 without a session", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    expect((await settingsGET()).status).toBe(401);
    expect((await settingsPOST(post("/api/settings/forwarding", { action: "rotate" }))).status).toBe(401);
  });

  it("GET returns the address, accepted senders and recent messages; the Gmail code for the owner", async () => {
    const to = await devAddress();
    registerMockReceivedEmail(
      {
        id: "em_g",
        from: "forwarding-noreply@google.com",
        to: [to],
        receivedFor: [to],
        subject: GMAIL_CONFIRMATION_SUBJECT,
        messageId: null,
        headers: {},
        authentication: { dmarc: "pass" },
      },
      rawEmail({ from: "forwarding-noreply@google.com", to, subject: GMAIL_CONFIRMATION_SUBJECT, body: GMAIL_CONFIRMATION_BODY }),
    );
    await inboundPOST(signed(received("em_g", [to], { from: "forwarding-noreply@google.com", subject: GMAIL_CONFIRMATION_SUBJECT })));

    const res = await settingsGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForwardingSettings;
    expect(body.address).toBe(to);
    expect(body.configured).toBe(true);
    expect(body.canRotate).toBe(true);
    expect(body.acceptedSenders).toEqual([DEV_EMAIL]);
    expect(body.gmailConfirmation?.code).toBe("482915736");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ status: "rejected", reason: "gmail_confirmation" });
    expect(JSON.stringify(body)).not.toContain("mail-settings.google.com");
  });

  it("members do not see the Gmail code and cannot rotate", async () => {
    const tenantId = "00000000-0000-4000-8000-0000000000dd";
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    authState.session = {
      userId: "u-member",
      tenantId,
      role: "member",
      user: { email: "sam@example.test", name: "Sam" },
      expires: "2099-01-01T00:00:00Z",
    } as Session;
    setMemoryMembers(tenantId, [
      { userId: "u-owner", name: "Alex", email: "alex@example.test", role: "owner" },
      { userId: "u-member", name: "Sam", email: "sam@example.test", role: "member" },
    ]);
    const addr = await memoryInbound.ensureAddress(tenantId);
    const { id } = await memoryInbound.recordMessage({ tenantId, addressId: addr.id, providerMessageId: "g2", fromAddressHash: "h", status: "rejected" });
    await memoryInbound.updateMessage(id, tenantId, { error: "gmail_confirmation:123456789" });

    const body = (await (await settingsGET()).json()) as ForwardingSettings;
    expect(body.gmailConfirmation).toBeNull();
    expect(body.canRotate).toBe(false);
    const res = await settingsPOST(post("/api/settings/forwarding", { action: "rotate" }));
    expect(res.status).toBe(403);
  });

  it("POST rotate returns a new address and audits; bad body 400", async () => {
    const before = await devAddress();
    expect((await settingsPOST(post("/api/settings/forwarding", { action: "nope" }))).status).toBe(400);
    const res = await settingsPOST(post("/api/settings/forwarding", { action: "rotate" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForwardingSettings;
    expect(body.address).not.toBe(before);
    expect(body.address).toMatch(/^check-[0-9a-z]{12}@inbound\.example\.test$/);
    const { memoryAuditLog } = await import("@/lib/server/audit");
    expect(memoryAuditLog().some((e) => e.eventType === "inbound.address_rotated")).toBe(true);
  });

  it("address is null (unconfigured) outside MOCK_MODE without NEO_INBOUND_DOMAIN", async () => {
    vi.stubEnv("MOCK_MODE", "false");
    vi.stubEnv("NEO_INBOUND_DOMAIN", "");
    const body = (await (await settingsGET()).json()) as ForwardingSettings;
    expect(body.address).toBeNull();
    expect(body.configured).toBe(false);
    expect(body.localPart).toMatch(/^check-/);
  });
});

describe("GET /api/health inbound status", () => {
  it("unconfigured unless every inbound variable is set", async () => {
    expect((await healthGET().json()) as { inbound: string }).toMatchObject({ inbound: "unconfigured" });
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("INNGEST_EVENT_KEY", "test-event-key");
    vi.stubEnv("INNGEST_SIGNING_KEY", "test-signing-key");
    expect((await healthGET().json()) as { inbound: string }).toMatchObject({ inbound: "ok" });
  });
});

describe("extractAddress", () => {
  it("parses display-name forms and rejects malformed or oversized input quickly", () => {
    expect(extractAddress("Alex <Alex@Example.test>")).toBe("alex@example.test");
    expect(extractAddress("a@b.c")).toBe("a@b.c");
    expect(extractAddress("a@b")).toBeUndefined();
    expect(extractAddress("a@b..c")).toBeUndefined();
    const started = Date.now();
    expect(extractAddress(`!@!${"!.".repeat(50_000)}`)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
