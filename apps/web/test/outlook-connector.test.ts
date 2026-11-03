// @vitest-environment node
import { analyzeEmail } from "@neo/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAlertRows, resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { memoryState, memoryVerdicts, setMemoryMembers } from "@/lib/server/memory-state";
import { alertMailboxForwarding } from "@/lib/server/alerts";
import { auditOutlookRules, SEEN_MESSAGE_RETENTION_DAYS } from "@/lib/server/outlook/audit";
import { OUTLOOK_CONCURRENCY, outlookAudit, outlookPoll } from "@/inngest/functions/outlook";
import { isAlertSenderCandidate } from "@/lib/server/outlook/candidates";
import { decryptCursor, decryptPkceVerifier, messageKey, decryptTokens, encryptCursor, encryptPkceVerifier, encryptTokens, hashState } from "@/lib/server/outlook/crypto";
import type { OutlookDeps } from "@/lib/server/outlook/deps";
import { createMockGraphClient, MOCK_MESSAGES } from "@/lib/server/outlook/graph-mock";
import { createGraphClient } from "@/lib/server/outlook/graph";
import { createMicrosoftOAuthClient, createMockOAuthClient, OutlookOAuthError, newPkce } from "@/lib/server/outlook/oauth";
import { pollOutlookInbox, MAX_PAGES_PER_RUN } from "@/lib/server/outlook/poll";
import { classifyRule, normalizeAddress, ownAddressSet } from "@/lib/server/outlook/rules";
import { completeOutlookConnect, disconnectOutlook, getOutlookView, startOutlookConnect } from "@/lib/server/outlook/service";
import { memoryOutlookStore } from "@/lib/server/outlook/store";
import { getAccessToken } from "@/lib/server/outlook/token";
import { GraphHttpError, GraphRateLimitError, type GraphRule, type OutlookGraphClient } from "@/lib/server/outlook/types";
import { finalizeSigninVerdict, persistSigninEvent } from "@/lib/server/signin/service";
import { memorySigninStore } from "@/lib/server/signin/store";
import { saveVerdict } from "@/lib/server/verdicts";
import type { NeoSession } from "@/lib/session";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const mk = (userId: string, role: "owner" | "member", tenantId = TENANT): NeoSession => ({ tenantId, userId, role, email: `${userId}@example.test`, name: userId, scopes: ["full"] });
const OWNER = mk("owner-1", "owner");
const MEMBER = mk("member-1", "member");
const REDIRECT = "http://localhost:3000/api/connectors/outlook/callback";
const ctxOf = (connectorId: string, userId = MEMBER.userId) => ({ tenantId: TENANT, userId, connectorId });

let clock = new Date("2026-10-05T12:00:00Z");
function makeDeps(over: Partial<OutlookDeps> = {}): OutlookDeps {
  return {
    store: memoryOutlookStore,
    oauth: createMockOAuthClient(REDIRECT),
    graphFor: () => createMockGraphClient(),
    now: () => clock,
    source: {},
    analyzeEmail: (input, opts) => analyzeEmail(input, { ...opts, deps: { mock: true, env: {} } }),
    finalizeSignin: finalizeSigninVerdict,
    persistSignin: persistSigninEvent,
    saveVerdict,
    alertForwarding: alertMailboxForwarding,
    ...over,
  };
}

const generationOf = async (deps: OutlookDeps, id: string) => (await deps.store.getConnectorById(TENANT, id))!.connectionGeneration;

async function connect(deps: OutlookDeps, session = MEMBER): Promise<string> {
  const { authorizeUrl } = await startOutlookConnect(session, deps);
  const u = new URL(authorizeUrl);
  expect(await completeOutlookConnect(session, { code: u.searchParams.get("code"), state: u.searchParams.get("state") }, deps)).toBe("connected");
  return (await deps.store.getConnector(TENANT, session.userId))!.id;
}

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  resetMemoryAlerts();
  clock = new Date("2026-10-05T12:00:00Z");
  setMemoryMembers(TENANT, [OWNER, MEMBER].map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role })));
});
afterEach(() => vi.unstubAllEnvs());

describe("encryption", () => {
  const id = { tenantId: TENANT, userId: "u", connectorId: "c" };
  const tokens = { accessToken: "a", refreshToken: "r", expiresAt: "2026-01-01T00:00:00Z" };
  it("round-trips tokens, cursors and PKCE verifiers; the wrong tenant, user or purpose fails", () => {
    const t = encryptTokens(tokens, id, {});
    expect(decryptTokens(t, id, {})).toEqual(tokens);
    expect(() => decryptTokens(t, { ...id, tenantId: OTHER }, {})).toThrow();
    expect(() => decryptTokens(t, { ...id, userId: "v" }, {})).toThrow();
    expect(() => decryptTokens(t, { ...id, connectorId: "d" }, {})).toThrow();
    const c = encryptCursor({ kind: "delta", link: "https://graph.microsoft.com/x", baselineComplete: true, since: "s" }, id, {});
    expect(decryptCursor(c, id, {}).link).toBe("https://graph.microsoft.com/x");
    expect(() => decryptTokens(c, id, {})).toThrow(); // distinct HKDF label
    const p = encryptPkceVerifier("verifier", { tenantId: TENANT, userId: "u", stateId: "s" }, {});
    expect(decryptPkceVerifier(p, { tenantId: TENANT, userId: "u", stateId: "s" }, {})).toBe("verifier");
    expect(() => decryptPkceVerifier(p, { tenantId: TENANT, userId: "u", stateId: "other" }, {})).toThrow();
    expect(Buffer.from(t).includes(Buffer.from("refreshToken"))).toBe(false);
  });
  it("fails closed when deployed without NEO_MASTER_KEY, and uses a dev key only when not deployed", () => {
    expect(() => encryptTokens(tokens, id, { NODE_ENV: "production" })).toThrow(/NEO_MASTER_KEY/);
    expect(() => encryptTokens(tokens, id, { VERCEL_ENV: "preview" })).toThrow(/NEO_MASTER_KEY/);
    expect(() => encryptTokens(tokens, id, {})).not.toThrow();
  });
});

