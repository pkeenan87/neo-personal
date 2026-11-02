// @vitest-environment node
/** Who is emailed about an alert (_specs/v2-m1-elder.md §6): the pure recipient rule. */
import { describe, expect, it } from "vitest";
import {
  recipientKeyPart,
  resendKeyFor,
  resolveAlertRecipients,
  type RecipientMember,
  type RecipientOwner,
} from "@/lib/server/alerts/recipients";

const member = (over: Partial<RecipientMember> & { id: string }): RecipientMember => ({
  userId: null,
  displayName: over.id,
  mode: "standard",
  helperMemberIds: [],
  email: null,
  contact: null,
  ...over,
});

const PAT = member({ id: "m-pat", userId: "u-pat", displayName: "Pat", email: "pat@example.test" });
const GRAN = member({ id: "m-gran", userId: "u-gran", displayName: "Gran", mode: "elder", email: "gran@example.test", helperMemberIds: ["m-son", "m-aunt", "m-ghost"] });
const SON = member({ id: "m-son", userId: "u-son", displayName: "Son", email: "son@example.test" });
const AUNT = member({ id: "m-aunt", displayName: "Aunt", contact: "aunt@example.test" });
const GHOST = member({ id: "m-ghost", displayName: "Ghost" });
const MEMBERS = [PAT, GRAN, SON, AUNT, GHOST];
const owner = (userId: string, email: string | null, threshold: RecipientOwner["threshold"] = "high"): RecipientOwner => ({ userId, email, threshold });

const base = { owners: [owner("u-pat", "pat@example.test")], members: MEMBERS, subject: GRAN, helpersNotifyAt: "high" as const };
const addrs = (r: ReturnType<typeof resolveAlertRecipients>) => r.map((x) => x.address);

describe("owners", () => {
  it("are filtered by their alert_email_threshold", () => {
    const owners = [owner("u-pat", "pat@example.test", "high"), owner("u-b", "b@example.test", "medium"), owner("u-c", "c@example.test", "critical"), owner("u-d", "d@example.test", "off"), owner("u-e", null)];
    const at = (severity: "low" | "medium" | "high" | "critical") => addrs(resolveAlertRecipients({ severity, owners, members: [], subject: null, helpersNotifyAt: undefined }));
    expect(at("low")).toEqual([]);
    expect(at("medium")).toEqual(["b@example.test"]);
    expect(at("high")).toEqual(["pat@example.test", "b@example.test"]);
    expect(at("critical")).toEqual(["pat@example.test", "b@example.test", "c@example.test"]);
  });

  it("carry their member id when they have a member row", () => {
    const [r] = resolveAlertRecipients({ ...base, severity: "high", subject: null });
    expect(r).toMatchObject({ kind: "owner", userId: "u-pat", memberId: "m-pat" });
  });
});

describe("helpers of an Elder or Child member", () => {
  it("are told at or above helpersNotifyAt, using the account email or else the contact, and skipped with neither", () => {
    const r = resolveAlertRecipients({ ...base, severity: "high" });
    expect(r.map((x) => [x.kind, x.address])).toEqual([
      ["owner", "pat@example.test"],
      ["helper", "son@example.test"],
      ["helper", "aunt@example.test"],
    ]);
    expect(r[2]).toMatchObject({ userId: null, memberId: "m-aunt" });
  });

  it("are not told below the threshold, or when none is set", () => {
    expect(addrs(resolveAlertRecipients({ ...base, severity: "medium", owners: [owner("u-pat", "pat@example.test", "medium")] }))).toEqual(["pat@example.test"]);
    expect(addrs(resolveAlertRecipients({ ...base, severity: "critical", helpersNotifyAt: undefined }))).toEqual(["pat@example.test"]);
    expect(addrs(resolveAlertRecipients({ ...base, severity: "medium", helpersNotifyAt: "medium" }))).toEqual(["son@example.test", "aunt@example.test"]);
  });

  it("apply to Child mode too, but never to a Standard member", () => {
    const kid = { ...GRAN, mode: "child" as const };
    expect(addrs(resolveAlertRecipients({ ...base, severity: "high", subject: kid }))).toContain("son@example.test");
    const std = { ...GRAN, mode: "standard" as const };
    expect(addrs(resolveAlertRecipients({ ...base, severity: "high", subject: std }))).toEqual(["pat@example.test"]);
  });
});

describe("self-exclusion", () => {
  const ownerGran = [owner("u-gran", "gran@example.test", "medium"), owner("u-pat", "pat@example.test")];

  it("keeps an Elder member out of alerts about themselves, even when they are an owner", () => {
    const r = resolveAlertRecipients({ ...base, severity: "critical", owners: ownerGran });
    expect(addrs(r)).not.toContain("gran@example.test");
    expect(addrs(r)).toContain("pat@example.test");
  });

  it("also covers the subject being a helper of themselves by member id", () => {
    const loop = { ...GRAN, helperMemberIds: ["m-gran", "m-son"] };
    expect(addrs(resolveAlertRecipients({ ...base, severity: "high", subject: loop, members: [PAT, loop, SON] }))).toEqual(["pat@example.test", "son@example.test"]);
  });

  it("does not apply to a Standard-mode owner, who still hears about their own devices", () => {
    const r = resolveAlertRecipients({ ...base, severity: "high", subject: PAT });
    expect(addrs(r)).toEqual(["pat@example.test"]);
  });
});

describe("dedupe and keys", () => {
  it("dedupes by lowercased address, keeping the owner", () => {
    const son = { ...SON, email: "PAT@example.test" };
    const r = resolveAlertRecipients({ ...base, severity: "high", members: [PAT, GRAN, son, AUNT] });
    expect(r.filter((x) => x.address.toLowerCase() === "pat@example.test")).toHaveLength(1);
    expect(r[0]!.kind).toBe("owner");
  });

  it("keeps the Resend key for account holders and uses the member id for contact-only helpers", () => {
    expect(resendKeyFor("a1", { userId: "u-pat", memberId: "m-pat" })).toBe("alert:a1:u-pat");
    expect(resendKeyFor("a1", { userId: null, memberId: "m-aunt" })).toBe("alert:a1:m:m-aunt");
    expect(recipientKeyPart({ userId: "u-x", memberId: null })).toBe("u:u-x");
    expect(recipientKeyPart({ userId: "u-pat", memberId: "m-pat" })).toBe("m-pat");
  });
});
