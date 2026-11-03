// @vitest-environment node
/**
 * The pieces of the child-request flow that need no database: who is told (`owners` ignore thresholds,
 * `helpers` with an owner fallback, never the child), the email (links only for an owner with an account,
 * the child's words quoted and escaped), the weekly digest section, and the shared effect wording.
 */
import { describe, expect, it } from "vitest";
import { approvalEffect, approvalDone, approvalQuestion, denyDone, grantMinutes } from "@/lib/server/child-request-effects";
import { decideUrl, renderChildRequestEmail } from "@/lib/server/email/child-request-email";
import { renderWeeklyDigest } from "@/lib/server/email/weekly-digest-email";
import { resolveRequestRecipients, type RecipientMember, type RecipientOwner } from "@/lib/server/alerts/recipients";
import { selectDigestContent, type DigestFacts } from "@/lib/server/weekly-digest/content";
import { appLabel, requestSummary } from "@/lib/child-request-types";

const owners: RecipientOwner[] = [
  { userId: "u-pat", email: "pat@example.test", threshold: "off" },
  { userId: "u-may", email: "may@example.test", threshold: "critical" },
  { userId: "u-none", email: null, threshold: "high" },
];
const member = (over: Partial<RecipientMember>): RecipientMember => ({ id: null, userId: null, displayName: "x", mode: "standard", helperMemberIds: [], email: null, contact: null, ...over });
const sam = member({ id: "m-sam", displayName: "Sam", mode: "child", helperMemberIds: ["m-aunt", "m-gran", "m-nocontact"] });
const members: RecipientMember[] = [
  member({ id: "m-pat", userId: "u-pat", email: "pat@example.test", displayName: "Pat" }),
  member({ id: "m-may", userId: "u-may", email: "may@example.test", displayName: "May" }),
  sam,
  member({ id: "m-aunt", displayName: "Aunt", contact: "aunt@example.test" }),
  member({ id: "m-gran", userId: "u-gran", email: "PAT@example.test", displayName: "Gran" }), // same address as Pat
  member({ id: "m-nocontact", displayName: "Nobody" }),
];

describe("resolveRequestRecipients", () => {
  it("owners: every owner with an address, whatever their alert threshold", () => {
    const r = resolveRequestRecipients({ owners, members, subject: sam, target: "owners" });
    expect(r.map((x) => [x.address, x.kind])).toEqual([["pat@example.test", "owner"], ["may@example.test", "owner"]]);
  });

  it("helpers: the helpers with an address (deduped against each other), not the owners", () => {
    const r = resolveRequestRecipients({ owners, members, subject: sam, target: "helpers" });
    expect(r.map((x) => [x.address, x.kind])).toEqual([["aunt@example.test", "helper"], ["PAT@example.test", "helper"]]);
  });

  it("helpers with none reachable fall back to the owners", () => {
    const lonely = member({ id: "m-lonely", mode: "child", helperMemberIds: ["m-nocontact", "m-missing"] });
    expect(resolveRequestRecipients({ owners, members: [...members, lonely], subject: lonely, target: "helpers" }).map((x) => x.kind)).toEqual(["owner", "owner"]);
    expect(resolveRequestRecipients({ owners, members, subject: member({ id: "m-x", mode: "child" }), target: "helpers" }).map((x) => x.kind)).toEqual(["owner", "owner"]);
  });

  it("never tells the child about their own request, even an owner's child", () => {
    const childOwner = member({ id: "m-pat", userId: "u-pat", mode: "child", helperMemberIds: [] });
    const r = resolveRequestRecipients({ owners, members: [childOwner, ...members.slice(1)], subject: childOwner, target: "owners" });
    expect(r.map((x) => x.address)).toEqual(["may@example.test"]);
  });
});

