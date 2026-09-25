// @vitest-environment node
import type { Verdict } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_MAX,
  FOOTER_TEXT,
  cleanText,
  escapeHtml,
  overCapVerdict,
  renderNoticeEmail,
  renderVerdictEmail,
  truncate,
} from "@/lib/server/email/verdict-email";
import { VERDICT_FIXTURE } from "./fixtures";

const DETAIL = "https://neo.example.test/verdicts/11111111-2222-4333-8444-555555555555";

const HOSTILE: Verdict = {
  ...VERDICT_FIXTURE,
  subject_type: "email",
  verdict: "malicious",
  headline: `<script>alert("x")</script> Fake "bank" & <b>login</b>`,
  indicators: [
    { severity: "low", category: "Low one", evidence: "low", explanation: "low" },
    { severity: "critical", category: "<img src=x onerror=alert(1)>", evidence: "E".repeat(500), explanation: "x" },
    { severity: "high", category: "High", evidence: `<a href="https://evil.example">click</a>`, explanation: "y" },
    { severity: "medium", category: "Medium", evidence: "m", explanation: "z" },
  ],
  recommended_actions: [
    { action: "Delete it <now>", urgency: "now", deep_link: "javascript:alert(1)" },
    { action: "Report it", urgency: "soon", deep_link: "https://evil.example/report" },
  ],
};

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
}

describe("renderVerdictEmail", () => {
  it("escapes every untrusted string and never emits markup from the verdict", () => {
    const { html } = renderVerdictEmail(HOSTILE, { detailUrl: DETAIL, forwardedSubject: `Fwd: <i>Urgent</i> "invoice"` });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>login");
    expect(html).not.toContain('<a href="https://evil.example"');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Fwd: &lt;i&gt;Urgent&lt;/i&gt; &quot;invoice&quot;");
    expect(html).toContain("Delete it &lt;now&gt;");
  });

  it("links only to our verdict page (no deep links from the model)", () => {
    const { html, text } = renderVerdictEmail(HOSTILE, { detailUrl: DETAIL, forwardedSubject: "x" });
    expect(hrefs(html)).toEqual([DETAIL]);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example/report");
    expect(text).toContain(`See the full analysis: ${DETAIL}`);
    expect(text).not.toContain("evil.example/report");
  });

  it("subject: label and forwarded subject truncated to 60 characters, control characters stripped", () => {
    const long = "A".repeat(80);
    const { subject } = renderVerdictEmail(HOSTILE, { detailUrl: DETAIL, forwardedSubject: `${long}\r\nBcc: x@evil.example` });
    expect(subject.startsWith('Neo: Malicious — "')).toBe(true);
    expect(subject).not.toMatch(/[\r\n]/);
    const quoted = /"(.*)"$/.exec(subject)![1]!;
    expect([...quoted]).toHaveLength(60);
    expect(quoted.endsWith("…")).toBe(true);
  });

  it("shows the top 3 indicators by severity with evidence capped at 200 characters", () => {
    const { html, text } = renderVerdictEmail(HOSTILE, { detailUrl: DETAIL, forwardedSubject: "x" });
    expect(text).not.toContain("Low one");
    const iCritical = text.indexOf("(critical)");
    const iHigh = text.indexOf("High (high)");
    const iMedium = text.indexOf("Medium (medium)");
    expect(iCritical).toBeGreaterThan(-1);
    expect(iCritical).toBeLessThan(iHigh);
    expect(iHigh).toBeLessThan(iMedium);
    expect(html).toContain("E".repeat(EVIDENCE_MAX - 1) + "…");
    expect(html).not.toContain("E".repeat(EVIDENCE_MAX));
  });

  it("labels, footer and a missing subject", () => {
    const safe = renderVerdictEmail({ ...VERDICT_FIXTURE, verdict: "likely_safe" }, { detailUrl: DETAIL });
    expect(safe.subject).toBe('Neo: Likely safe — "(no subject)"');
    expect(safe.html).toContain(escapeHtml(FOOTER_TEXT));
    expect(safe.text.endsWith(FOOTER_TEXT)).toBe(true);
    expect(renderVerdictEmail({ ...VERDICT_FIXTURE, verdict: "insufficient_evidence" }, { detailUrl: DETAIL }).subject).toContain(
      "Not enough evidence",
    );
  });

  it("usage note only under 20% remaining", () => {
    expect(renderVerdictEmail(HOSTILE, { detailUrl: DETAIL, usage: { remaining: 9, limit: 50 } }).text).toContain("9 of 50 checks left");
    expect(renderVerdictEmail(HOSTILE, { detailUrl: DETAIL, usage: { remaining: 10, limit: 50 } }).text).not.toContain("checks left");
  });

  it("rejects a non-http detail URL", () => {
    expect(() => renderVerdictEmail(HOSTILE, { detailUrl: "javascript:alert(1)" })).toThrow();
  });
});

describe("notice emails and helpers", () => {
  it("too_large mentions the paste/upload alternative and escapes the subject", () => {
    const e = renderNoticeEmail("too_large", { appUrl: "https://neo.example.test", forwardedSubject: "<b>hi</b>" });
    expect(e.subject).toBe('Neo: could not analyze — "<b>hi</b>"'); // subject is plain text (not HTML)
    expect(e.html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(e.text).toMatch(/paste the text or upload/);
    expect(hrefs(e.html)).toEqual(["https://neo.example.test/"]);
  });

  it("over-cap verdict names the reset date", () => {
    const v = overCapVerdict(new Date("2026-10-01T00:00:00Z"));
    expect(v.headline).toBe("Not analyzed: your household reached its monthly limit");
    expect(v.recommended_actions[0]!.action).toContain("October 1");
  });

  it("truncate and cleanText", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcd", 3)).toBe("ab…");
    expect(truncate("😀😀😀😀", 3)).toBe("😀😀…");
    expect(cleanText("a‮b\r\n\tc\u0000")).toBe("a b c");
  });
});
