"use client";

// Lifted from Neo web/components/Toaster (motion dropped for CSS animation).
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useToast, type Toast, type ToastIntent } from "./toast-context";

const ICONS = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle } as const;

const ICON_COLOR: Record<ToastIntent, string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  error: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
  warning: "text-amber-600 dark:text-amber-400",
};

function ToastItem({ toast }: { toast: Toast }) {
  const { dismiss } = useToast();
  const [paused, setPaused] = useState(false);
  const Icon = ICONS[toast.intent];

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [paused, toast.durationMs, toast.id, dismiss]);

  return (
    <div
      role={toast.intent === "error" || toast.intent === "warning" ? "alert" : "status"}
      className="animate-neo-fade-in pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-border bg-surface p-3 shadow-lg"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") dismiss(toast.id);
      }}
    >
      <Icon className={`mt-0.5 size-5 shrink-0 ${ICON_COLOR[toast.intent]}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium">{toast.title}</div>
        {toast.description && <div className="mt-0.5 text-muted">{toast.description}</div>}
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss notification"
        className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function Toaster() {
  const { toasts } = useToast();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-end">
      <div className="flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </div>
    </div>
  );
}
