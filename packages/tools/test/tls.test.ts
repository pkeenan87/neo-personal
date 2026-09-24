import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());
vi.mock("node:tls", async (orig) => ({ ...(await orig<typeof import("node:tls")>()), connect: connectMock }));

import { checkTls, defaultTlsConnect, summarizeTlsPeer } from "../src/checks/tls.js";
import { resolveDeps } from "../src/deps.js";
import { fakeLookup, NOW, testDeps } from "./helpers.js";

type FakeSocket = EventEmitter & { authorized: boolean; authorizationError?: Error; getPeerCertificate: () => unknown; destroy: () => void };

function fakeSocket(cert: Record<string, unknown>, authorized: boolean, authorizationError?: string): FakeSocket {
  const s = new EventEmitter() as FakeSocket;
  s.authorized = authorized;
  if (authorizationError) s.authorizationError = Object.assign(new Error(authorizationError), { code: authorizationError });
  s.getPeerCertificate = () => cert;
  s.destroy = vi.fn();
  return s;
}

beforeEach(() => connectMock.mockReset());

describe("defaultTlsConnect (mocked tls.connect)", () => {
  it("connects to the vetted IP with SNI and never rejects invalid certs (report only)", async () => {
    const sock = fakeSocket(
      {
        subject: { CN: "evil.test" },
        issuer: { CN: "evil.test" },
        valid_from: "Jan 14 00:00:00 2026 GMT",
        valid_to: "Jan 14 00:00:00 2027 GMT",
        subjectaltname: "DNS:evil.test",
      },
      false,
      "DEPTH_ZERO_SELF_SIGNED_CERT",
    );
    connectMock.mockImplementation(() => {
      queueMicrotask(() => sock.emit("secureConnect"));
      return sock;
    });
    const peer = await defaultTlsConnect({ host: "evil.test", address: "93.184.215.14", port: 443, timeoutMs: 1000 });
    expect(connectMock).toHaveBeenCalledWith(expect.objectContaining({ host: "93.184.215.14", servername: "evil.test", port: 443, rejectUnauthorized: false }));
    expect(sock.destroy).toHaveBeenCalled();
    const r = summarizeTlsPeer("evil.test", peer, NOW);
    expect(r).toMatchObject({ valid: false, self_signed: true, is_new: true, cert_age_days: 1, san_count: 1, error: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  });

  it("rejects on socket error and times out", async () => {
    const errSock = fakeSocket({}, false);
    connectMock.mockImplementationOnce(() => {
      queueMicrotask(() => errSock.emit("error", new Error("ECONNREFUSED")));
      return errSock;
    });
    await expect(defaultTlsConnect({ host: "a.test", address: "93.184.215.14", port: 443, timeoutMs: 1000 })).rejects.toThrow("ECONNREFUSED");

    connectMock.mockImplementationOnce(() => fakeSocket({}, false));
    await expect(defaultTlsConnect({ host: "a.test", address: "93.184.215.14", port: 443, timeoutMs: 10 })).rejects.toThrow("timed out");
  });
});

describe("checkTls", () => {
  it("summarizes a valid, established certificate", async () => {
    const sock = fakeSocket(
      {
        subject: { CN: "example.com" },
        issuer: { O: "DigiCert Inc", CN: "DigiCert G2" },
        valid_from: "Jan 15 00:00:00 2025 GMT",
        valid_to: "Jan 15 23:59:59 2027 GMT",
        subjectaltname: "DNS:example.com, DNS:www.example.com, DNS:m.example.com",
      },
      true,
    );
    connectMock.mockImplementation(() => {
      queueMicrotask(() => sock.emit("secureConnect"));
      return sock;
    });
    const deps = resolveDeps({ ...testDeps({ lookup: fakeLookup({ "example.com": ["93.184.215.14"] }) }), tlsConnect: defaultTlsConnect });
    const r = await checkTls("example.com", { deps });
    expect(r).toEqual({
      host: "example.com",
      issuer: "DigiCert Inc",
      subject: "example.com",
      valid_from: "2025-01-15T00:00:00.000Z",
      valid_to: "2027-01-15T23:59:59.000Z",
      san_count: 3,
      cert_age_days: 365,
      is_new: false,
      expired: false,
      self_signed: false,
      valid: true,
    });
  });

  it("refuses to connect to hosts that resolve privately", async () => {
    const deps = resolveDeps({ ...testDeps({ lookup: fakeLookup({ "intranet.example.com": ["10.0.0.1"] }) }), tlsConnect: defaultTlsConnect });
    await expect(checkTls("intranet.example.com", { deps })).rejects.toThrow(/10\.0\.0\.1/);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("flags expired certificates", () => {
    const r = summarizeTlsPeer("old.test", { authorized: false, authorizationError: "CERT_HAS_EXPIRED", valid_from: "Jan 1 00:00:00 2024 GMT", valid_to: "Jan 1 00:00:00 2025 GMT" }, NOW);
    expect(r).toMatchObject({ expired: true, valid: false, is_new: false });
  });
});