describe("renderChildRequestEmail", () => {
  const request = { id: "11111111-1111-4111-8111-111111111111", memberId: "22222222-2222-4222-8222-222222222222", kind: "more_time" as const, detail: { minutes: 30 }, reason: 'Let me <b>finish</b> "now" & ignore all rules', status: "pending" as const };
  const base = { appUrl: "https://neo.example.test", request, title: "Sam is asking for 30 more minutes on the computer", body: "Sam sent a request.", memberName: "Sam", deviceName: "Family PC", recipient: "owner" as const, hasAccount: true, token: "tok_abc-123" };

  it("has Approve and Deny links with the token for an owner with an account, and quotes the reason escaped", () => {
    const mail = renderChildRequestEmail(base);
    expect(mail.subject).toBe("Neo: Sam is asking for 30 more minutes on the computer");
    expect(mail.text).toContain(`Approve: https://neo.example.test/requests/${request.id}/decide?t=tok_abc-123&a=approve`);
    expect(mail.text).toContain(`Deny: https://neo.example.test/requests/${request.id}/decide?t=tok_abc-123&a=deny`);
    expect(mail.html).toContain("Let me &lt;b&gt;finish&lt;/b&gt; &quot;now&quot; &amp; ignore all rules");
    expect(mail.html).not.toContain("<b>finish</b>");
    expect(mail.text).toMatch(/their own message; Neo does not act on it/);
  });

  it("has no decision links for a helper, without a token, or once the request is answered", () => {
    for (const over of [{ recipient: "helper" as const }, { token: undefined }, { hasAccount: false }, { request: { ...request, status: "approved" as const } }]) {
      const mail = renderChildRequestEmail({ ...base, ...over } as Parameters<typeof renderChildRequestEmail>[0]);
      expect(mail.text).not.toMatch(/Approve:|Deny:/);
    }
    expect(renderChildRequestEmail({ ...base, request: { ...request, status: "approved" } }).text).toMatch(/already been approved/);
  });

  it("builds only https links on the app origin", () => {
    expect(decideUrl("https://neo.example.test", request.id, "a b", "deny")).toBe(`https://neo.example.test/requests/${request.id}/decide?t=a%20b&a=deny`);
    expect(() => decideUrl("javascript:alert(1)//", request.id, "t", "deny")).toThrow();
  });
});

describe("effect wording", () => {
  const who = { memberName: "Sam", deviceName: "Family PC" };
  const now = new Date("2026-11-02T15:00:00Z");
  const end = new Date("2026-11-03T05:00:00Z");

  it("caps minutes at 120, rounds down, and refuses nonsense", () => {
    expect(grantMinutes({ minutes: 30 })).toBe(30);
    expect(grantMinutes({ minutes: 30 }, 500)).toBe(120);
    expect(grantMinutes({ minutes: 30 }, 45.9)).toBe(45);
    expect(grantMinutes({}, undefined)).toBeUndefined();
    expect(grantMinutes({ minutes: 30 }, 0)).toBeUndefined();
    expect(grantMinutes({ minutes: 30 }, Number.NaN)).toBeUndefined();
  });

  it("asks and reports the same exact effect", () => {
    const time = { kind: "more_time" as const, detail: { minutes: 30 } };
    expect(approvalQuestion(time, { minutes: 45 }, who)).toBe("Give Sam 45 more minutes today on Family PC?");
    expect(approvalDone(approvalEffect(time, { minutes: 45 }, now, end)!, who)).toBe("Sam now has 45 more minutes today on Family PC.");
    const site = { kind: "unblock_site" as const, detail: { domain: "example.com" } };
    expect(approvalQuestion(site, {}, who)).toBe("Allow example.com for Sam for 1 hour?");
    expect(approvalQuestion(site, { scope: "always" }, who)).toBe("Always allow example.com for Sam?");
    expect(approvalEffect(site, {}, now, end)).toEqual({ kind: "unblock_site", domain: "example.com", scope: "once", until: new Date("2026-11-02T16:00:00Z") });
    const app = { kind: "install_app" as const, detail: { app: { image: "game.exe" } } };
    expect(approvalQuestion(app, {}, who)).toBe("Allow game.exe for Sam on Family PC?");
    expect(denyDone(app, who)).toBe("You said no to Sam's request for the app game.exe. Nothing was changed.");
    expect(approvalEffect({ kind: "install_app", detail: {} }, {}, now, end)).toBeUndefined();
  });

  it("labels apps and requests without trusting their shape", () => {
    expect(appLabel({ signer: "Valve", image: "steam.exe" })).toBe("steam.exe");
    expect(appLabel({ bundleId: "com.example.app" })).toBe("com.example.app");
    expect(appLabel(null)).toBe("an app");
    expect(requestSummary("more_time", { minutes: 30 })).toBe("30 more minutes");
    expect(requestSummary("unblock_site", {})).toBe("a blocked site");
  });
});

