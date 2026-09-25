"use client";

import { Loader2 } from "lucide-react";
import { stripPlaybookMarker } from "@/lib/playbooks";
import { splitVerdictSegments } from "@/lib/verdict-fence";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { VerdictCard } from "./VerdictCard";

/** Wrap raw text in a fence longer than any backtick run inside it. */
function codeFence(raw: string): string {
  const longest = Math.max(0, ...(raw.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}json\n${raw}\n${fence}`;
}

/**
 * Renders assistant text: Markdown, with every ```verdict fenced block
 * replaced by a <VerdictCard> (convention documented in lib/verdict-fence.ts).
 */
export function MessageContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // The `<!-- playbook:<id> -->` marker is for the server only (agent E).
  const segments = splitVerdictSegments(stripPlaybookMarker(text), { streaming });
  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case "markdown":
            return <MarkdownRenderer key={i} content={seg.text} />;
          case "verdict":
            return <VerdictCard key={i} verdict={seg.verdict} />;
          case "verdict_pending":
            return (
              <div
                key={i}
                className="my-3 flex items-center gap-2 rounded-2xl border border-dashed border-border-strong p-4 text-sm text-muted"
                data-testid="verdict-pending"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Preparing the verdict…
              </div>
            );
          case "verdict_invalid":
            return (
              <div key={i} className="my-3" data-testid="verdict-invalid">
                <p className="mb-1 text-xs text-muted">Neo produced a verdict it couldn&apos;t display. Raw output:</p>
                <MarkdownRenderer content={codeFence(seg.raw)} />
              </div>
            );
        }
      })}
    </>
  );
}
