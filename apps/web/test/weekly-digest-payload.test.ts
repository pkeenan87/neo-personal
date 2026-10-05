// @vitest-environment node
import { ArtifactDecryptError } from "@neo/core";
import { expect, it } from "vitest";
import { decryptDigestPayload, encryptDigestPayload, type DigestPayloadIdentity, type DigestStoredPayload } from "@/lib/server/weekly-digest/payload";

const identity: DigestPayloadIdentity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "owner",
  isoWeek: "2026-W41",
};
const master = Buffer.from(new Uint8Array(32).fill(23)).toString("base64");
const payload: DigestStoredPayload = {
  email: {
    to: "owner@example.test",
    subject: "Your weekly Neo security digest",
    html: "<html>digest</html>",
    text: "digest",
    idempotencyKey: "digest:owner:2026-W41",
    headers: { "List-Unsubscribe": "https://localhost/unsubscribe?token=v1.synthetic" },
  },
  role: "owner",
  deliveryCreatedAt: "2026-10-05T14:00:00.000Z",
};

it("encrypts and decrypts the exact payload with tenant-bound key and digest AAD", () => {
  const encrypted = encryptDigestPayload(payload, identity, { NEO_MASTER_KEY: master });
  expect(encrypted).toBeInstanceOf(Uint8Array);
  expect(Buffer.from(encrypted!).toString("utf8")).not.toContain("owner@example.test");
  expect(decryptDigestPayload(encrypted!, identity, { NEO_MASTER_KEY: master })).toEqual(payload);
});

it("rejects a payload when its digest identity/AAD changes", () => {
  const encrypted = encryptDigestPayload(payload, identity, { NEO_MASTER_KEY: master })!;
  expect(() => decryptDigestPayload(encrypted, { ...identity, isoWeek: "2026-W42" }, { NEO_MASTER_KEY: master })).toThrow(ArtifactDecryptError);
});

it("fails closed without NEO_MASTER_KEY in a deployed environment, even in mock mode", () => {
  expect(encryptDigestPayload(payload, identity, { NODE_ENV: "production", MOCK_MODE: "true" })).toBeUndefined();
});