describe("OAuth state and PKCE", () => {
  it("connects through the fake flow; state is stored hashed and is single use", async () => {
    const deps = makeDeps();
    const { authorizeUrl } = await startOutlookConnect(MEMBER, deps);
    const u = new URL(authorizeUrl);
    const state = u.searchParams.get("state")!;
    const stored = memoryState().outlook.states[0]!;
    expect(Buffer.from(stored.stateHash).equals(Buffer.from(hashState(state)))).toBe(true);
    expect(Buffer.from(stored.encryptedPkceVerifier).includes(Buffer.from(state))).toBe(false);
    const params = { code: u.searchParams.get("code"), state };
    expect(await completeOutlookConnect(MEMBER, params, deps)).toBe("connected");
    expect(await completeOutlookConnect(MEMBER, params, deps)).toBe("invalid_state");
  });
  it("rejects an expired state, a missing state and another user's session without burning the state", async () => {
    const deps = makeDeps();
    const { authorizeUrl } = await startOutlookConnect(MEMBER, deps);
    const u = new URL(authorizeUrl);
    const params = { code: u.searchParams.get("code"), state: u.searchParams.get("state") };
    expect(await completeOutlookConnect(OWNER, params, deps)).toBe("invalid_state");
    expect(await completeOutlookConnect(MEMBER, { code: "x" }, deps)).toBe("invalid_state");
    expect(await completeOutlookConnect(mk("member-1", "member", OTHER), params, deps)).toBe("invalid_state");
    clock = new Date(clock.getTime() + 10 * 60_000 + 1);
    expect(await completeOutlookConnect(MEMBER, params, deps)).toBe("invalid_state");
  });
  it("handles access_denied without echoing error_description, and a tampered PKCE code fails", async () => {
    const deps = makeDeps();
    const a = new URL((await startOutlookConnect(MEMBER, deps)).authorizeUrl);
    expect(await completeOutlookConnect(MEMBER, { error: "access_denied", state: a.searchParams.get("state") }, deps)).toBe("denied");
    const b = new URL((await startOutlookConnect(MEMBER, deps)).authorizeUrl);
    expect(await completeOutlookConnect(MEMBER, { code: "mock-wrong-challenge", state: b.searchParams.get("state") }, deps)).toBe("failed");
    expect(await deps.store.getConnector(TENANT, MEMBER.userId)).toBeUndefined();
  });
  it("the real client targets /consumers with S256, the four scopes and the env redirect URI", () => {
    const c = createMicrosoftOAuthClient({ clientId: "cid", clientSecret: "sec", redirectUri: "https://app.test/cb", fetch: vi.fn() });
    const u = new URL(c.authorizeUrl({ state: "st", codeChallenge: newPkce().challenge }));
    expect(u.pathname).toBe("/consumers/oauth2/v2.0/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("offline_access User.Read Mail.Read MailboxSettings.Read");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.test/cb");
    expect(u.toString()).not.toContain("sec");
  });
  it("maps a Microsoft invalid_grant to a typed error without the description", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "secret detail" }), { status: 400 }));
    const c = createMicrosoftOAuthClient({ clientId: "a", clientSecret: "b", redirectUri: "https://x.test/cb", fetch: f as unknown as typeof fetch });
    const err = await c.refresh("r").catch((e) => e);
    expect(err).toBeInstanceOf(OutlookOAuthError);
    expect(err.code).toBe("invalid_grant");
    expect(String(err.message)).not.toContain("secret");
  });
});

