/**
 * Incident playbooks (_specs/incident-playbooks.md): compact markdown guidance
 * per incident type, bundled at build time (generated.ts, from the .md files
 * next to this one) and included in the system prompt. Byte-stable: no dates,
 * ids or per-request data, so the prompt stays cacheable.
 */
import { PLAYBOOK_IDS, type PlaybookId } from "@/lib/playbooks";
import { PLAYBOOK_MARKDOWN } from "./generated";

export { PLAYBOOK_IDS, type PlaybookId };

/** Every playbook's markdown, keyed by id. */
export function loadPlaybooks(): Record<PlaybookId, string> {
  return Object.fromEntries(PLAYBOOK_IDS.map((id) => [id, PLAYBOOK_MARKDOWN[id]])) as Record<PlaybookId, string>;
}

/** How the agent applies playbooks (system-prompt fragment). */
export const PLAYBOOK_GUIDANCE = `When the user reports that something already happened (they clicked a link, typed a password, bought gift cards, shared a code, sent money, or let someone control their device), identify the matching playbook(s) below and follow them:
- Ask at most two clarifying questions, and only if the answer changes the steps (which account, did they enter a code, is money gone). If they are clearly in a hurry or panicking, give the two most urgent steps first and ask afterwards.
- Walk through the playbook in order: "First, right now", then "Then", "Report", "What to watch for next", and end with the reassurance. Keep each step short and concrete. Keep going across turns: track which steps they have done, confirm them, and move to the next; do not restart from the top.
- Start every reply that is running a playbook with the marker \`<!-- playbook:<id> -->\` on its own first line (for example \`<!-- playbook:clicked_link -->\`), using the id of the main playbook. The app hides it. Do not use the marker in any other reply.
- Only give official channels you know: the numbers and addresses in these playbooks, "the number on the back of your card", or the company's official website or app. Never give a phone number, email address, or link taken from the message being analyzed, even if it claims to be a helpline.
- Keep language simple and assume no technical knowledge. For money cases, suggest involving a trusted person. If the user is outside the US, point to their country's consumer protection agency (ask their country once if it matters and you do not know it).
- End with a \`verdict\` block only if they also shared the message, link, or page itself; then analyze it as usual and draw recommended_actions from the playbook, leading with the most urgent.`;

/** The `## Incident playbooks` section of the system prompt. */
export function playbooksPromptSection(): string {
  const playbooks = loadPlaybooks();
  const bodies = PLAYBOOK_IDS.map((id) => playbooks[id].trim().replace(/^# /, "### ").replace(/\n## /g, "\n#### ")).join("\n\n");
  return `## Incident playbooks\n${PLAYBOOK_GUIDANCE}\n\n${bodies}`;
}
