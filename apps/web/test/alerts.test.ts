// @vitest-environment node
/**
 * Owner alerts on the in-memory stores (_specs/owner-alerts.md): raising from
 * verdicts and membership changes, inline delivery with thresholds and the
 * daily cap, the routes and their role and desktop-token guards, and email escaping.
 */
import type { Verdict } from "@neo/verdict";
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as ackPOST } from "@/app/api/alerts/[id]/acknowledge/route";
import { POST as ackAllPOST } from "@/app/api/alerts/acknowledge-all/route";
import { GET as alertsGET } from "@/app/api/alerts/route";
import { POST as leavePOST } from "@/app/api/household/leave/route";
import { GET as settingsGET, POST as settingsPOST } from "@/app/api/settings/alerts/route";
import type { AlertListResponse } from "@/lib/alert-types";
import {
  ALERT_EMAIL_DAILY_CAP,
  alertForVerdict,
  alertMemberJoined,
  deliverAlert,
  meetsThreshold,
  raiseAlert,
  type AlertDeliveryDeps,
} from "@/lib/server/alerts";
import { renderAlertEmail } from "@/lib/server/email/alert-email";
import { memorySentEmails } from "@/lib/server/email/resend";
import { memoryAlertRows, memorySetThreshold, resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { memoryCreateDesktopToken } from "@/lib/server/memory-desktop-tokens";
import { resetMemoryHousehold } from "@/lib/server/memory-household";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { saveVerdict } from "@/lib/server/verdicts";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OWNER = { userId: "user-owner", role: "owner" as const, email: "pat@example.test", name: "Pat" };
const KID = { userId: "user-kid", role: "member" as const, email: "kid@example.test", name: "Kid" };

function as(p: { userId: string; role: "owner" | "member"; email: string; name: string }): void {
  hdrs.current = new Headers();
  authState.session = { userId: p.userId, tenantId: TENANT, role: p.role, user: { email: p.email, name: p.name }, expires: "2099-01-01T00:00:00Z" };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    subject_type: "url",
    verdict: "malicious",
    confidence: 0.95,
    headline: "Fake PayPal login page.",
    indicators: [],
    recommended_actions: [],
    iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] },
    ...over,
  };
}

async function list(query = ""): Promise<AlertListResponse> {
  const res = await alertsGET(new Request(`http://localhost/api/alerts${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as AlertListResponse;
}

function ack(id: string): Promise<Response> {
  return ackPOST(post(`/api/alerts/${id}/acknowledge`, {}), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("INNGEST_EVENT_KEY", "");
  vi.stubEnv("AUTH_URL", "https://neo.example.test");
  resetMemoryState();
  resetMemoryAlerts();
  resetMemoryHousehold();
  resetRateLimits();
  memorySentEmails().length = 0;
  const g = globalThis as { __neoDesktopTokens?: unknown };
  g.__neoDesktopTokens = undefined;
  setMemoryMembers(TENANT, [
    { userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" },
    { userId: KID.userId, name: KID.name, email: KID.email, role: "member" },
  ]);
  as(OWNER);
});
afterEach(() => vi.unstubAllEnvs());

describe("raising alerts from verdicts", () => {
  it("emails the owner when a member's check is malicious", async () => {
    const { id } = await saveVerdict({ tenantId: TENANT, userId: KID.userId, source: "chat", verdict: verdict() });
    const [alert] = memoryAlertRows();
    expect(alert).toMatchObject({ kind: "member_verdict", severity: "high", subjectUserId: KID.userId, verdictId: id, emailStatus: "sent" });
    expect(alert!.title).toBe("Kid checked something malicious");
    expect(alert!.body).toBe('Kid asked Neo about a link. Neo\'s verdict: malicious. Summary: "Fake PayPal login page."');

    const [email] = memorySentEmails();
    expect(email).toMatchObject({ to: OWNER.email, subject: "Neo alert: Kid checked something malicious", idempotencyKey: `alert:${alert!.id}:${OWNER.userId}` });
    expect(email!.text).toContain(`https://neo.example.test/verdicts/${id}`);
  });

  it("says when the member forwarded the message", async () => {
    await saveVerdict({ tenantId: TENANT, userId: KID.userId, source: "inbound", verdict: verdict({ subject_type: "email" }) });
    expect(memoryAlertRows()[0]!.body).toMatch(/^Kid forwarded an email to Neo\./);
  });

  it("feeds suspicious checks and emails them only at the medium threshold", async () => {
    await saveVerdict({ tenantId: TENANT, userId: KID.userId, source: "chat", verdict: verdict({ verdict: "suspicious" }) });
    expect(memoryAlertRows()[0]).toMatchObject({ severity: "medium", emailStatus: "skipped" });
    expect(memorySentEmails()).toHaveLength(0);

    memorySetThreshold(TENANT, OWNER.userId, "medium");
    await saveVerdict({ tenantId: TENANT, userId: KID.userId, source: "chat", verdict: verdict({ verdict: "suspicious" }) });
    expect(memorySentEmails()).toHaveLength(1);
  });

  it("never alerts for the owner's own checks or for safe results", async () => {
    await saveVerdict({ tenantId: TENANT, userId: OWNER.userId, source: "chat", verdict: verdict() });
    await saveVerdict({ tenantId: TENANT, userId: KID.userId, source: "chat", verdict: verdict({ verdict: "likely_safe" }) });
    await saveVerdict({ tenantId: TENANT, userId: KID.userId, source: "chat", verdict: verdict({ verdict: "insufficient_evidence" }) });
    expect(memoryAlertRows()).toEqual([]);
  });

  it("alerts once per verdict", async () => {
    const input = { tenantId: TENANT, userId: KID.userId, verdictId: "11111111-1111-4111-8111-111111111111", verdict: verdict(), source: "chat" as const };
    await alertForVerdict(input);
    await alertForVerdict(input);
    expect(memoryAlertRows()).toHaveLength(1);
    expect(memorySentEmails()).toHaveLength(1);
  });

  it("sends nothing at threshold off but still fills the feed", async () => {
    memorySetThreshold(TENANT, OWNER.userId, "off");
    await saveVerdict({ tenantId: TENANT, userId: KID.userId, source: "chat", verdict: verdict() });
    expect(memorySentEmails()).toHaveLength(0);
    expect((await list()).openCount).toBe(1);
  });
});

