"use client";

import { KeyRound, Link2, MessageSquareWarning } from "lucide-react";
import type { PlaybookId } from "@/lib/playbooks";
import { NeoMark } from "./NeoMark";
import { PlaybookButtons } from "./PlaybookButtons";

export interface Suggestion {
  title: string;
  /** Text placed in the composer. */
  prompt: string;
  /** When true the prompt is sent immediately; otherwise the user completes it. */
  send: boolean;
  icon: typeof Link2;
}

export const SUGGESTIONS: Suggestion[] = [
  {
    title: "Is this link safe? …",
    prompt: "Is this link safe? ",
    send: false,
    icon: Link2,
  },
  {
    title: "Paste a suspicious text message",
    prompt: "I got this text message. Is it a scam?\n\n",
    send: false,
    icon: MessageSquareWarning,
  },
  {
    title: "I clicked a link and entered my password",
    prompt: "I clicked a link and entered my password. What should I do now?",
    send: true,
    icon: KeyRound,
  },
];

export function EmptyState({ onPick, onPlaybook }: { onPick: (s: Suggestion) => void; onPlaybook?: (id: PlaybookId) => void }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center px-4 py-8 text-center sm:py-12">
      <div className="flex size-20 items-center justify-center rounded-3xl bg-accent-soft text-accent">
        <NeoMark className="size-16" />
      </div>
      <h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">What can I check for you?</h2>
      <p className="mt-2 max-w-md text-pretty text-muted">
        Paste a link, an email, or a text message. I&apos;ll tell you if it&apos;s safe and what to do next.
      </p>
      <ul className="mt-8 grid w-full gap-2 sm:grid-cols-3" aria-label="Suggestions">
        {SUGGESTIONS.map((s) => (
          <li key={s.title}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="flex h-full min-h-14 w-full items-start gap-2.5 rounded-xl border border-border bg-surface p-3 text-left text-sm font-medium shadow-sm transition-colors hover:border-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <s.icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
              <span>{s.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {/* incident playbooks */}
      <section className="mt-8 w-full text-left" aria-labelledby="playbooks-heading">
        <h2 id="playbooks-heading" className="mb-2 text-sm font-semibold text-muted">
          Something already happened?
        </h2>
        <PlaybookButtons onPick={onPlaybook} />
      </section>
    </div>
  );
}
