"use client";

// Lifted from Neo web/context/ToastContext.tsx.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ToastIntent = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  intent: ToastIntent;
  title: string;
  description?: string;
  durationMs: number;
}

export interface ToastInput {
  intent?: ToastIntent;
  title: string;
  description?: string;
  durationMs?: number;
}

interface ToastContextValue {
  toasts: Toast[];
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput): string => {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [
      ...prev.slice(-4),
      {
        id,
        intent: input.intent ?? "info",
        title: input.title,
        description: input.description,
        durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
      },
    ]);
    return id;
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toasts, toast, dismiss }), [toasts, toast, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/** Returns the toast API. Outside a provider it is a no-op so leaf components stay testable. */
export function useToast(): ToastContextValue {
  return useContext(ToastContext) ?? NOOP;
}

const NOOP: ToastContextValue = { toasts: [], toast: () => "", dismiss: () => {} };
