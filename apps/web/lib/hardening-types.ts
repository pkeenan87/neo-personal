/** Serializable checklist metadata and owner summary shapes for the hardening UI (_specs/hardening-score.md). */
import type { AccountHardeningHelpLink, AccountHardeningItemId } from "@neo/core";

export interface HardeningItemView {
  id: AccountHardeningItemId;
  source: "self_attested" | "neo_data";
  title: string;
  rule: string;
  action: string;
  notApplicableWhen?: string;
  helpLinks: AccountHardeningHelpLink[];
}

/** An owner's view of another member: name and percentage only. */
export interface HardeningMemberPercent {
  userId: string;
  name: string;
  scorePercent: number | null;
}
