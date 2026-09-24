"use client";

// Lifted from Neo web/components/CopyButton.
import { AlertCircle, Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "./toast-context";

type Status = "idle" | "copied" | "failed";

export interface CopyButtonProps {
  text: string;
  /** Accessible label for the icon variant. Ignored for variant="text" (visible text is the name). */
  label?: string;
  /** 'icon' shows icons; 'text' shows an icon plus "Copy"/"Copied"/"Copy failed" (or `children`). */
  variant?: "icon" | "text";
  /** Idle text for variant="text". Defaults to "Copy". */
  children?: string;
  className?: string;
}

const REVERT_MS = 2000;

function execCommandFallback(text: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.setAttribute("aria-hidden", "true");
    ta.setAttribute("tabindex", "-1");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return execCommandFallback(text);
    }
  }
  return execCommandFallback(text);
}

export function CopyButton({ text, label, variant = "icon", children, className }: CopyButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyText(text);
    setStatus(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), REVERT_MS);
    toast(ok ? { intent: "success", title: "Copied to clipboard" } : { intent: "error", title: "Copy failed" });
  }, [text, toast]);

  const Icon = status === "copied" ? Check : status === "failed" ? AlertCircle : Copy;
  const base =
    "inline-flex items-center gap-1.5 rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50";

  if (variant === "text") {
    return (
      <button type="button" onClick={handleCopy} className={`${base} px-2 py-1 text-xs font-medium ${className ?? ""}`}>
        <Icon className="size-3.5" aria-hidden="true" />
        {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : (children ?? "Copy")}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label ?? "Copy to clipboard"}
      className={`${base} p-1.5 ${className ?? ""}`}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}
