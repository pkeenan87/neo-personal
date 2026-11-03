"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { CreatableMemberRole, MemberDetailResponse } from "@/lib/member-types";

const ROLE_LABEL: Record<CreatableMemberRole, string> = { adult: "Adult", child: "Child", elder: "Elder" };
const field = "min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm";

/**
 * Owners add a person who has no Neo account (_specs/v2-m2-child.md section 2): a child, or an adult or
 * elder reached by email. They start in Standard mode; the next page is theirs, where Child mode and a
 * device code are set up.
 */
export function AddMemberForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<CreatableMemberRole>("child");
  const [birthYear, setBirthYear] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/household/protected-members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: name,
          role,
          ...(role === "child" && birthYear.trim() !== "" ? { birthYear: Number(birthYear) } : {}),
          ...(role !== "child" && contact.trim() !== "" ? { contact } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<MemberDetailResponse> & { error?: string };
      if (!res.ok || !data.member) throw new Error(data.error || "That didn't save. Try again.");
      router.push(`/settings/household/members/${encodeURIComponent(data.member.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save. Try again.");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-4 min-h-11 rounded-xl border border-border px-4 text-sm">
        Add a person without an account
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border border-border p-4" aria-label="Add a person without an account">
      <h3 className="text-sm font-semibold">Add a person without an account</h3>
      <p className="text-xs text-muted">For a child, or for someone who doesn&apos;t use Neo themselves. You can protect their devices and, for an adult, email them.</p>
      <label className="block space-y-1 text-sm">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required className={field} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value as CreatableMemberRole)} className={field}>
          {(Object.keys(ROLE_LABEL) as CreatableMemberRole[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      {role === "child" ? (
        <label className="block space-y-1 text-sm">
          <span>Birth year</span>
          <input type="number" inputMode="numeric" min={1900} max={new Date().getFullYear()} value={birthYear} onChange={(e) => setBirthYear(e.target.value)} required className={field} />
        </label>
      ) : (
        <label className="block space-y-1 text-sm">
          <span>Email (optional)</span>
          <input type="email" value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" className={field} />
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50">
          {busy ? "Adding…" : "Add person"}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="min-h-11 rounded-xl border border-border px-4 text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
