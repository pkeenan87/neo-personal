import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { AccountHardeningScore } from "@neo/core";
import type { HardeningItemView, HardeningMemberPercent } from "@/lib/hardening-types";

/**
 * The signed-in person's account-hardening score (_specs/hardening-score.md): a percentage or
 * "not enough answers", up to three next actions, and a link to Settings. Owners also see the
 * other members' percentages only, with no item detail.
 */
export function HardeningCard({ score, items, members }: {
  score: AccountHardeningScore;
  items: HardeningItemView[];
  /** Owner only: other current members' percentages. */
  members?: HardeningMemberPercent[];
}) {
  const actions = score.nextActions.flatMap(id => items.find(i => i.id === id) ?? []);
  return (
    <section aria-labelledby="hardening-heading" className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 id="hardening-heading" className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="size-5 text-accent" aria-hidden /> Account hardening
        </h2>
        <Link href="/settings/hardening" className="text-sm text-accent hover:underline">Open checklist</Link>
      </div>
      {score.scorePercent === null ? (
        <p className="mt-3 text-sm text-muted">Not enough answers yet. Answer at least 3 checklist questions to see your score.</p>
      ) : (
        <p className="mt-3">
          <span className="text-3xl font-semibold tabular-nums">{score.scorePercent}%</span>
          {score.partial ? <span className="ml-2 text-sm text-muted">Partial: some Neo data is unavailable</span> : null}
        </p>
      )}
      {actions.length > 0 ? (
        <>
          <h3 className="mt-4 text-sm font-medium">Next actions</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
            {actions.map(a => <li key={a.id}>{a.action}</li>)}
          </ol>
        </>
      ) : null}
      {members && members.length > 0 ? (
        <>
          <h3 className="mt-5 text-sm font-medium">Household members</h3>
          <ul className="mt-2 divide-y divide-border text-sm">
            {members.map(m => (
              <li key={m.userId} className="flex items-center justify-between py-1.5">
                <span>{m.name}</span>
                <span className="tabular-nums text-muted">{m.scorePercent === null ? "Not enough answers" : `${m.scorePercent}%`}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
