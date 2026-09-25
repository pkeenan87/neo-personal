"use client";

import { Banknote, Gift, KeyRound, Link2, MessageSquareLock, MonitorSmartphone } from "lucide-react";
import Link from "next/link";
import { PLAYBOOK_ENTRIES, type PlaybookId } from "@/lib/playbooks";

const ICONS: Record<PlaybookId, typeof Link2> = {
  clicked_link: Link2,
  entered_password: KeyRound,
  sent_gift_cards: Gift,
  shared_code: MessageSquareLock,
  paid_scammer: Banknote,
  device_compromised: MonitorSmartphone,
};

const ITEM =
  "flex h-full min-h-12 w-full items-center gap-2.5 rounded-xl border border-border bg-surface p-3 text-left text-sm font-medium shadow-sm transition-colors hover:border-accent hover:bg-surface-2";

/**
 * The six incident playbook entry points. With `onPick` they are buttons
 * (chat empty state sends directly); without, links to `/chat?playbook=<id>`.
 */
export function PlaybookButtons({ onPick, className }: { onPick?: (id: PlaybookId) => void; className?: string }) {
  return (
    <ul className={`grid w-full gap-2 sm:grid-cols-2 ${className ?? ""}`} aria-label="Get help with something that already happened">
      {PLAYBOOK_ENTRIES.map((p) => {
        const Icon = ICONS[p.id];
        const content = (
          <>
            <Icon className="size-4 shrink-0 text-accent" aria-hidden="true" />
            <span>{p.title}</span>
          </>
        );
        return (
          <li key={p.id}>
            {onPick ? (
              <button type="button" onClick={() => onPick(p.id)} className={ITEM} data-playbook={p.id}>
                {content}
              </button>
            ) : (
              <Link href={`/chat?playbook=${p.id}`} className={ITEM} data-playbook={p.id}>
                {content}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