describe("token refresh", () => {
  async function expired(deps: OutlookDeps) {
    const id = await connect(deps);
    const c = (await deps.store.getConnectorById(TENANT, id))!;
    const identity = ctxOf(id);
    await deps.store.compareAndSwapTokens(TENANT, id, c.tokenVersion, encryptTokens({ accessToken: "old", refreshToken: "mock-refresh", expiresAt: "2020-01-01T00:00:00Z" }, identity, {}));
    return { id, identity };
  }
  it("refresh loses a compare-and-swap race: the winner's newer token is used, not overwritten", async () => {
    const base = makeDeps();
    const { id, identity } = await expired(base);
    const deps = makeDeps({
      oauth: {
        ...base.oauth,
        refresh: async () => {
          const c = (await memoryOutlookStore.getConnectorById(TENANT, id))!;
          await memoryOutlookStore.compareAndSwapTokens(TENANT, id, c.tokenVersion, encryptTokens({ accessToken: "winner", refreshToken: "mock-refresh", expiresAt: "2099-01-01T00:00:00Z" }, identity, {}));
          return { accessToken: "loser", refreshToken: "mock-refresh", expiresIn: 3600 };
        },
      },
    });
    expect(await getAccessToken(identity, deps)).toEqual({ ok: true, accessToken: "winner" });
    const c = (await memoryOutlookStore.getConnectorById(TENANT, id))!;
    expect(decryptTokens(c.encryptedTokens!, identity, {}).accessToken).toBe("winner");
  });
  it("invalid_grant becomes reauth_required, drops the tokens and is not retried", async () => {
    const base = makeDeps();
    const { id, identity } = await expired(base);
    const c = (await base.store.getConnectorById(TENANT, id))!;
    await base.store.compareAndSwapTokens(TENANT, id, c.tokenVersion, encryptTokens({ accessToken: "old", refreshToken: "revoked", expiresAt: "2020-01-01T00:00:00Z" }, identity, {}));
    const refresh = vi.fn(base.oauth.refresh);
    const deps = makeDeps({ oauth: { ...base.oauth, refresh } });
    expect(await getAccessToken(identity, deps)).toEqual({ ok: false, reason: "reauth_required" });
    expect(await getAccessToken(identity, deps)).toEqual({ ok: false, reason: "reauth_required" });
    expect(refresh).toHaveBeenCalledTimes(1);
    const after = (await base.store.getConnectorById(TENANT, id))!;
    expect(after.status).toBe("reauth_required");
    expect(after.encryptedTokens).toBeUndefined();
    expect((await pollOutlookInbox(identity, deps)).status).toBe("skipped");
    expect((await memoryOutlookStore.listConnected()).items).toEqual([]);
  });
});

describe("rule audit", () => {
  const rule = (over: Partial<GraphRule>): GraphRule => ({ id: "r1", enabled: true, forwardTo: [], redirectTo: [], forwardAsAttachmentTo: [], ...over });
  const own = ownAddressSet(["Jo.Doe@outlook.com"]);
  it("classifies disabled, internal (own address and +alias), external and indeterminate rules", () => {
    expect(classifyRule(rule({ enabled: false, forwardTo: [{ address: "x@evil.example" }] }), own).class).toBe("disabled");
    expect(classifyRule(rule({}), own).class).toBe("none");
    expect(classifyRule(rule({ forwardTo: [{ address: "jo.doe+bills@outlook.com" }] }), own).class).toBe("internal");
    expect(classifyRule(rule({ forwardTo: [{ address: "Jo.Doe@Outlook.com" }] }), own).class).toBe("internal");
    expect(classifyRule(rule({ forwardTo: [{ address: "jodoe@outlook.com" }] }), own).class).toBe("external"); // dots matter
    const ext = classifyRule(rule({ forwardAsAttachmentTo: [{ address: "a@Mail-Drop.example" }], redirectTo: [{ address: "jo.doe@outlook.com" }] }), own);
    expect(ext.class).toBe("external");
    expect(ext.findings).toEqual([expect.objectContaining({ action: "forward_as_attachment_to", destinationDomain: "mail-drop.example" })]);
    expect(classifyRule(rule({ redirectTo: [{ address: "not an address" }] }), own).class).toBe("indeterminate");
    expect(normalizeAddress("a@b")).toBeUndefined();
  });
  it("raises mailbox_forwarding once with the domain only, dedupes repeats, and resolves a disabled rule", async () => {
    let rules: GraphRule[] = [rule({ id: "x", redirectTo: [{ address: "collector@mail-drop.example" }] })];
    const graph: OutlookGraphClient = { ...createMockGraphClient(), listInboxRules: async () => ({ rules }) };
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps); // the connect-time audit raised the first alert
    const alerts = () => memoryAlertRows().filter((a) => a.kind === "mailbox_forwarding");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ severity: "high", subjectUserId: MEMBER.userId });
    expect(alerts()[0]!.body).toContain("mail-drop.example");
    expect(alerts()[0]!.body + alerts()[0]!.title).not.toContain("collector@");
    expect((await auditOutlookRules(ctxOf(id), deps)).raised).toBe(0);
    expect(alerts()).toHaveLength(1);
    rules = [{ ...rules[0]!, enabled: false }];
    await auditOutlookRules(ctxOf(id), deps);
    expect(await deps.store.listFindings(TENANT, MEMBER.userId, { state: "active" })).toEqual([]);
    expect(await deps.store.listFindings(TENANT, MEMBER.userId, { state: "resolved" })).toHaveLength(1);
    clock = new Date(clock.getTime() + 3_600_000);
    rules = [{ ...rules[0]!, enabled: true }]; // comes back: a new activation alerts again
    await auditOutlookRules(ctxOf(id), deps);
    expect(alerts()).toHaveLength(2);
  });
  it("an owner's own mailbox never alerts the household, but the owner sees their finding", async () => {
    const deps = makeDeps();
    await connect(deps, OWNER);
    expect(memoryAlertRows().filter((a) => a.kind === "mailbox_forwarding")).toEqual([]);
    expect((await getOutlookView(OWNER, "mock", deps.store)).findings.length).toBeGreaterThan(0);
  });
});