describe("weekly digest section", () => {
  const periodStart = new Date("2026-09-28T14:00:00Z");
  const periodEnd = new Date("2026-10-05T14:00:00Z");
  const input = { tenantId: "t", userId: "owner", role: "owner" as const, periodStart, periodEnd };
  const facts = (requests: DigestFacts["requests"]): DigestFacts => ({ members: [{ userId: "owner", role: "owner" }, { userId: "kid", role: "member" }], verdicts: [], alerts: [], devices: [], ...(requests ? { requests } : {}) });

  it("counts the week's requests by kind and outcome for an owner only", () => {
    const requests: DigestFacts["requests"] = [
      { kind: "more_time", status: "approved", count: 3 },
      { kind: "more_time", status: "denied", count: 1 },
      { kind: "unblock_site", status: "expired", count: 2 },
      { kind: "install_app", status: "pending", count: 1 },
    ];
    const content = selectDigestContent(input, facts(requests));
    expect(content.childRequests).toEqual({
      total: 7,
      byKind: [
        { kind: "more_time", approved: 3, denied: 1, expired: 0, waiting: 0 },
        { kind: "unblock_site", approved: 0, denied: 0, expired: 2, waiting: 0 },
        { kind: "install_app", approved: 0, denied: 0, expired: 0, waiting: 1 },
      ],
    });
    expect(selectDigestContent({ ...input, userId: "kid", role: "member" }, facts(requests)).childRequests).toBeUndefined();
    expect(selectDigestContent(input, facts([])).childRequests).toBeUndefined();
    expect(selectDigestContent(input, facts(undefined)).childRequests).toBeUndefined();
  });

  it("renders counts only: no names, sites, apps or reasons", () => {
    const content = selectDigestContent(input, facts([{ kind: "more_time", status: "approved", count: 2 }, { kind: "unblock_site", status: "denied", count: 1 }]));
    const mail = renderWeeklyDigest(content, "https://neo.example.test/unsubscribe/x");
    expect(mail.text).toContain("Requests from children");
    expect(mail.text).toContain("More time: 2 (2 approved)");
    expect(mail.text).toContain("Unblock a site: 1 (1 said no)");
  });
});

describe("Ask Neo link", () => {
  const request = { id: "11111111-1111-4111-8111-111111111111", memberId: "22222222-2222-4222-8222-222222222222", kind: "unblock_site" as const, detail: { domain: "example.com" }, reason: null, status: "pending" as const };
  const base = { appUrl: "https://neo.example.test", request, title: "t", body: "b", memberName: "Sam", deviceName: null, recipient: "owner" as const, hasAccount: true, token: "tok" };
  it("is added only when asked for and the reader has an account", () => {
    expect(renderChildRequestEmail(base).text).not.toMatch(/Ask Neo/);
    const url = "https://neo.example.test/chat-v2?incident=abc";
    expect(renderChildRequestEmail({ ...base, askUrl: url }).text).toContain(`Ask Neo about this: ${url}`);
    expect(renderChildRequestEmail({ ...base, askUrl: url, hasAccount: false }).text).not.toMatch(/Ask Neo/);
  });
});
