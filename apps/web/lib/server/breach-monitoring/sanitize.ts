import { cleanText, truncate } from "../email/verdict-email";

const EMAIL_LIKE = /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{0,253}/giu;

function plainText(value: string): string {
  return cleanText(value).replace(/<[^>]*>/g, " ").replace(/[<>]/g, " ").replace(EMAIL_LIKE, "[redacted address]").replace(/\s+/g, " ").trim();
}

export function sanitizeBreachName(value: string): string {
  return truncate(plainText(value), 120) || "Unknown breach";
}

export function sanitizeBreachDataClass(value: string): string {
  return truncate(plainText(value), 100);
}