describe("delta poll", () => {
  const MSG = (id: string, from = "no-reply@accounts.google.com") => ({ id, fromAddress: from });
  it("prefilters on the step-4 sender list", () => {
    expect(isAlertSenderCandidate("no-reply@accounts.google.com")).toBe(true);
    expect(isAlertSenderCandidate("Account-Security-Noreply@accountprotection.microsoft.com")).toBe(true);
    expect(isAlertSenderCandidate("anything@id.apple.com")).toBe(true);
    expect(isAlertSenderCandidate("news@store.example")).toBe(false);
    expect(isAlertSenderCandidate("no-reply@accounts.google.com.evil.example")).toBe(false);
    expect(isAlertSenderCandidate(undefined)).toBe(false);
  });
  it("baseline run fetches no message and alerts nothing; the next run records the authenticated alert and the spoofed one without a verdict", async () => {
    const getCandidateMessage = vi.fn(createMockGraphClient().getCandidateMessage);
    const graph: OutlookGraphClient = { ...createMockGraphClient(), getCandidateMessage };
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps);
    const first = await pollOutlookInbox(ctxOf(id), deps);
    expect(first).toMatchObject({ status: "ok", pages: 1, candidates: 0 });
    expect(getCandidateMessage).not.toHaveBeenCalled();
    const cursor = decryptCursor((await deps.store.getConnectorById(TENANT, id))!.encryptedDeltaCursor!, ctxOf(id), {});
    expect(cursor).toMatchObject({ kind: "delta", baselineComplete: true });
    expect(await memorySigninStore.list(TENANT, MEMBER.userId)).toEqual([]);

    const second = await pollOutlookInbox(ctxOf(id), deps);
    expect(second.candidates).toBe(2);
    expect(getCandidateMessage.mock.calls.map((c) => c[0]).sort()).toEqual(["mock-google-genuine", "mock-google-spoofed"]); // the newsletter is never fetched
    const events = await memorySigninStore.list(TENANT, MEMBER.userId);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.source === "outlook")).toBe(true);
    expect(events.filter((e) => e.authenticated)).toHaveLength(1);
    const spoof = events.find((e) => !e.authenticated)!;
    expect(spoof.verdictId).toBeNull();
    expect(memoryVerdicts()).toHaveLength(1); // only the authenticated one
    expect(memoryAlertRows().filter((a) => a.kind === "member_verdict" && a.severity === "high")).toEqual([]);
    expect((await deps.store.getConnectorById(TENANT, id))!.lastPollAt).toEqual(clock);
  });
  it("stops at 10 pages, saves the encrypted nextLink after each page, and resumes from it", async () => {
    let n = 0;
    const calls: Array<{ nextLink?: string | undefined; since?: Date | undefined }> = [];
    const graph: OutlookGraphClient = {
      ...createMockGraphClient(),
      getInboxDelta: async (i) => {
        calls.push({ nextLink: i.nextLink, since: i.since });
        n++;
        return { messages: [], nextLink: `https://graph.microsoft.com/v1.0/page${n}` };
      },
    };
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps);
    const r = await pollOutlookInbox(ctxOf(id), deps);
    expect(r.pages).toBe(MAX_PAGES_PER_RUN);
    expect(calls[0]!.since).toEqual(new Date(clock.getTime() - 30 * 86_400_000));
    const cur = decryptCursor((await deps.store.getConnectorById(TENANT, id))!.encryptedDeltaCursor!, ctxOf(id), {});
    expect(cur).toMatchObject({ kind: "next", link: "https://graph.microsoft.com/v1.0/page10", baselineComplete: false });
    await pollOutlookInbox(ctxOf(id), deps);
    expect(calls[10]!.nextLink).toBe("https://graph.microsoft.com/v1.0/page10");
  });
  it("a failed page does not advance the cursor", async () => {
    const deps0 = makeDeps();
    const id = await connect(deps0);
    await pollOutlookInbox(ctxOf(id), deps0); // baseline
    const before = (await deps0.store.getConnectorById(TENANT, id))!.encryptedDeltaCursor!;
    const graph: OutlookGraphClient = { ...createMockGraphClient(), getCandidateMessage: async () => { throw new GraphHttpError(500); } };
    await expect(pollOutlookInbox(ctxOf(id), makeDeps({ graphFor: () => graph }))).rejects.toBeInstanceOf(GraphHttpError);
    const after = decryptCursor((await deps0.store.getConnectorById(TENANT, id))!.encryptedDeltaCursor!, ctxOf(id), {});
    expect(after.link).toBe(decryptCursor(before, ctxOf(id), {}).link);
  });
  it("a 429 stops the run and reports the wait for the Inngest sleep", async () => {
    const graph: OutlookGraphClient = { ...createMockGraphClient(), getInboxDelta: async () => { throw new GraphRateLimitError(3600); } };
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps);
    expect(await pollOutlookInbox(ctxOf(id), deps)).toMatchObject({ status: "rate_limited", retryAfterSeconds: 3600 });
  });
  it("an unreadable cursor restarts as a baseline instead of wedging", async () => {
    const deps = makeDeps();
    const id = await connect(deps);
    await deps.store.updateCursor(TENANT, id, await generationOf(deps, id), encryptCursor({ kind: "delta", link: "https://graph.microsoft.com/x", baselineComplete: true, since: "s" }, ctxOf(id, "someone-else"), {}));
    const r = await pollOutlookInbox(ctxOf(id), deps);
    expect(r.candidates).toBe(0);
  });
  it("does not revisit candidates already handled on a retried page", async () => {
    const getCandidateMessage = vi.fn(createMockGraphClient().getCandidateMessage);
    const graph: OutlookGraphClient = { ...createMockGraphClient(), getCandidateMessage };
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps);
    await pollOutlookInbox(ctxOf(id), deps);
    const cur = decryptCursor((await deps.store.getConnectorById(TENANT, id))!.encryptedDeltaCursor!, ctxOf(id), {});
    await deps.store.updateCursor(TENANT, id, await generationOf(deps, id), encryptCursor({ ...cur, done: ["mock-google-genuine"] }, ctxOf(id), {}));
    await pollOutlookInbox(ctxOf(id), deps);
    expect(getCandidateMessage.mock.calls.map((c) => c[0])).toEqual(["mock-google-spoofed"]);
    void MSG;
  });
});

