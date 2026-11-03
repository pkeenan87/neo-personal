// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createGraphClient, DELTA_SELECT, parseRetryAfter } from "@/lib/server/outlook/graph";
import { buildRawMessage } from "@/lib/server/outlook/candidates";
import { GraphAuthError, GraphHttpError, GraphRateLimitError } from "@/lib/server/outlook/types";

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

describe("real Graph client (injected fetch)", () => {
  it("delta: GET only, no body fields in $select, page size 50, 30-day filter on the first request", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json({ value: [{ id: "m1", from: { emailAddress: { address: "A@B.com" } } }, { id: "m2", "@removed": { reason: "deleted" } }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?x=1" }));
    const g = createGraphClient({ accessToken: "tok", fetch: f as unknown as typeof fetch });
    const page = await g.getInboxDelta({ since: new Date("2026-09-01T00:00:00Z") });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Prefer).toBe("odata.maxpagesize=50");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(url).toContain("/me/mailFolders/inbox/messages/delta");
    expect(url).toContain(`$select=${DELTA_SELECT}`);
    expect(DELTA_SELECT).not.toMatch(/body|uniqueBody|preview/i);
    expect(decodeURIComponent(url)).toContain("receivedDateTime ge 2026-09-01T00:00:00.000Z");
    expect(page.messages).toEqual([{ id: "m1", fromAddress: "A@B.com", removed: false }, { id: "m2", fromAddress: undefined, removed: true }]);
    expect(page.deltaLink).toBeDefined();
  });
  it("sends the Prefer header again on a nextLink and refuses links that leave graph.microsoft.com", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json({ value: [], "@odata.nextLink": "https://evil.example/steal" }));
    const g = createGraphClient({ accessToken: "tok", fetch: f as unknown as typeof fetch });
    await expect(g.getInboxDelta({})).rejects.toBeInstanceOf(GraphHttpError);
    await expect(g.getInboxDelta({ nextLink: "https://evil.example/x" })).rejects.toBeInstanceOf(GraphHttpError);
    await g.getInboxDelta({ nextLink: "https://graph.microsoft.com/v1.0/next" }).catch(() => undefined);
    const init = f.mock.calls.at(-1)![1] as unknown as RequestInit;
    expect((init.headers as Record<string, string>).Prefer).toBe("odata.maxpagesize=50");
  });
  it("429 honours Retry-After capped at one hour; 401 is an auth error", async () => {
    const mk = (res: () => Response) => createGraphClient({ accessToken: "t", fetch: (async () => res()) as unknown as typeof fetch });
    const e = await mk(() => new Response("", { status: 429, headers: { "Retry-After": "99999" } })).getMe().catch((x) => x);
    expect(e).toBeInstanceOf(GraphRateLimitError);
    expect(e.retryAfterSeconds).toBe(3600);
    expect((await mk(() => new Response("", { status: 429, headers: { "Retry-After": "12" } })).getMe().catch((x) => x)).retryAfterSeconds).toBe(12);
    await expect(mk(() => new Response("", { status: 401 })).getMe()).rejects.toBeInstanceOf(GraphAuthError);
    expect(parseRetryAfter(null)).toBe(60);
  });
  it("reads rules with only the forwarding fields, and candidates with headers and body", async () => {
    const f = vi.fn(async (url: string, _i?: RequestInit) =>
      url.includes("messageRules")
        ? json({ value: [{ id: "r", isEnabled: true, displayName: "ignored", actions: { forwardTo: [{ emailAddress: { name: "n", address: "x@y.example" } }], delete: true } }] })
        : json({ id: "m", internetMessageHeaders: [{ name: "From", value: "a@b.c" }], body: { contentType: "html", content: "<p>hi</p>" } }),
    );
    const g = createGraphClient({ accessToken: "t", fetch: f as unknown as typeof fetch });
    const rules = await g.listInboxRules();
    expect(rules.rules).toEqual([{ id: "r", enabled: true, forwardTo: [{ address: "x@y.example" }], redirectTo: [], forwardAsAttachmentTo: [] }]);
    expect(JSON.stringify(rules)).not.toContain("ignored");
    expect(f.mock.calls[0]![0]).toContain("$select=id,isEnabled,actions");
    const m = await g.getCandidateMessage("m/1");
    expect(f.mock.calls[1]![0]).toContain("/me/messages/m%2F1?$select=id,internetMessageHeaders,body");
    expect(m.bodyType).toBe("html");
    for (const [, init] of f.mock.calls as unknown as Array<[string, RequestInit]>) expect(init.method).toBe("GET");
  });
  it("reconstructed messages drop the original MIME headers and flatten values", () => {
    const raw = buildRawMessage({ id: "1", bodyType: "text", body: "hello", headers: [{ name: "Content-Type", value: "multipart/mixed; boundary=x" }, { name: "Subject", value: "a\r\n b" }, { name: "bad name", value: "z" }] });
    expect(raw).toContain("Subject: a b");
    expect(raw).not.toContain("multipart");
    expect(raw).not.toContain("bad name");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
  });
});
