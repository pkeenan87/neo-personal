// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PLAYBOOK_ENTRIES, playbookMarker, playbookPrompt, stripPlaybookMarker } from "@/lib/playbooks";
import { PLAYBOOK_GUIDANCE, PLAYBOOK_IDS, loadPlaybooks } from "@/lib/server/playbooks";
import { PLAYBOOK_MARKDOWN } from "@/lib/server/playbooks/generated";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../lib/server/playbooks");
const SECTIONS = ["First, right now", "Then", "Report", "What to watch for next", "Reassurance"];

/** Official numbers the playbooks may contain (_specs/incident-playbooks.md), as digits. */
const PHONE_ALLOWLIST = new Set(["7726", "18773824357", "18002758777"]);

/** Every phone-number-like run: 7+ digits with optional separators, or a bare 4–6 digit short code. */
function phoneLike(text: string): string[] {
  const long = [...text.matchAll(/\+?\d[\d\s().-]{5,}\d/g)].map((m) => m[0].replace(/\D/g, "")).filter((d) => d.length >= 7);
  const short = [...text.matchAll(/(?<![\w./-])\d{4,6}(?![\w/-])/g)].map((m) => m[0]);
  return [...long, ...short];
}

describe("incident playbooks", () => {
  const playbooks = loadPlaybooks();

  it("loads all six playbooks, in sync with the markdown sources", () => {
    expect([...PLAYBOOK_IDS].sort()).toEqual(Object.keys(PLAYBOOK_MARKDOWN).sort());
    expect(PLAYBOOK_ENTRIES.map((e) => e.id)).toEqual([...PLAYBOOK_IDS]);
    for (const id of PLAYBOOK_IDS) {
      const source = readFileSync(path.join(dir, `${id}.md`), "utf8").replace(/\r\n?/g, "\n").trimEnd() + "\n";
      // Run `pnpm --filter @neo/web playbooks:generate` after editing a playbook.
      expect(playbooks[id], `${id}: generated.ts is stale`).toBe(source);
    }
  });

  it.each(PLAYBOOK_IDS)("%s has the five sections in order and at most 900 words", (id) => {
    const md = playbooks[id];
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(SECTIONS);
    expect(md.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(900);
    const firstSteps = md.split("## First, right now")[1]!.split("\n## ")[0]!;
    expect(firstSteps.match(/^\d+\. /gm)?.length ?? 0).toBeLessThanOrEqual(4);
  });

  it.each(PLAYBOOK_IDS)("%s contains no phone numbers outside the allowlist", (id) => {
    const found = phoneLike(playbooks[id]);
    expect(found.filter((d) => !PHONE_ALLOWLIST.has(d))).toEqual([]);
  });

  it("the phone scan catches unlisted numbers", () => {
    expect(phoneLike("Call Apple at 1-800-692-7753 or (555) 010-1234 or text 12345.")).toEqual(["18006927753", "5550101234", "12345"]);
    expect(phoneLike("Forward it to 7726 or call 1-877-382-4357.").every((d) => PHONE_ALLOWLIST.has(d))).toBe(true);
  });

  it("guidance covers the clarifying-question limit, the marker, and official channels only", () => {
    expect(PLAYBOOK_GUIDANCE).toContain("at most two clarifying questions");
    expect(PLAYBOOK_GUIDANCE).toContain("<!-- playbook:<id> -->");
    expect(PLAYBOOK_GUIDANCE).toMatch(/Never give a phone number, email address, or link taken from the message/);
  });

  it("entry prompts and the marker helpers", () => {
    expect(playbookPrompt("clicked_link")).toBe("I think I clicked a link in a suspicious message. Help me.");
    expect(playbookMarker("<!-- playbook:entered_password -->\nChange it now.")).toBe("entered_password");
    expect(playbookMarker("<!-- playbook:nope -->\n")).toBeNull();
    expect(stripPlaybookMarker("<!-- playbook:entered_password -->\nChange it now.")).toBe("Change it now.");
    expect(stripPlaybookMarker("<!-- playbook:entered_pa")).toBe(""); // still streaming
    expect(stripPlaybookMarker("Hello <!-- playbook:x -->")).toBe("Hello <!-- playbook:x -->");
  });
});

describe("system prompt", () => {
  it("includes every playbook under ## Incident playbooks and is byte-stable with no dates", async () => {
    const a = (await import("@/lib/server/system-prompt")).NEO_SYSTEM_PROMPT;
    vi.resetModules();
    const b = (await import("@/lib/server/system-prompt")).NEO_SYSTEM_PROMPT;
    expect(b).toBe(a);
    const section = a.slice(a.indexOf("## Incident playbooks"));
    expect(a.indexOf("## Incident playbooks")).toBeGreaterThan(0);
    expect(section).toContain(PLAYBOOK_GUIDANCE);
    for (const id of PLAYBOOK_IDS) expect(section).toContain(`### Playbook: ${id}`);
    expect(a).not.toMatch(/\b(19|20)\d\d-\d\d-\d\d\b/);
    expect(a).not.toMatch(/\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}\b/);
  });
});
