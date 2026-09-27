"use client";

import { useEffect, useRef } from "react";

/**
 * In-page confirmation (a modal <dialog>), used instead of window.confirm for
 * destructive household actions. Escape or Cancel closes it without confirming.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // jsdom has no showModal; fall back to the open attribute.
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-5 text-fg shadow-lg backdrop:bg-black/40"
    >
      <h2 id="confirm-dialog-title" className="text-base font-semibold">
        {title}
      </h2>
      <p className="mt-2 text-sm text-muted">{body}</p>
      <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="min-h-11 rounded-xl border border-border px-4 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="min-h-11 rounded-xl bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
