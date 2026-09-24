"use client";

// Lifted from the tool-trace accordion in Neo ChatInterface.tsx.
import { AlertCircle, CheckCircle2, ChevronRight, Loader2, Wrench } from "lucide-react";
import type { ToolTrace as ToolTraceModel } from "@/lib/chat-state";

/** Friendly names for known tools; unknown tools show their raw name. */
const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  check_url: { running: "Checking the link…", done: "Checked the link" },
  report_phish: { running: "Reporting…", done: "Reported" },
};

export function toolLabel(name: string, status: ToolTraceModel["status"]): string {
  const l = TOOL_LABELS[name];
  if (!l) return status === "running" ? `Running ${name}…` : name;
  return status === "running" ? l.running : l.done;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(2)}s` : `${Math.round(s)}s`;
}

const TRACE_CHAR_CAP = 100_000;

function looksLikeJson(s: string): boolean {
  const c = s.trimStart()[0];
  return c === "{" || c === "[";
}

/** Pretty-print a tool input/result for display, capped so a huge payload can't bloat the DOM. */
export function safeStringify(value: unknown): string {
  let out: string;
  if (value === undefined) return "—";
  if (typeof value === "string") {
    out = value;
    if (looksLikeJson(value)) {
      try {
        out = JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        // not JSON after all
      }
    }
  } else {
    try {
      out = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      out = String(value);
    }
  }
  return out.length > TRACE_CHAR_CAP
    ? `${out.slice(0, TRACE_CHAR_CAP)}\n\n… (truncated — ${out.length - TRACE_CHAR_CAP} chars omitted)`
    : out;
}

export function ToolTrace({ trace }: { trace: ToolTraceModel }) {
  const label = toolLabel(trace.name, trace.status);
  const StatusIcon = trace.status === "running" ? Loader2 : trace.status === "error" ? AlertCircle : CheckCircle2;
  const iconColor =
    trace.status === "running"
      ? "animate-spin text-muted"
      : trace.status === "error"
        ? "text-red-600 dark:text-red-400"
        : "text-emerald-600 dark:text-emerald-400";
  const aria = [label, trace.durationMs !== undefined ? formatDuration(trace.durationMs) : null, trace.status === "error" ? "failed" : null]
    .filter(Boolean)
    .join(", ");

  return (
    <details
      className="group my-2 rounded-xl border border-border bg-surface-2/60 text-sm"
      data-testid="tool-trace"
      data-tool={trace.name}
      data-status={trace.status}
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 select-none hover:bg-surface-2 [&::-webkit-details-marker]:hidden"
        aria-label={aria}
      >
        <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden="true" />
        <Wrench className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {trace.durationMs !== undefined && (
          <span className="shrink-0 text-xs text-muted tabular-nums" aria-hidden="true">
            {formatDuration(trace.durationMs)}
          </span>
        )}
        <StatusIcon className={`size-4 shrink-0 ${iconColor}`} aria-hidden="true" />
      </summary>
      {/* aria-live="off" keeps an expanded JSON body out of the chat log live region. */}
      <div className="space-y-2 border-t border-border px-3 py-2" aria-live="off">
        <div className="text-xs text-muted">
          Tool <code className="font-mono">{trace.name}</code>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold text-muted">Input</div>
          <pre
            className="max-h-64 overflow-auto rounded-lg bg-surface p-2 font-mono text-xs leading-relaxed"
            tabIndex={0}
            aria-label={`${trace.name} input`}
          >
            {safeStringify(trace.input)}
          </pre>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold text-muted">Result</div>
          <pre
            className="max-h-80 overflow-auto rounded-lg bg-surface p-2 font-mono text-xs leading-relaxed"
            tabIndex={0}
            aria-label={`${trace.name} result`}
          >
            {trace.status === "running" ? "Waiting for result…" : safeStringify(trace.result)}
          </pre>
        </div>
      </div>
    </details>
  );
}
