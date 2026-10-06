import type { OutgoingEmail, Mailer } from "../email/resend";
import type { BreachVerificationEmail } from "./address-service";

const SUBJECT = "Confirm a breach-monitoring address";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function trustedVerificationUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error("verification URL must use HTTPS");
  }
  if (!url.pathname.startsWith("/settings/breaches/verify") || !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("token") ?? "")) {
    throw new Error("verification URL is invalid");
  }
  return url.toString();
}

export function createBreachVerificationEmail(input: Pick<BreachVerificationEmail, "verificationUrl">): Pick<OutgoingEmail, "subject" | "html" | "text"> {
  const url = trustedVerificationUrl(input.verificationUrl);
  const href = escapeHtml(url);
  return {
    subject: SUBJECT,
    html: `<p>Someone requested monitoring for this email address in Neo.</p><p><a href="${href}">Confirm this address</a></p><p>The link expires in 24 hours and works only when you are signed in to the same Neo account that requested it.</p><p>If you did not make this request, ignore this email.</p>`,
    text: `Someone requested monitoring for this email address in Neo.\n\nConfirm this address: ${url}\n\nThe link expires in 24 hours and works only when you are signed in to the same Neo account that requested it. If you did not make this request, ignore this email.`,
  };
}

export async function deliverBreachVerificationEmail(mailer: Mailer | null, input: BreachVerificationEmail): Promise<void> {
  if (!mailer) throw new Error("mail is not configured");
  const message = createBreachVerificationEmail(input);
  await mailer.send({ to: input.to, ...message, idempotencyKey: input.idempotencyKey });
}
