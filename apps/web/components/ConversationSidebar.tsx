"use client";

// Lifted from the sidebar in Neo ChatInterface.tsx (rename/settings/downloads/role dropped).
import { LayoutDashboard, LogOut, MessageSquare, MessageSquareDashed, Plus, Settings, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "@/lib/api-types";
import { DESKTOP_MEDIA_QUERY } from "@/lib/media-query";
import { NeoMark } from "./NeoMark";

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "");
  return s.toUpperCase() || "?";
}

export interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  user: { name: string; email: string };
  /** Mobile drawer state; ignored at md+ where the sidebar is always visible. */
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onSelect?: (id: string) => void;
  onDelete: (id: string) => void;
  onSignOut: () => void;
}

export function ConversationSidebar({
  conversations,
  activeId,
  user,
  open,
  onClose,
  onNew,
  onSelect,
  onDelete,
  onSignOut,
}: ConversationSidebarProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const desktopViewport = window.matchMedia(DESKTOP_MEDIA_QUERY);
    if (desktopViewport.matches) return;

    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (desktopViewport.matches) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>(
          '#conversation-sidebar a[href], #conversation-sidebar button:not([disabled]), #conversation-sidebar [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !document.activeElement?.closest("#conversation-sidebar"))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !document.activeElement?.closest("#conversation-sidebar"))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity md:hidden ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        id="conversation-sidebar"
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label="Conversations"
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface pt-[env(safe-area-inset-top)] transition-transform md:static md:z-auto md:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full max-md:invisible"}`}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3 font-semibold tracking-tight">
            <NeoMark className="size-10 text-accent" />
            <span className="text-xl">Neo</span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close conversations"
            className="flex size-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:hidden"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>

        {/* app navigation */}
        <nav aria-label="Main" className="mb-2 space-y-0.5 px-2">
          <Link href="/dashboard" className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <LayoutDashboard className="size-4 text-muted" aria-hidden="true" />
            Dashboard
          </Link>
          <Link href="/chat" aria-current="page" className="flex min-h-11 items-center gap-2 rounded-lg bg-accent-soft px-2 text-sm font-medium text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <MessageSquare className="size-4" aria-hidden="true" />
            Chat
          </Link>
          <Link href="/settings/forwarding" className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <Settings className="size-4 text-muted" aria-hidden="true" />
            Settings
          </Link>
        </nav>

        <div className="px-3">
          <button
            type="button"
            onClick={onNew}
            className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-border-strong px-3 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Plus className="size-4" aria-hidden="true" />
            New check
          </button>
        </div>

        <nav aria-label="Recent conversations" className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Recent</h2>
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-8 text-sm text-muted">
              <MessageSquareDashed className="size-6" aria-hidden="true" />
              No conversations yet
            </div>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((c) => {
                const active = c.id === activeId;
                const confirming = confirmingId === c.id;
                return (
                  <li key={c.id} className="group relative">
                    <Link
                      href={`/chat/${c.id}`}
                      aria-current={active ? "page" : undefined}
                      onClick={() => {
                        onSelect?.(c.id);
                        onClose();
                      }}
                      className={`flex min-h-11 items-center gap-2 rounded-lg py-2 pr-10 pl-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${active ? "bg-surface-2 font-medium" : "hover:bg-surface-2"}`}
                    >
                      <MessageSquare className="size-4 shrink-0 text-muted" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{c.title || "New conversation"}</span>
                        <span className="block text-xs text-muted" suppressHydrationWarning>{relativeTime(c.updatedAt)}</span>
                      </span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirming) {
                          setConfirmingId(null);
                          onDelete(c.id);
                        } else {
                          setConfirmingId(c.id);
                        }
                      }}
                      onBlur={() => setConfirmingId((cur) => (cur === c.id ? null : cur))}
                      aria-label={confirming ? `Confirm delete ${c.title || "conversation"}` : `Delete ${c.title || "conversation"}`}
                      className={`absolute top-1/2 right-1 flex min-h-10 min-w-10 -translate-y-1/2 items-center justify-center rounded-md p-2 text-xs font-semibold focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                        confirming
                          ? "bg-red-600 text-white opacity-100"
                          : "text-muted opacity-100 hover:bg-surface hover:text-red-600 md:opacity-0 md:group-hover:opacity-100"
                      }`}
                    >
                      {confirming ? "Delete" : <Trash2 className="size-4" aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="flex items-center gap-2 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
            aria-hidden="true"
          >
            {initials(user.name)}
          </div>
          <div className="min-w-0 flex-1 text-sm">
            <div className="truncate font-medium">{user.name}</div>
            <div className="truncate text-xs text-muted">{user.email}</div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
            className="flex size-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <LogOut className="size-4" aria-hidden="true" />
          </button>
        </div>
      </aside>
    </>
  );
}
