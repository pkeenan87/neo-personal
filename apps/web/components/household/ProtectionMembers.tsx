import Link from "next/link";
import type { MemberProfile } from "@/lib/member-types";

const MODE_LABEL = { standard: "Standard", child: "Child", elder: "Elder" } as const;
const MODE_CHIP = {
  standard: "bg-surface-2 text-muted",
  child: "bg-surface-2 text-muted",
  elder: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
} as const;

/**
 * Owners only (the page checks): who Neo protects and in which mode, each linking to the member page
 * (_specs/v2-m1-elder.md section 8). Server-rendered; the editing happens on the member page.
 */
export function ProtectionMembers({ members }: { members: MemberProfile[] }) {
  return (
    <section aria-labelledby="protection-heading" className="mx-auto mt-8 w-full max-w-2xl rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 id="protection-heading" className="mb-1 text-sm font-semibold">
        Protection
      </h2>
      <p className="mb-3 text-xs text-muted">Choose how closely Neo watches over each person, and who is told when something looks wrong.</p>
      <ul className="divide-y divide-border">
        {members.map((m) => (
          <li key={m.id}>
            <Link href={`/settings/household/members/${m.id}`} className="flex min-h-11 items-center gap-3 py-3 hover:bg-surface-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.displayName}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${MODE_CHIP[m.mode]}`}>{MODE_LABEL[m.mode]} mode</span>
              <span className="sr-only">Edit {m.displayName}</span>
              <span aria-hidden="true" className="text-muted">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
