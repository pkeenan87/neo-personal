// @vitest-environment node
import { createHash } from "node:crypto";
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as artifactGET } from "@/app/api/artifacts/[id]/route";
import { POST as uploadPOST } from "@/app/api/artifacts/route";
import { GET as healthGET } from "@/app/api/health/route";
import type { ArtifactUploadResponse } from "@/lib/api-types";
import { detectArtifactType, looksLikeEmail, takeUploadSlots } from "@/lib/server/artifacts";
import { EML, file, GIF_HEAD, HEIC_HEAD, JPEG_HEAD, PNG_1X1, uploadRequest, WEBP_HEAD } from "./helpers/artifacts";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT_B = { userId: "user-b", tenantId: "00000000-0000-4000-8000-0000000000bb", role: "owner" as const };

function signInAsTenantB(): void {
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  authState.session = { ...TENANT_B, user: { email: "b@example.test", name: "B" }, expires: "2099-01-01T00:00:00Z" };
}

function get(id: string, query = ""): Promise<Response> {
  return artifactGET(new Request(`http://localhost/api/artifacts/${id}${query}`), { params: Promise.resolve({ id }) });
}

async function upload(files: File[]): Promise<ArtifactUploadResponse> {
  const res = await uploadPOST(uploadRequest(files));
  expect(res.status).toBe(200);
  return (await res.json()) as ArtifactUploadResponse;
}

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  authState.session = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("type detection", () => {
  it.each([
    [PNG_1X1, "shot.png", "image/png", "image/png"],
    [JPEG_HEAD, "shot.jpg", "image/jpeg", "image/jpeg"],
    [GIF_HEAD, "shot.gif", "image/gif", "image/gif"],
    [WEBP_HEAD, "shot.webp", "image/webp", "image/webp"],
    [PNG_1X1, "shot.jpg", "image/jpeg", "image/png"], // stored type is the detected one
    [PNG_1X1, "clipboard", "", "image/png"],
  ])("detects images by magic bytes (%#)", (bytes, name, declared, expected) => {
    const name2 = name === "clipboard" ? "image.png" : name;
    expect(detectArtifactType(bytes, declared, name2)).toEqual({ ok: true, kind: "image", mimeType: expected });
  });

  it("accepts .eml and text by content", () => {
    expect(detectArtifactType(EML, "message/rfc822", "a.eml")).toMatchObject({ ok: true, kind: "eml" });
    expect(detectArtifactType(EML, "", "a.eml")).toMatchObject({ ok: true, kind: "eml" });
    expect(detectArtifactType(new TextEncoder().encode("hello"), "text/plain", "a.txt")).toMatchObject({ ok: true, kind: "text" });
  });

  it("rejects mismatches, binaries and HEIC", () => {
    expect(detectArtifactType(new TextEncoder().encode("not an image"), "image/png", "a.png")).toEqual({ ok: false, reason: "unsupported_type" });
    expect(detectArtifactType(PNG_1X1, "message/rfc822", "a.eml")).toEqual({ ok: false, reason: "unsupported_type" });
    expect(detectArtifactType(PNG_1X1, "text/plain", "a.txt")).toEqual({ ok: false, reason: "unsupported_type" });
    expect(detectArtifactType(new TextEncoder().encode("just some prose"), "message/rfc822", "a.eml")).toEqual({ ok: false, reason: "unsupported_type" });
    expect(detectArtifactType(Uint8Array.from([0x4d, 0x5a, 0x90, 0]), "application/octet-stream", "a.exe")).toEqual({ ok: false, reason: "unsupported_type" });
    expect(detectArtifactType(Uint8Array.from([0xff, 0xfe, 0x41]), "text/plain", "a.txt")).toEqual({ ok: false, reason: "unsupported_type" });
    expect(detectArtifactType(HEIC_HEAD, "image/heic", "IMG_0001.HEIC")).toEqual({ ok: false, reason: "heic" });
    expect(detectArtifactType(HEIC_HEAD, "image/png", "renamed.png")).toEqual({ ok: false, reason: "heic" });
  });

  it("recognises RFC 5322 header blocks, including folded headers and an mbox From line", () => {
    expect(looksLikeEmail("From x@y Mon Sep 1\nFrom: a@b.neo.test\nSubject: hi\n  folded\n\nbody")).toBe(true);
    expect(looksLikeEmail("Subject: only one header\n\nbody")).toBe(false);
  });
});

