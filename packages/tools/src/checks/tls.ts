import * as tls from "node:tls";
import { isIP } from "node:net";
import type { CheckContext, TlsConnectFn, TlsPeer, TlsResult } from "../types.js";
import { DAY_MS } from "../util.js";
import { assertPublicHost } from "./ssrf.js";

/**
 * Default TLS probe: connect to an already-vetted IP with SNI set to the host.
 * Certificates are never trusted for anything; `rejectUnauthorized: false` only
 * lets us report on invalid ones. No application data is sent.
 */
export const defaultTlsConnect: TlsConnectFn = ({ host, address, port, timeoutMs, signal }) =>
  new Promise<TlsPeer>((resolve, reject) => {
    const socket = tls.connect({
      host: address,
      port,
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    const done = (err?: Error, peer?: TlsPeer) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (err) reject(err);
      else resolve(peer!);
    };
    const timer = setTimeout(() => done(Object.assign(new Error("timed out"), { name: "TimeoutError" })), timeoutMs);
    const onAbort = () => done(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (e) => done(e));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(false);
      const authErr = socket.authorizationError as unknown;
      const peer: TlsPeer = {
        authorized: socket.authorized,
        subject: cert.subject as unknown as Record<string, unknown>,
        issuer: cert.issuer as unknown as Record<string, unknown>,
        valid_from: cert.valid_from,
        valid_to: cert.valid_to,
      };
      if (authErr) peer.authorizationError = authErr instanceof Error ? authErr.message : String(authErr);
      if (cert.subjectaltname) peer.subjectaltname = cert.subjectaltname;
      if (cert.fingerprint256) peer.fingerprint256 = cert.fingerprint256;
      done(undefined, peer);
    });
  });

function dn(v: Record<string, unknown> | undefined, key: string): string | undefined {
  const x = v?.[key];
  if (Array.isArray(x)) return x.join(", ");
  return typeof x === "string" ? x : undefined;
}

function toIso(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function summarizeTlsPeer(host: string, peer: TlsPeer, now: Date): TlsResult {
  const valid_from = toIso(peer.valid_from);
  const valid_to = toIso(peer.valid_to);
  const san_count = peer.subjectaltname ? peer.subjectaltname.split(",").filter((s) => s.trim()).length : 0;
  const cert_age_days = valid_from ? Math.floor((now.getTime() - new Date(valid_from).getTime()) / DAY_MS) : undefined;
  const subjectStr = JSON.stringify(peer.subject ?? {});
  const issuerStr = JSON.stringify(peer.issuer ?? {});
  const err = peer.authorizationError ?? "";
  const self_signed = /SELF_SIGNED/i.test(err) || (subjectStr !== "{}" && subjectStr === issuerStr);
  const expired = /EXPIRED/i.test(err) || (valid_to ? new Date(valid_to).getTime() < now.getTime() : false);
  const result: TlsResult = {
    host,
    san_count,
    is_new: cert_age_days !== undefined && cert_age_days < 30,
    expired,
    self_signed,
    valid: peer.authorized,
  };
  const issuer = dn(peer.issuer, "O") ?? dn(peer.issuer, "CN");
  const subject = dn(peer.subject, "CN");
  if (issuer) result.issuer = issuer;
  if (subject) result.subject = subject;
  if (valid_from) result.valid_from = valid_from;
  if (valid_to) result.valid_to = valid_to;
  if (cert_age_days !== undefined) result.cert_age_days = cert_age_days;
  if (err) result.error = err;
  return result;
}

export async function checkTls(host: string, ctx: CheckContext, port = 443): Promise<TlsResult> {
  const addrs = await assertPublicHost(host, ctx.deps.lookup);
  const address = addrs[0]!.address;
  const peer = await ctx.deps.tlsConnect({ host, address, port, timeoutMs: ctx.deps.timeoutMs, signal: ctx.signal });
  return summarizeTlsPeer(host, peer, ctx.deps.now());
}