describe("disconnect and views", () => {
  it("deletes token and cursor ciphertext, stops scheduling, keeps findings and alerts", async () => {
    const deps = makeDeps();
    const id = await connect(deps);
    await pollOutlookInbox(ctxOf(id), deps);
    expect((await deps.store.getConnectorById(TENANT, id))!.encryptedDeltaCursor).toBeDefined();
    expect(await disconnectOutlook(MEMBER, deps)).toEqual({ disconnected: true });
    const c = (await deps.store.getConnectorById(TENANT, id))!;
    expect(c).toMatchObject({ status: "disconnected" });
    expect(c.encryptedTokens).toBeUndefined();
    expect(c.encryptedDeltaCursor).toBeUndefined();
    expect((await deps.store.listConnected()).items).toEqual([]);
    expect((await pollOutlookInbox(ctxOf(id), deps)).status).toBe("skipped");
    expect(await deps.store.listFindings(TENANT, MEMBER.userId)).not.toEqual([]);
    expect(memoryAlertRows().some((a) => a.kind === "mailbox_forwarding")).toBe(true);
    expect((await getOutlookView(MEMBER, "mock", deps.store)).connector).toBeNull();
    expect((await disconnectOutlook(mk("nobody", "member"), deps)).disconnected).toBe(false);
  });
  it("owner sees status and last check only; members see their own data and no household list", async () => {
    const deps = makeDeps();
    const id = await connect(deps);
    await pollOutlookInbox(ctxOf(id), deps);
    const owner = await getOutlookView(OWNER, "mock", deps.store);
    expect(owner.connector).toBeNull();
    expect(owner.findings).toEqual([]);
    expect(owner.household).toEqual([{ userId: MEMBER.userId, name: "member-1", status: "connected", lastCheckAt: clock.toISOString() }]);
    expect(JSON.stringify(owner)).not.toContain("outlook.com");
    const member = await getOutlookView(MEMBER, "mock", deps.store);
    expect(member.household).toBeUndefined();
    expect(member.connector?.displayAddress).toBe("mock.user@outlook.com");
    expect(member.appAccessUrl).toBe("https://account.microsoft.com/privacy/app-access");
  });
  it("removing the membership removes the connector, states and findings", async () => {
    const deps = makeDeps();
    await connect(deps);
    setMemoryMembers(TENANT, [OWNER].map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role })));
    expect(memoryState().outlook).toEqual({ connectors: [], states: [], findings: [], seen: [] });
  });
});

