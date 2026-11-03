/**
 * Microsoft Graph v1.0 client for the Outlook.com connector. Read-only: it only issues GETs. The real client takes an
 * injected `fetch`; tests and MOCK_MODE never reach Microsoft. Responses are untrusted data: only the few fields the
 * connector needs are copied out, and opaque `nextLink`/`deltaLink` URLs must stay on graph.microsoft.com before they
 * are followed (a link is never fetched with a bearer token anywhere else).
 */
import {
  GraphAuthError,
  GraphHttpError,
  GraphRateLimitError,
  MAX_RETRY_AFTER_SECONDS,
  type GraphDeltaMessage,
  type GraphDeltaPage,
  type GraphMe,
  type GraphMessage,
  type GraphRecipient,
  type GraphRule,
  type GraphRulePage,
  type OutlookGraphClient,
} from "./types";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const DELTA_PAGE_SIZE = 50;
/** No body fields: bodies are fetched only for sender-allowlisted candidates. */
export const DELTA_SELECT = "id,from,receivedDateTime";
const MAX_BODY_CHARS = 512 * 1024;

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function assertGraphUrl(link: string): string {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw new GraphHttpError(400);
  }
  if (u.protocol !== "https:" || u.hostname !== "graph.microsoft.com" || u.username || u.password || u.port) throw new GraphHttpError(400);
  return u.toString();
}

/** Retry-After as seconds or an HTTP date; default 60; capped at one hour. */
export function parseRetryAfter(value: string | null, now = Date.now()): number {
  let seconds = 60;
  if (value) {
    const n = Number(value);
    if (Number.isFinite(n)) seconds = n;
    else {
      const at = Date.parse(value);
      if (Number.isFinite(at)) seconds = (at - now) / 1000;
    }
  }
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
}

function recipients(v: unknown): GraphRecipient[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => ({ address: str(obj(obj(r).emailAddress).address) }));
}

export function createGraphClient(cfg: { accessToken: string; fetch?: Fetch }): OutlookGraphClient {
  const doFetch = cfg.fetch ?? fetch;
  async function get(url: string, signal?: AbortSignal, extra: Record<string, string> = {}): Promise<Json> {
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", headers: { Authorization: `Bearer ${cfg.accessToken}`, Accept: "application/json", ...extra }, ...(signal ? { signal } : {}), redirect: "error" });
    } catch {
      throw new GraphHttpError(0);
    }
    if (res.status === 429) throw new GraphRateLimitError(parseRetryAfter(res.headers.get("Retry-After")));
    if (res.status === 401 || res.status === 403) throw new GraphAuthError();
    if (!res.ok) throw new GraphHttpError(res.status);
    try {
      return obj(await res.json());
    } catch {
      throw new GraphHttpError(502);
    }
  }
  const nextOf = (j: Json): string | undefined => {
    const link = str(j["@odata.nextLink"]);
    return link ? assertGraphUrl(link) : undefined;
  };

  return {
    async getMe(signal) {
      const j = await get(`${GRAPH_BASE}/me?$select=id,mail,userPrincipalName`, signal);
      const id = str(j.id);
      if (!id) throw new GraphHttpError(502);
      // Own addresses are `mail` and `userPrincipalName` only: `otherMails` is user-editable contact data, not proof of ownership.
      const addresses = [str(j.mail), str(j.userPrincipalName)].filter((a): a is string => !!a);
      return { id, displayAddress: str(j.mail) ?? str(j.userPrincipalName) ?? "Outlook.com account", addresses } satisfies GraphMe;
    },
    async listInboxRules(nextLink, signal) {
      const url = nextLink ? assertGraphUrl(nextLink) : `${GRAPH_BASE}/me/mailFolders/inbox/messageRules?$select=id,isEnabled,actions`;
      const j = await get(url, signal);
      const rules: GraphRule[] = (Array.isArray(j.value) ? j.value : []).flatMap((raw): GraphRule[] => {
        const r = obj(raw);
        const id = str(r.id);
        if (!id) return [];
        const a = obj(r.actions);
        return [{ id, enabled: r.isEnabled === true, forwardTo: recipients(a.forwardTo), redirectTo: recipients(a.redirectTo), forwardAsAttachmentTo: recipients(a.forwardAsAttachmentTo) }];
      });
      const next = nextOf(j);
      return { rules, ...(next ? { nextLink: next } : {}) } satisfies GraphRulePage;
    },
    async getInboxDelta({ nextLink, deltaLink, since, signal }) {
      const link = nextLink ?? deltaLink;
      const url = link
        ? assertGraphUrl(link)
        : `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=${DELTA_SELECT}${since ? `&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}` : ""}`;
      const j = await get(url, signal, { Prefer: `odata.maxpagesize=${DELTA_PAGE_SIZE}` });
      const messages: GraphDeltaMessage[] = (Array.isArray(j.value) ? j.value : []).flatMap((raw): GraphDeltaMessage[] => {
        const m = obj(raw);
        const id = str(m.id);
        if (!id) return [];
        return [{ id, fromAddress: str(obj(obj(m.from).emailAddress).address), removed: "@removed" in m }];
      });
      const next = nextOf(j);
      const delta = str(j["@odata.deltaLink"]);
      return { messages, ...(next ? { nextLink: next } : {}), ...(delta ? { deltaLink: assertGraphUrl(delta) } : {}) } satisfies GraphDeltaPage;
    },
    async getCandidateMessage(id, signal) {
      const j = await get(`${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}?$select=id,internetMessageHeaders,body`, signal);
      const headers = (Array.isArray(j.internetMessageHeaders) ? j.internetMessageHeaders : []).flatMap((h) => {
        const o = obj(h);
        const name = str(o.name);
        return name && typeof o.value === "string" ? [{ name, value: o.value }] : [];
      });
      const body = obj(j.body);
      const content = typeof body.content === "string" ? body.content.slice(0, MAX_BODY_CHARS) : "";
      return { id: str(j.id) ?? id, headers, bodyType: str(body.contentType)?.toLowerCase() === "text" ? "text" : "html", body: content } satisfies GraphMessage;
    },
  };
}
