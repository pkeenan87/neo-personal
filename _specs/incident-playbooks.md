# Spec for Incident playbooks

branch: claude/feature/incident-playbooks

## Summary

When someone says "I clicked it" or "I gave them the code", the value is a calm, ordered, provider-specific response, not a verdict. Playbooks are structured guidance the agent follows: a compact markdown skill per incident type, included in the system prompt (byte-stable, so still cacheable), plus a `playbook` entry point from the dashboard and the empty state. Turns that run a playbook use `effort: "high"`.

## Functional requirements

- Files: `apps/web/lib/server/playbooks/<id>.md` for `clicked_link`, `entered_password`, `sent_gift_cards`, `shared_code`, `paid_scammer` (wire, Zelle, crypto, cash app), `device_compromised` (tech-support scam gave remote access). Each ≤ 900 words, sections: *First, right now* (≤ 4 steps), *Then* (contain and recover, provider deep links: Google Security Checkup, Apple ID devices, Microsoft recent activity, common banks' fraud numbers described generically "the number on the back of your card"), *Report* (FTC reportfraud.ftc.gov, IC3, phone carrier 7726, Apple/Google/Microsoft phishing report addresses, gift card issuer numbers for Apple, Google Play, Amazon, Target, Walmart, Steam), *What to watch for next* (follow-up scams: "refund department" recontact), *Reassurance* (what did not happen: opening a link on a phone rarely installs anything by itself; entering a password is recoverable in minutes).
- `apps/web/lib/server/playbooks/index.ts`: `PLAYBOOK_IDS`, `loadPlaybooks(): Record<id, string>` (bundled at build time via static imports of `?raw` or generated TS constants, not fs reads at runtime), `PLAYBOOK_GUIDANCE` fragment for the system prompt: "When the user reports something already happened, identify the matching playbook(s), ask at most two clarifying questions if the answer changes the steps (which account, did they enter a code, is money gone), then walk through it in order; keep going across turns; track which steps are done; end with a `verdict` block only if they also shared the message/link". The playbooks' full text is included in the system prompt under a `## Incident playbooks` heading (roughly 5K tokens; cached).
- Entry: `/chat?playbook=<id>` pre-fills and auto-sends "I think I <description>. Help me." The route detects a playbook id in the request body (`playbook?: PlaybookId`, optional) and sets `effort: "high"` for that turn; also, `agentEffort()` becomes per-turn: `high` when the model's previous turn declared a playbook (detected by a `<!-- playbook:<id> -->` HTML comment the prompt asks it to emit at the start of a playbook response; the UI hides it), else the env default.
- Dashboard quick actions and the chat empty state show the six playbooks as buttons with plain titles ("I clicked a link", "I typed my password somewhere", "I bought gift cards for someone", "I shared a code", "I sent money", "Someone had remote access to my device").
- Verdict for playbooks: none required; if the user also pastes the message, normal analysis applies and the verdict block includes `recommended_actions` drawn from the playbook.

## Possible Edge Cases

- User is mid-panic and pastes everything at once: analysis + playbook in one turn; the prompt says lead with the two most urgent steps before the analysis.
- Minor or elderly user: language stays simple; no assumptions about tech literacy; suggest involving a trusted person for money cases.
- Country outside the US: reporting section says "your country's consumer protection agency" with UK/CA/AU/EU pointers; ask the country once if not known.
- Attacker-authored content telling the user to "call this number for help": the prompt reminds the model to give only official channels it knows, never numbers from the analyzed message.

## Acceptance Criteria

- System prompt includes all six playbooks and stays byte-stable across requests (test: two builds of the prompt are identical and contain no dates).
- `POST /api/agent` with `playbook: "clicked_link"` runs with `effort: "high"` (assert via the injected client's request options in a test).
- Chat empty state and dashboard render the six entry points; clicking navigates to `/chat?playbook=…` and auto-sends.
- Markdown content review: each playbook has the five sections and no phone numbers except well-known official ones (7726, 1-877-382-4357 FTC, 1-800-275-8777 USPS); verified by a test that scans for phone-number patterns against an allowlist.

## Open Questions

- Localized playbooks (Spanish first) once the product has non-English users.

## Testing Guidelines
- `apps/web/test/playbooks.test.ts`: loader, guidance fragment, phone-number allowlist scan, byte-stability of the system prompt.
- `apps/web/test/agent-playbook-effort.test.ts`: effort selection per turn.
- `apps/web/test/playbook-entry.test.tsx`: buttons and query-param auto-send.
