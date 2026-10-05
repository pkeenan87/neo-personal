// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createResendMailer, createMockMailer, memorySentEmails, MailerHttpError } from "@/lib/server/email/resend";

it("sends unsubscribe headers in JSON, retains mock headers, and exposes HTTP status", async () => {
  const email = { to: "synthetic@example.test", subject: "Digest", html: "safe", text: "safe", idempotencyKey: "digest:test:2026-W41", headers: { "List-Unsubscribe": "<https://example.test/unsubscribe>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "sent" })));
  await createResendMailer("synthetic", "sender@example.test", fetcher).send(email);
  const init = fetcher.mock.calls[0]![1];
  expect(JSON.parse(init.body).headers).toEqual(email.headers);
  expect(init.headers["Idempotency-Key"]).toBe(email.idempotencyKey);
  await createMockMailer("sender@example.test").send(email);
  expect(memorySentEmails().at(-1)?.headers).toEqual(email.headers);
  fetcher.mockResolvedValue(new Response("failure", { status: 503 }));
  await expect(createResendMailer("synthetic", "sender", fetcher).send(email)).rejects.toMatchObject({ status: 503 });
  expect(new MailerHttpError(400)).toBeInstanceOf(Error);
});