describe("POST /api/artifacts", () => {
  it("returns 401 without a session", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    expect((await uploadPOST(uploadRequest([file(PNG_1X1, "a.png", "image/png")]))).status).toBe(401);
  });

  it("stores several files and returns their metadata in order", async () => {
    const body = await upload([
      file(PNG_1X1, "screen shot.png", "image/png"),
      file(EML, "phish.eml", "message/rfc822"),
      file(new TextEncoder().encode("Your parcel is waiting"), "sms.txt", "text/plain"),
    ]);
    expect(body.artifacts.map((a) => [a.kind, a.mimeType, a.filename])).toEqual([
      ["image", "image/png", "screen shot.png"],
      ["eml", "message/rfc822", "phish.eml"],
      ["text", "text/plain", "sms.txt"],
    ]);
    expect(body.artifacts[0]).toMatchObject({
      sizeBytes: PNG_1X1.byteLength,
      sha256: createHash("sha256").update(PNG_1X1).digest("hex"),
    });
    for (const a of body.artifacts) expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sanitizes file names", async () => {
    const body = await upload([file(PNG_1X1, 'evil"]\u202e[gnp.png', "image/png")]);
    expect(body.artifacts[0]!.filename).toBe("evil')(gnp.png");
  });

  it("returns 415 when the content does not match an accepted type, and stores nothing", async () => {
    const res = await uploadPOST(uploadRequest([file(PNG_1X1, "ok.png", "image/png"), file(new TextEncoder().encode("MZ"), "x.png", "image/png")]));
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ code: "unsupported_type" });
    const heic = await uploadPOST(uploadRequest([file(HEIC_HEAD, "IMG_0001.heic", "image/heic")]));
    expect(heic.status).toBe(415);
    expect(((await heic.json()) as { error: string }).error).toMatch(/HEIC/);
  });

  it("enforces per-kind and per-request size limits", async () => {
    const bigPng = new Uint8Array(3 * 1024 * 1024 + 1);
    bigPng.set(PNG_1X1);
    const res = await uploadPOST(uploadRequest([file(bigPng, "big.png", "image/png")]));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "too_large" });

    const bigEml = new Uint8Array(2 * 1024 * 1024 + 10).fill(0x61);
    bigEml.set(EML);
    const eml = await uploadPOST(uploadRequest([file(bigEml, "big.eml", "message/rfc822")]));
    expect(eml.status).toBe(413);
    expect(((await eml.json()) as { error: string }).error).toMatch(/forward it to your Neo address/);

    const bigText = new Uint8Array(512 * 1024 + 1).fill(0x61);
    expect((await uploadPOST(uploadRequest([file(bigText, "a.txt", "text/plain")]))).status).toBe(413);

    const declared = await uploadPOST(uploadRequest([file(PNG_1X1, "a.png", "image/png")], { "content-length": String(10 * 1024 * 1024) }));
    expect(declared.status).toBe(413);

    const half = new Uint8Array(1.5 * 1024 * 1024).fill(0x61);
    half.set(EML);
    const total = await uploadPOST(uploadRequest([1, 2, 3].map((i) => file(half, `m${i}.eml`, "message/rfc822"))));
    expect(total.status).toBe(413);
  });

  it("rejects non-multipart bodies, empty uploads and more than 4 files", async () => {
    const json = new Request("http://localhost/api/artifacts", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect((await uploadPOST(json)).status).toBe(400);
    const empty = new FormData();
    empty.append("other", "x");
    expect((await uploadPOST(new Request("http://localhost/api/artifacts", { method: "POST", body: empty }))).status).toBe(400);
    const five = [1, 2, 3, 4, 5].map((i) => file(PNG_1X1, `${i}.png`, "image/png"));
    expect((await uploadPOST(uploadRequest(five))).status).toBe(400);
  });

  it("rate-limits uploads per tenant (30 per hour) with Retry-After", async () => {
    for (let i = 0; i < 7; i++) await upload([1, 2, 3, 4].map((n) => file(PNG_1X1, `${i}-${n}.png`, "image/png")));
    await upload([file(PNG_1X1, "29.png", "image/png"), file(PNG_1X1, "30.png", "image/png")]);
    const res = await uploadPOST(uploadRequest([file(PNG_1X1, "31.png", "image/png")]));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limited" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);

    // Another tenant is unaffected.
    signInAsTenantB();
    expect((await uploadPOST(uploadRequest([file(PNG_1X1, "b.png", "image/png")]))).status).toBe(200);
  });

  it("frees rate-limit slots after an hour", () => {
    const t0 = 1_000_000;
    expect(takeUploadSlots("t-window", 30, t0)).toEqual({ ok: true });
    expect(takeUploadSlots("t-window", 1, t0 + 1000)).toMatchObject({ ok: false });
    expect(takeUploadSlots("t-window", 1, t0 + 60 * 60 * 1000 + 1)).toEqual({ ok: true });
  });

  it("returns 503 storage_unavailable when production has no NEO_MASTER_KEY, and health says unconfigured", async () => {
    signInAsTenantB();
    vi.stubEnv("VERCEL_ENV", "production");
    const res = await uploadPOST(uploadRequest([file(PNG_1X1, "a.png", "image/png")]));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "storage_unavailable" });
    expect(await healthGET().json()).toMatchObject({ artifacts: "unconfigured" });
  });

  it("health reports memory with no Blob token and ok with Blob token + key", async () => {
    expect(await healthGET().json()).toMatchObject({ artifacts: "memory" });
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic-test-value");
    vi.stubEnv("NEO_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    expect(await healthGET().json()).toMatchObject({ artifacts: "ok" });
  });
});

describe("GET /api/artifacts/[id]", () => {
  it("downloads the bytes as an attachment with no-store and nosniff", async () => {
    const [eml] = (await upload([file(EML, "phish.eml", "message/rfc822")])).artifacts;
    const res = await get(eml!.id);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(EML);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="phish.eml"/);
    expect(res.headers.get("content-type")).toBe("message/rfc822");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");

    // inline is only for images
    expect((await get(eml!.id, "?inline=1")).headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("serves images inline with the stored image type when asked", async () => {
    const [png] = (await upload([file(PNG_1X1, "shot.png", "image/png")])).artifacts;
    const res = await get(png!.id, "?inline=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="shot.png"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_1X1);
  });

  it("returns 404 for another tenant's artifact, unknown ids and malformed ids", async () => {
    const [png] = (await upload([file(PNG_1X1, "shot.png", "image/png")])).artifacts;
    signInAsTenantB();
    expect((await get(png!.id)).status).toBe(404);
    expect((await get("00000000-0000-4000-8000-000000000999")).status).toBe(404);
    expect((await get("../../etc/passwd")).status).toBe(404);
  });

  it("returns 401 without a session", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    expect((await get("00000000-0000-4000-8000-000000000999")).status).toBe(401);
  });
});
