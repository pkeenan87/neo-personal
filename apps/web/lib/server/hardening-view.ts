import { CURRENT_ACCOUNT_HARDENING_MANIFEST } from "@neo/core";
import type { HardeningItemView } from "@/lib/hardening-types";

/** The active manifest as plain serializable props for client components. */
export function hardeningItemViews(): HardeningItemView[] {
  return CURRENT_ACCOUNT_HARDENING_MANIFEST.items.map(i => ({
    id: i.id, source: i.source, title: i.title, rule: i.rule, action: i.action,
    ...(i.notApplicableWhen ? { notApplicableWhen: i.notApplicableWhen } : {}),
    helpLinks: i.helpLinks.map(l => ({ ...l })),
  }));
}
