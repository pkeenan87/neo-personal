"use client";

import { useState, type FormEvent } from "react";
import { MEMORY_TEXT_MAX, type MemoryItem } from "@/lib/memory-types";

const field = "min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm";

/**
 * Owners only (the page checks): what Neo remembers about the household (_specs/v2-m3-cutover.md section
 * 3). Add a short fact, or make Neo forget one at once. On a member's page it is narrowed to that person and
 * new facts are about them; on the household page it shows everything. The page loads the list on the
 * server (`initial`). Facts are shown as plain text, never as markup.
 */
export function MemoryPanel({
  initial,
  max,
  subject,
  people = [],
}: {
  initial: MemoryItem[];
  max: number;
  /** Set on a member's page: new facts are about this person. */
  subject?: { id: string; name: string };
  /** On the household page: the people a fact can be about. */
  people?: { id: string; name: string }[];
}) {
  const [items, setItems] = useState<MemoryItem[]>(initial);
  const [text, setText] = useState("");
  const [about, setAbout] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const full = items.length >= max;

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy("add");
    setError(null);
    try {
      const subjectMemberId = subject?.id ?? (about || undefined);
      const res = await fetch("/api/household/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, ...(subjectMemberId ? { subjectMemberId } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<MemoryItem> & { error?: string };
      if (!res.ok || !data.id) throw new Error(data.error || "That didn't save. Try again.");
      setItems((cur) => [...cur, data as MemoryItem]);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function forget(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/household/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "That didn't work. Try again.");
      }
      setItems((cur) => cur.filter((m) => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const heading = subject ? `What Neo remembers about ${subject.name}` : "What Neo remembers";
  return (
    <section aria-labelledby={`memory-heading-${subject?.id ?? "household"}`} className="mx-auto mt-8 w-full max-w-2xl space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 id={`memory-heading-${subject?.id ?? "household"}`} className="text-sm font-semibold">
        {heading}
      </h2>
      <p className="text-xs text-muted">
        Short facts Neo can look up when you chat with it, such as who helps whom. Neo only adds one when you ask it to and approve the exact words. Never put in passwords, links, phone numbers or card
        numbers. Facts are forgotten after a year, or right away when you press Forget.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((m) => (
            <li key={m.id} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm">{m.text}</p>
                <p className="text-xs text-muted">
                  {m.about ? `About ${m.about.name} · ` : "Whole household · "}
                  {m.source === "chat" ? "Added in chat" : "Added here"} · {m.createdAt.slice(0, 10)}
                </p>
              </div>
              <button type="button" disabled={busy !== null} onClick={() => void forget(m.id)} aria-label={`Forget: ${m.text}`} className="min-h-11 rounded-xl border border-border px-3 text-sm disabled:opacity-50">
                {busy === m.id ? "Forgetting…" : "Forget"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="space-y-2" aria-label="Add something for Neo to remember">
        <label className="block space-y-1 text-sm">
          <span>Add a fact</span>
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={MEMORY_TEXT_MAX} required disabled={full} className={field} placeholder="Gran's helper is Patrick" />
        </label>
        {!subject && people.length > 0 ? (
          <label className="block space-y-1 text-sm">
            <span>About</span>
            <select value={about} onChange={(e) => setAbout(e.target.value)} className={field}>
              <option value="">The whole household</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {full ? <p className="text-xs text-muted">Neo remembers {max} things already. Forget one to add another.</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy !== null || full} className="min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50">
          {busy === "add" ? "Saving…" : "Remember this"}
        </button>
      </form>
    </section>
  );
}
