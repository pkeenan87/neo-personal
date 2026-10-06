import { describe, expect, it, vi } from "vitest";
import { createBreachVerificationEmail, deliverBreachVerificationEmail } from "@/lib/server/breach-monitoring/email";

const input = {
  to: "extra@example.com",
  verificationUrl: "https://neo.example.test/settings/breaches/verify?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  idempotencyKey: "breach-verification-test-id",
};

describe("breach verification email", () => {
  it("sends a minimal confirmation link with no address in the message content", async () => {
    const send = vi.fn(async () => ({ id: "email-id" }));
    const mailer = { send };
    const message = createBreachVerificationEmail(input);
    expect(message.subject).toBe("Confirm a breach-monitoring address");
    expect(message.html).toContain(input.verificationUrl);
    expect(message.text).toContain(input.verificationUrl);
    expect(message.text).toContain("24 hours");
    expect(message.html).not.toContain(input.to);
    await deliverBreachVerificationEmail(mailer, input);
    expect(send).toHaveBeenCalledWith({ to: input.to, ...message, idempotencyKey: input.idempotencyKey });
  });

  it("fails closed when email delivery is not configured", async () => {
    await expect(deliverBreachVerificationEmail(null, input)).rejects.toThrow("mail is not configured");
  });
});