describe("review fix 1: mail links are never fetched", () => {
  const withAttackerLink = (id: string) => ({ ...MOCK_MESSAGES[id]!, body: `${MOCK_MESSAGES[id]!.body}<a href="https://attacker.example/login?x=1">Secure your account</a>` });
  const spies = () => ({ fetch: vi.fn(async () => new Response("<html></html>")), lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]), tlsConnect: vi.fn(async () => { throw new Error("no network"); }) });

  it("an Outlook candidate triggers zero URL fetches, lookups and reputation calls, and link rules still see the hosts", async () => {
    const s = spies();
    const seen: number[] = [];
    const graph: OutlookGraphClient = { ...createMockGraphClient(), getCandidateMessage: async (id) => withAttackerLink(id) };
    const deps = makeDeps({
      graphFor: () => graph,
      analyzeEmail: (input, opts) => {
        seen.push(opts.maxUrls);
        return analyzeEmail(input, { ...opts, deps: { mock: false, env: {}, ...s } });
      },
    });
    const id = await connect(deps);
    await pollOutlookInbox(ctxOf(id), deps); // baseline
    const second = await pollOutlookInbox(ctxOf(id), deps);
    expect(second.candidates).toBe(2);
    expect(seen).toEqual([0, 0]);
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.lookup).not.toHaveBeenCalled();
    expect(s.tlsConnect).not.toHaveBeenCalled();
    // The link is still extracted without fetching: the sign-in rules see the off-provider host, so the genuine alert is not trusted.
    const events = await memorySigninStore.list(TENANT, MEMBER.userId);
    expect(events).toHaveLength(2);
    const verdict = memoryVerdicts()[0]!;
    expect(JSON.stringify(verdict)).not.toContain("attacker.example/login"); // never echoed
    expect(verdict.verdict).not.toBe("safe");
  });
  it("control: the same message with a positive maxUrls does hit the fetch spy", async () => {
    const s = spies();
    const m = withAttackerLink("mock-google-genuine");
    const raw = (await import("@/lib/server/outlook/candidates")).buildRawMessage(m);
    await analyzeEmail({ raw }, { maxUrls: 6, deps: { mock: false, env: {}, ...s } });
    expect(s.fetch.mock.calls.length + s.lookup.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("review fix 2: cross-run idempotency", () => {
  /** Delta feed that re-emits the same genuine alert on every run after the baseline. */
  function replayGraph(getCandidateMessage = vi.fn(createMockGraphClient().getCandidateMessage)): { graph: OutlookGraphClient; getCandidateMessage: typeof getCandidateMessage } {
    let n = 0;
    const graph: OutlookGraphClient = {
      ...createMockGraphClient(),
      getCandidateMessage,
      getInboxDelta: async ({ deltaLink }) => (deltaLink ? { messages: [{ id: "mock-google-genuine", fromAddress: "no-reply@accounts.google.com" }], deltaLink: `mock-delta:${++n}` } : { messages: [], deltaLink: "mock-delta:0" }),
    };
    return { graph, getCandidateMessage };
  }
  it("the same message re-emitted by a later poll creates no second event, verdict or alert", async () => {
    const { graph, getCandidateMessage } = replayGraph();
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps);
    await pollOutlookInbox(ctxOf(id), deps); // baseline
    expect((await pollOutlookInbox(ctxOf(id), deps)).candidates).toBe(1);
    const alerts = memoryAlertRows().length;
    const again = await pollOutlookInbox(ctxOf(id), deps);
    const third = await pollOutlookInbox(ctxOf(id), deps);
    expect([again.candidates, third.candidates]).toEqual([0, 0]);
    expect(getCandidateMessage).toHaveBeenCalledTimes(1);
    expect(await memorySigninStore.list(TENANT, MEMBER.userId)).toHaveLength(1);
    expect(memoryVerdicts()).toHaveLength(1);
    expect(memoryAlertRows()).toHaveLength(alerts);
  });
  it("stores only a keyed per-tenant fingerprint, never the Graph message id", async () => {
    const { graph } = replayGraph();
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps);
    await pollOutlookInbox(ctxOf(id), deps);
    await pollOutlookInbox(ctxOf(id), deps);
    const rows = memoryState().outlook.seen;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messageKey).toBe(messageKey("mock-google-genuine", TENANT, {}));
    expect(rows[0]!.messageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain("mock-google-genuine");
    expect(messageKey("mock-google-genuine", OTHER, {})).not.toBe(rows[0]!.messageKey);
    expect(() => messageKey("m", TENANT, { NODE_ENV: "production" })).toThrow(/NEO_MASTER_KEY/);
  });
  it("a transient Graph failure releases the claim so the retry still processes the message", async () => {
    const real = createMockGraphClient().getCandidateMessage;
    let fail = true;
    const { graph } = replayGraph(vi.fn(async (id: string) => { if (fail) throw new GraphHttpError(500); return real(id); }));
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps);
    await pollOutlookInbox(ctxOf(id), deps);
    await expect(pollOutlookInbox(ctxOf(id), deps)).rejects.toBeInstanceOf(GraphHttpError);
    expect(memoryState().outlook.seen).toEqual([]);
    fail = false;
    expect((await pollOutlookInbox(ctxOf(id), deps)).candidates).toBe(1);
    expect(await memorySigninStore.list(TENANT, MEMBER.userId)).toHaveLength(1);
  });
  it("the daily audit purges fingerprints older than 45 days and keeps newer ones", async () => {
    const deps = makeDeps();
    const id = await connect(deps);
    const gen = await generationOf(deps, id);
    const old = new Date(clock.getTime() - (SEEN_MESSAGE_RETENTION_DAYS + 1) * 86_400_000);
    const fresh = new Date(clock.getTime() - (SEEN_MESSAGE_RETENTION_DAYS - 1) * 86_400_000);
    await deps.store.claimMessage(TENANT, id, gen, "old-key", old);
    await deps.store.claimMessage(TENANT, id, gen, "fresh-key", fresh);
    await auditOutlookRules(ctxOf(id), deps);
    expect(memoryState().outlook.seen.map((r) => r.messageKey)).toEqual(["fresh-key"]);
  });
  it("disconnect forgets the fingerprints", async () => {
    const { graph } = replayGraph();
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps);
    await pollOutlookInbox(ctxOf(id), deps);
    await pollOutlookInbox(ctxOf(id), deps);
    expect(memoryState().outlook.seen).toHaveLength(1);
    await disconnectOutlook(MEMBER, deps);
    expect(memoryState().outlook.seen).toEqual([]);
  });
  it("poll and audit run one at a time per connector, alongside the per-tenant limit", () => {
    expect(OUTLOOK_CONCURRENCY).toEqual([{ limit: 3, key: "event.data.tenantId" }, { limit: 1, key: "event.data.connectorId" }]);
    for (const f of [outlookPoll, outlookAudit]) expect((f as unknown as { opts: { concurrency: unknown } }).opts.concurrency).toEqual(OUTLOOK_CONCURRENCY);
  });
});