describe("membership alerts", () => {
  it("emails the owner when someone joins, and only feeds leaving", async () => {
    await alertMemberJoined(TENANT, { userId: KID.userId, name: "Kid", email: KID.email });
    expect(memorySentEmails().at(-1)).toMatchObject({ subject: "Neo alert: Kid joined your household" });
    // A second join within the hour is deduplicated.
    await alertMemberJoined(TENANT, { userId: KID.userId, name: "Kid", email: KID.email });
    expect(memoryAlertRows().filter((a) => a.kind === "member_joined")).toHaveLength(1);

    as(KID);
    expect((await leavePOST()).status).toBe(204);
    const left = memoryAlertRows().find((a) => a.kind === "member_left");
    expect(left).toMatchObject({ severity: "low", title: "Kid left your household", emailStatus: "skipped" });
    expect(memorySentEmails()).toHaveLength(1);
  });
});

describe("delivery", () => {
  function deps(over: Partial<AlertDeliveryDeps> = {}): AlertDeliveryDeps & { sent: string[]; marks: string[] } {
    const sent: string[] = [];
    const marks: string[] = [];
    const alert = {
      id: "a1",
      tenantId: TENANT,
      subjectUserId: KID.userId,
      deviceId: null,
      kind: "member_verdict" as const,
      severity: "high" as const,
      title: "Kid checked something malicious",
      body: "body",
      verdictId: null,
      dedupeKey: "k",
      createdAt: new Date(),
      acknowledgedAt: null,
      acknowledgedBy: null,
      emailStatus: "pending" as const,
      emailedAt: null,
    };
    return {
      sent,
      marks,
      getAlert: async () => alert,
      owners: async () => [{ userId: OWNER.userId, email: OWNER.email, name: "Pat", threshold: "high" }],
      countSentSince: async () => 0,
      markEmail: async (_t, _id, status) => {
        marks.push(status);
      },
      mailer: {
        send: async (e) => {
          sent.push(e.idempotencyKey);
          return { id: "x" };
        },
      },
      appUrl: "https://neo.example.test",
      ...over,
    };
  }

  it("caps emails per household per day with one notice", async () => {
    const d = deps({ countSentSince: async () => ALERT_EMAIL_DAILY_CAP });
    const now = new Date("2026-09-27T12:00:00Z");
    expect(await deliverAlert({ alertId: "a1", tenantId: TENANT }, d, now)).toBe("capped");
    expect(d.marks).toEqual(["skipped"]);
    expect(d.sent).toEqual([`alert-cap:${TENANT}:2026-09-27:${OWNER.userId}`]);
  });

  it("leaves already handled alerts alone", async () => {
    const d = deps();
    const handled = { ...(await d.getAlert(TENANT, "a1"))!, emailStatus: "sent" as const };
    const d2 = deps({ getAlert: async () => handled });
    expect(await deliverAlert({ alertId: "a1", tenantId: TENANT }, d2)).toBe("already_handled");
    expect(d2.sent).toEqual([]);
  });

  it("lets a send failure propagate so Inngest retries, leaving the alert pending", async () => {
    const d = deps({ mailer: { send: async () => Promise.reject(new Error("resend down")) } });
    await expect(deliverAlert({ alertId: "a1", tenantId: TENANT }, d)).rejects.toThrow("resend down");
    expect(d.marks).toEqual([]);
  });

  it("maps severities to thresholds", () => {
    expect(meetsThreshold("high", "high")).toBe(true);
    expect(meetsThreshold("medium", "high")).toBe(false);
    expect(meetsThreshold("medium", "medium")).toBe(true);
    expect(meetsThreshold("high", "critical")).toBe(false);
    expect(meetsThreshold("critical", "off")).toBe(false);
  });

  it("never throws from raiseAlert", async () => {
    const bad = await raiseAlert({ tenantId: TENANT, subjectUserId: null, kind: "member_left", severity: "low", title: "t", body: "b", dedupeKey: "x" });
    expect(bad).not.toBeNull();
  });
});

