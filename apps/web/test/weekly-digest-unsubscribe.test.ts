// @vitest-environment node
import { expect, it } from "vitest";
import { signDigestUnsubscribe, verifyDigestUnsubscribe } from "@/lib/server/weekly-digest/unsubscribe";
import { WEEKLY_DIGEST_OTHER_TEST_SECRET } from "./fixtures/weekly-digest";
it("signs versioned purpose-bound owner tokens, rejects tampering and fails closed on deployments", () => {
  const owner = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "user-a" };
  const source = { MOCK_MODE: "true" };
  const token = signDigestUnsubscribe(owner, source)!;
  expect(token).toMatch(/^v1\./);
  expect(verifyDigestUnsubscribe(token, source)).toEqual(owner);
  expect(verifyDigestUnsubscribe(token.replace("v1.", "v2."), source)).toBeUndefined();
  const parts = token.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...owner, userId: "user-b" })).toString("base64url");
  expect(verifyDigestUnsubscribe(parts.join("."), source)).toBeUndefined();
  expect(verifyDigestUnsubscribe(token, { AUTH_SECRET: WEEKLY_DIGEST_OTHER_TEST_SECRET })).toBeUndefined();
  expect(signDigestUnsubscribe(owner, { NODE_ENV: "production", MOCK_MODE: "true" })).toBeUndefined();
  expect(verifyDigestUnsubscribe(token, { NODE_ENV: "production" })).toBeUndefined();
  expect(verifyDigestUnsubscribe("v1.bad.bad", source)).toBeUndefined();
});
