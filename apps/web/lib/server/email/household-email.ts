/**
 * Household emails (_specs/household-invites.md): the invite, "X joined your
 * household" to the owner, and "you were removed" to a member. Household and
 * person names are user-chosen, so they are cleaned and HTML-escaped like the
 * verdict email; the only link is our own URL.
 */
import { cleanText, escapeHtml, truncate, type RenderedEmail } from "./verdict-email";

const NAME_MAX = 60;
const FOOTER = "Neo is a personal security assistant. If you did not expect this email, you can ignore it.";

function name(s: string | null | undefined, fallback: string): string {
  return truncate(cleanText(s ?? ""), NAME_MAX) || fallback;
}

function safeUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("link must be http(s)");
  return u.toString();
}

function layout(title: string, paragraphs: string[], button?: { href: string; label: string }): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px">',
    '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">',
    `<h1 style="font-size:18px;line-height:1.4;margin:0 0 12px">${escapeHtml(title)}</h1>`,
    ...paragraphs.map((p) => `<p style="font-size:14px;line-height:1.5;margin:0 0 12px">${escapeHtml(p)}</p>`),
    button
      ? `<p style="margin:20px 0 0"><a href="${escapeHtml(safeUrl(button.href))}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600">${escapeHtml(button.label)}</a></p>`
      : "",
    "</div>",
    `<p style="font-size:12px;color:#6b7280;margin:16px 4px 0">${escapeHtml(FOOTER)}</p>`,
    "</div></body></html>",
  ].join("");
}

export function renderInviteEmail(input: { inviterName: string | null; householdName: string; url: string; expiresAt: Date }): RenderedEmail {
  const inviter = name(input.inviterName, "Someone");
  const household = name(input.householdName, "their household");
  const days = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 86_400_000));
  const subject = `${inviter} invited you to ${household} on Neo`;
  const paragraphs = [
    `${inviter} invited you to join ${household} on Neo, a personal security assistant that checks suspicious emails, texts and links.`,
    "As a member, the household owner can see the checks you run. Your chats stay private.",
    "If you already use Neo on your own, joining replaces your current household and deletes its history.",
    `The link works once and expires in ${days} day${days === 1 ? "" : "s"}.`,
  ];
  return {
    subject,
    html: layout(subject, paragraphs, { href: input.url, label: `Join ${household}` }),
    text: [...paragraphs, "", `Join: ${safeUrl(input.url)}`, "", FOOTER].join("\n"),
  };
}

export function renderMemberJoinedEmail(input: { memberName: string | null; householdName: string; url: string }): RenderedEmail {
  const member = name(input.memberName, "A new member");
  const household = name(input.householdName, "your household");
  const subject = `${member} joined ${household}`;
  const paragraphs = [
    `${member} accepted your invite and is now a member of ${household}.`,
    "If you did not expect this, remove them under Settings → Household.",
  ];
  return {
    subject,
    html: layout(subject, paragraphs, { href: input.url, label: "Open household settings" }),
    text: [...paragraphs, "", safeUrl(input.url), "", FOOTER].join("\n"),
  };
}

export function renderMemberRemovedEmail(input: { householdName: string; url: string }): RenderedEmail {
  const household = name(input.householdName, "a household");
  const subject = `You were removed from ${household} on Neo`;
  const paragraphs = [
    `The owner of ${household} removed you from the household. Your chats in it were deleted.`,
    "You can keep using Neo on your own: the next time you sign in you get a household of your own.",
  ];
  return {
    subject,
    html: layout(subject, paragraphs, { href: input.url, label: "Open Neo" }),
    text: [...paragraphs, "", safeUrl(input.url), "", FOOTER].join("\n"),
  };
}