describe("review fix 3: a failed forwarding alert is retried", () => {
  it("alerted_at is set only after the alert succeeds; the next audit alerts; later audits do not repeat it", async () => {
    const alertForwarding = vi.fn<OutlookDeps["alertForwarding"]>(alertMailboxForwarding);
    alertForwarding.mockResolvedValueOnce("failed");
    const deps = makeDeps({ alertForwarding });
    const id = await connect(deps); // the connect-time audit's alert fails (transient)
    const alerts = () => memoryAlertRows().filter((a) => a.kind === "mailbox_forwarding");
    expect(alerts()).toHaveLength(0);
    expect((await deps.store.listFindings(TENANT, MEMBER.userId, { state: "active" })).every((f) => !f.alertedAt)).toBe(true);
    expect(alertForwarding).toHaveBeenCalledTimes(1);

    expect((await auditOutlookRules(ctxOf(id), deps)).raised).toBe(1);
    expect(alerts()).toHaveLength(1);
    expect((await deps.store.listFindings(TENANT, MEMBER.userId, { state: "active" })).every((f) => f.alertedAt)).toBe(true);
    expect(alertForwarding).toHaveBeenCalledTimes(2);

    expect((await auditOutlookRules(ctxOf(id), deps)).raised).toBe(0);
    expect(alertForwarding).toHaveBeenCalledTimes(2); // nothing unalerted is left
    expect(alerts()).toHaveLength(1);
  });
  it("a deduplicated repeat and an owner's own mailbox count as final, so they are not retried forever", async () => {
    const owner = makeDeps();
    await connect(owner, OWNER);
    expect(await owner.store.listUnalertedFindings(TENANT, (await owner.store.getConnector(TENANT, OWNER.userId))!.id)).toEqual([]);
    const outcomes = [] as string[];
    const deps = makeDeps({ alertForwarding: async (i) => { const r = await alertMailboxForwarding(i); outcomes.push(r); return r; } });
    const id = await connect(deps);
    expect(outcomes).toEqual(["raised"]);
    const f = (await deps.store.listFindings(TENANT, MEMBER.userId, { state: "active" }))[0]!;
    expect(await alertMailboxForwarding({ tenantId: TENANT, userId: MEMBER.userId, findingId: f.id, observedAt: f.observedAt, destinationDomain: f.destinationDomain ?? null })).toBe("exists");
    void id;
  });
  it("a re-activated finding is unalerted again and alerts as a new activation", async () => {
    let rules: GraphRule[] = [{ id: "x", enabled: true, forwardTo: [], redirectTo: [{ address: "c@mail-drop.example" }], forwardAsAttachmentTo: [] }];
    const graph: OutlookGraphClient = { ...createMockGraphClient(), listInboxRules: async () => ({ rules }) };
    const deps = makeDeps({ graphFor: () => graph });
    const id = await connect(deps);
    rules = [{ ...rules[0]!, enabled: false }];
    await auditOutlookRules(ctxOf(id), deps);
    clock = new Date(clock.getTime() + 3_600_000);
    rules = [{ ...rules[0]!, enabled: true }];
    expect((await auditOutlookRules(ctxOf(id), deps)).raised).toBe(1);
    expect(memoryAlertRows().filter((a) => a.kind === "mailbox_forwarding")).toHaveLength(2);
  });
});

describe("review fix 4: a poll in flight cannot write after disconnect or reconnect", () => {
  /** A graph whose first delta call runs `during` (the disconnect/reconnect) before returning a page. */
  function racingGraph(during: () => Promise<void>): OutlookGraphClient {
    let ran = false;
    return {
      ...createMockGraphClient(),
      getInboxDelta: async (i) => {
        if (!ran) { ran = true; await during(); }
        return { messages: [], deltaLink: `mock-delta:${i.deltaLink ? 2 : 1}` };
      },
    };
  }
  it("disconnect mid-poll: no cursor ciphertext or poll time is written back", async () => {
    const base = makeDeps();
    const id = await connect(base);
    const deps = makeDeps({ graphFor: () => racingGraph(async () => { await disconnectOutlook(MEMBER, base); }) });
    expect((await pollOutlookInbox(ctxOf(id), deps)).status).toBe("skipped");
    const c = (await base.store.getConnectorById(TENANT, id))!;
    expect(c.status).toBe("disconnected");
    expect(c.encryptedDeltaCursor).toBeUndefined();
    expect(c.lastPollAt).toBeUndefined();
  });
  it("disconnect and reconnect mid-poll: the stale run does not touch the new connection", async () => {
    const base = makeDeps();
    const id = await connect(base);
    const before = await generationOf(base, id);
    const deps = makeDeps({ graphFor: () => racingGraph(async () => { await disconnectOutlook(MEMBER, base); await connect(base); }) });
    expect((await pollOutlookInbox(ctxOf(id), deps)).status).toBe("skipped");
    const c = (await base.store.getConnectorById(TENANT, id))!;
    expect(c.status).toBe("connected");
    expect(c.connectionGeneration).toBeGreaterThan(before);
    expect(c.encryptedDeltaCursor).toBeUndefined();
    expect(c.lastPollAt).toBeUndefined();
  });
  it("updateCursor, touch and claimMessage need status connected and the current generation; a token refresh does not change the generation", async () => {
    const deps = makeDeps();
    const id = await connect(deps);
    const gen = await generationOf(deps, id);
    const c = (await deps.store.getConnectorById(TENANT, id))!;
    await deps.store.compareAndSwapTokens(TENANT, id, c.tokenVersion, c.encryptedTokens!);
    expect(await generationOf(deps, id)).toBe(gen);
    expect(await deps.store.updateCursor(TENANT, id, gen, new Uint8Array([1]))).toBe(true);
    expect(await deps.store.updateCursor(TENANT, id, gen + 1, new Uint8Array([2]))).toBe(false);
    expect(await deps.store.touch(TENANT, id, gen + 1, { lastPollAt: clock })).toBe(false);
    expect(await deps.store.claimMessage(TENANT, id, gen + 1, "k", clock)).toBe(false);
    await disconnectOutlook(MEMBER, deps);
    expect(await deps.store.updateCursor(TENANT, id, gen, new Uint8Array([3]))).toBe(false);
    expect(await deps.store.touch(TENANT, id, gen, { lastPollAt: clock })).toBe(false);
    expect(await deps.store.claimMessage(TENANT, id, gen, "k", clock)).toBe(false);
    expect((await deps.store.getConnectorById(TENANT, id))!.encryptedDeltaCursor).toBeUndefined();
  });
  it("an audit in flight across a disconnect does not write its time", async () => {
    const base = makeDeps();
    const id = await connect(base);
    const graph: OutlookGraphClient = { ...createMockGraphClient(), listInboxRules: async () => { await disconnectOutlook(MEMBER, base); return { rules: [] }; } };
    const connectAudit = (await base.store.getConnectorById(TENANT, id))!.lastAuditAt;
    clock = new Date(clock.getTime() + 3_600_000);
    await auditOutlookRules(ctxOf(id), makeDeps({ graphFor: () => graph }));
    expect((await base.store.getConnectorById(TENANT, id))!.lastAuditAt).toEqual(connectAudit); // not advanced
  });
});

