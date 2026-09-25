/**
 * Incident playbook ids, titles and entry prompts (_specs/incident-playbooks.md).
 * Client-safe: no playbook text here (that lives in lib/server/playbooks and
 * only enters the system prompt).
 */

export const PLAYBOOK_IDS = [
  "clicked_link",
  "entered_password",
  "sent_gift_cards",
  "shared_code",
  "paid_scammer",
  "device_compromised",
] as const;

export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

export function isPlaybookId(v: unknown): v is PlaybookId {
  return typeof v === "string" && (PLAYBOOK_IDS as readonly string[]).includes(v);
}

export interface PlaybookEntry {
  id: PlaybookId;
  /** Button label. */
  title: string;
  /** Completes "I think I …. Help me." */
  description: string;
}

export const PLAYBOOK_ENTRIES: readonly PlaybookEntry[] = [
  { id: "clicked_link", title: "I clicked a link", description: "clicked a link in a suspicious message" },
  { id: "entered_password", title: "I typed my password somewhere", description: "typed my password into a site that might be fake" },
  { id: "sent_gift_cards", title: "I bought gift cards for someone", description: "bought gift cards for someone who might be a scammer" },
  { id: "shared_code", title: "I shared a code", description: "shared a verification code with someone I shouldn't have" },
  { id: "paid_scammer", title: "I sent money", description: "sent money to someone who might be a scammer" },
  {
    id: "device_compromised",
    title: "Someone had remote access to my device",
    description: "let someone take remote control of my computer or phone",
  },
];

/** The message sent for a playbook entry point. */
export function playbookPrompt(id: PlaybookId): string {
  const entry = PLAYBOOK_ENTRIES.find((e) => e.id === id);
  return `I think I ${entry?.description ?? id.replace(/_/g, " ")}. Help me.`;
}

/**
 * The model starts a playbook response with `<!-- playbook:<id> -->` (see the
 * system prompt). The UI hides it; the server uses it to keep effort high on
 * the next turn.
 */
export const PLAYBOOK_MARKER_RE = /^\s*<!--\s*playbook:([a-z_]+)\s*-->[ \t]*\n?/;

/** The playbook id declared at the start of `text`, if any. */
export function playbookMarker(text: string): PlaybookId | null {
  const m = PLAYBOOK_MARKER_RE.exec(text);
  return m && isPlaybookId(m[1]) ? m[1] : null;
}

/** Remove a leading playbook marker for display (also a marker still streaming in). */
export function stripPlaybookMarker(text: string): string {
  if (PLAYBOOK_MARKER_RE.test(text)) return text.replace(PLAYBOOK_MARKER_RE, "");
  const head = text.trimStart();
  if (head.length < 40 && "<!-- playbook:".startsWith(head.slice(0, 14)) && head.startsWith("<!--") && !head.includes("-->")) return "";
  return text;
}