describe("routes", () => {
  beforeEach(async () => {
    await saveVerdict({ tenantId: TENANT, userId: KID.userId, source: "chat", verdict: verdict() });
    await raiseAlert({ tenantId: TENANT, subjectUserId: "user-other", kind: "member_left", severity: "low", title: "Other left", body: "b", dedupeKey: "left:other" });
  });

  it("shows owners everything and members only their own", async () => {
    const owner = await list();
    expect(owner.items.map((a) => a.title).sort()).toEqual(["Kid checked something malicious", "Other left"]);
    expect(owner).toMatchObject({ openCount: 2, urgentCount: 1 });
    expect(owner.items.find((a) => a.subjectUserId === KID.userId)?.subjectName).toBe("Kid");

    as(KID);
    const mine = await list();
    expect(mine.items.map((a) => a.title)).toEqual(["Kid checked something malicious"]);
    expect(mine.openCount).toBe(1);
  });

  it("validates query parameters", async () => {
    expect((await alertsGET(new Request("http://localhost/api/alerts?status=closed"))).status).toBe(400);
    expect((await alertsGET(new Request("http://localhost/api/alerts?limit=0"))).status).toBe(400);
    expect((await alertsGET(new Request("http://localhost/api/alerts?cursor=%%%"))).status).toBe(400);
  });

  it("lets the owner acknowledge one or all; members cannot", async () => {
    const [first] = (await list()).items;
    as(KID);
    const denied = await ack(first!.id);
    expect(denied.status).toBe(403);
    expect((await ackAllPOST()).status).toBe(403);

    as(OWNER);
    const res = await ack(first!.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { alert: { acknowledgedByName: string } }).alert.acknowledgedByName).toBe("Pat");
    expect((await ack("00000000-0000-4000-8000-000000000999")).status).toBe(404);
    expect((await list()).openCount).toBe(1);
    expect(await (await ackAllPOST()).json()).toEqual({ acknowledged: 1 });
    expect((await list()).openCount).toBe(0);
    expect((await list("?status=all")).items).toHaveLength(2);
  });

  it("reads and writes the owner's threshold", async () => {
    expect(await (await settingsGET()).json()).toEqual({ threshold: "high" });
    expect((await settingsPOST(post("/api/settings/alerts", { threshold: "loud" }))).status).toBe(400);
    expect(await (await settingsPOST(post("/api/settings/alerts", { threshold: "medium" }))).json()).toEqual({ threshold: "medium" });
    expect(await (await settingsGET()).json()).toEqual({ threshold: "medium" });
    as(KID);
    expect((await settingsGET()).status).toBe(403);
    expect((await settingsPOST(post("/api/settings/alerts", { threshold: "off" }))).status).toBe(403);
  });

  it("refuses desktop tokens for acknowledging and settings changes", async () => {
    const minted = memoryCreateDesktopToken({ userId: OWNER.userId, tenantId: TENANT, role: "owner", name: "bar" });
    if ("error" in minted) throw new Error(minted.error);
    authState.session = null;
    hdrs.current = new Headers({ authorization: `Bearer ${minted.token}` });
    // Reading is fine (the Omarchy bar could show alerts); changing is not.
    expect((await alertsGET(new Request("http://localhost/api/alerts"))).status).toBe(200);
    for (const res of [await ack(memoryAlertRows()[0]!.id), await ackAllPOST(), await settingsPOST(post("/api/settings/alerts", { threshold: "off" }))]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "browser_session_required" });
    }
  });
});

describe("alert email", () => {
  it("escapes hostile text and links only to Neo", () => {
    const email = renderAlertEmail({
      severity: "high",
      title: 'Kid<img src=x onerror=alert(1)> checked something malicious',
      body: 'Summary: "<script>steal()</script> Click https://evil.example/login now"',
      link: { url: "https://neo.example.test/verdicts/abc", label: "See the check" },
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;script&gt;");
    const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["https://neo.example.test/verdicts/abc"]);
    expect(() => renderAlertEmail({ severity: "low", title: "t", body: "b", link: { url: "javascript:alert(1)", label: "x" } })).toThrow();
  });
});