describe("review fix 5: own addresses", () => {
  const rule = (over: Partial<GraphRule>): GraphRule => ({ id: "r1", enabled: true, forwardTo: [], redirectTo: [], forwardAsAttachmentTo: [], ...over });
  const own = ownAddressSet(["jo.doe@outlook.com"]);
  it("only mail and userPrincipalName are own addresses; otherMails is never requested or trusted", async () => {
    const urls: string[] = [];
    const fetchStub = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: "u1", mail: "Jo.Doe@outlook.com", userPrincipalName: "jo@live.com", otherMails: ["attacker@evil.example"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const me = await createGraphClient({ accessToken: "t", fetch: fetchStub }).getMe();
    expect(me.addresses).toEqual(["Jo.Doe@outlook.com", "jo@live.com"]);
    expect(urls[0]).not.toContain("otherMails");
    const ownSet = ownAddressSet(me.addresses);
    expect(classifyRule(rule({ forwardTo: [{ address: "attacker@evil.example" }] }), ownSet).class).toBe("external");
  });
  it("a display-name wrapper, angle brackets or mailto: is not unwrapped: it is indeterminate and treated as external (mailto: is no own address)", async () => {
    expect(classifyRule(rule({ forwardTo: [{ address: "mailto:jo.doe@outlook.com" }] }), own).class).toBe("external"); // not the own address either
    for (const address of ["Jo Doe <jo.doe@outlook.com>", "<jo.doe@outlook.com>", "jo.doe@outlook.com, evil@x.example", "evil@x.example <jo.doe@outlook.com>"]) {
      const r = classifyRule(rule({ forwardTo: [{ address }] }), own);
      expect(r.class, address).toBe("indeterminate");
      expect(r.findings, address).toHaveLength(1);
      expect(r.findings[0]!.destinationDomain).toBeUndefined();
    }
    expect(normalizeAddress("Jo Doe <jo.doe@outlook.com>")).toBeUndefined();
    expect(classifyRule(rule({ forwardTo: [{ address: "JO.DOE+bills@Outlook.com" }] }), own).class).toBe("internal");
    // End to end: an indeterminate destination raises the owner-facing alert.
    const graph: OutlookGraphClient = {
      ...createMockGraphClient(),
      getMe: async () => ({ id: "u", displayAddress: "jo.doe@outlook.com", addresses: ["jo.doe@outlook.com"] }),
      listInboxRules: async () => ({ rules: [rule({ id: "w", forwardTo: [{ address: "Jo Doe <jo.doe@outlook.com>" }] })] }),
    };
    await connect(makeDeps({ graphFor: () => graph }));
    expect(memoryAlertRows().filter((a) => a.kind === "mailbox_forwarding")).toHaveLength(1);
  });
});

describe("review fix 6: a delta reset still records the poll", () => {
  it("a 410 drops the cursor, reports reset and updates lastPollAt", async () => {
    const base = makeDeps();
    const id = await connect(base);
    await pollOutlookInbox(ctxOf(id), base);
    clock = new Date(clock.getTime() + 3_600_000);
    const graph: OutlookGraphClient = { ...createMockGraphClient(), getInboxDelta: async () => { throw new GraphHttpError(410); } };
    expect((await pollOutlookInbox(ctxOf(id), makeDeps({ graphFor: () => graph }))).status).toBe("reset");
    const c = (await base.store.getConnectorById(TENANT, id))!;
    expect(c.encryptedDeltaCursor).toBeUndefined();
    expect(c.lastPollAt).toEqual(clock);
  });
});
