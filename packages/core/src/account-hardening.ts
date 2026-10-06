/**
 * Account-hardening checklist and score (_specs/hardening-score.md). Pure and deterministic: no
 * model, no I/O. A shipped manifest version is immutable; changes need a new version.
 */

export type AccountHardeningVersion = "account-hardening-v1";
export type AccountHardeningItemId =
  | "primary_email_2fa" | "passkey_or_hardware_key" | "recovery_contacts_current" | "password_manager"
  | "carrier_port_out_pin" | "credit_freeze" | "os_browser_auto_update"
  | "forwarding_used_30d" | "browser_extension_enrolled" | "desktop_agent_enrolled";
export type AccountHardeningState = "complete" | "needs_action" | "unanswered" | "stale" | "unknown" | "not_applicable";
export type AccountHardeningEvidenceId = "forwarding_used_30d" | "browser_extension_enrolled" | "desktop_agent_enrolled";

export interface AccountHardeningHelpLink { provider: string; href: string }
export interface AccountHardeningManifestItem {
  id: AccountHardeningItemId;
  source: "self_attested" | "neo_data";
  weight: number;
  title: string;
  /** Exact completion rule, shown to the user. */
  rule: string;
  action: string;
  /** When `not_applicable` is a valid answer: the circumstance in which it applies. */
  notApplicableWhen?: string;
  /** Prior manifest versions whose answer for this item carries forward unchanged. */
  compatiblePriorVersions: readonly AccountHardeningVersion[];
  /** Static first-party provider links. Never user-, model- or email-supplied. */
  helpLinks: readonly AccountHardeningHelpLink[];
}
export interface AccountHardeningManifest {
  version: AccountHardeningVersion;
  items: readonly AccountHardeningManifestItem[];
}

/** Links re-checked 2026-10-05 (HTTP 200; transunion.com answers 403 to non-browser clients). */
const link = (provider: string, href: string): AccountHardeningHelpLink => ({ provider, href });
const NONE: readonly AccountHardeningVersion[] = [];

export const ACCOUNT_HARDENING_V1: AccountHardeningManifest = {
  version: "account-hardening-v1",
  items: [
    {
      id: "primary_email_2fa", source: "self_attested", weight: 15, title: "Two-factor authentication on your primary email",
      rule: "You say two-factor authentication is enabled on your primary email account.",
      action: "Turn on two-factor authentication for your primary email account.", compatiblePriorVersions: NONE,
      helpLinks: [
        link("Google Account Help", "https://support.google.com/accounts/answer/185839"),
        link("Microsoft Support", "https://support.microsoft.com/en-us/accounts-billing/security/how-to-use-two-step-verification-with-your-microsoft-account"),
        link("Apple Support", "https://support.apple.com/en-us/102660"),
      ],
    },
    {
      id: "passkey_or_hardware_key", source: "self_attested", weight: 15, title: "Passkey or security key on your primary email",
      rule: "You say at least one passkey or physical FIDO security key is registered on your primary email account.",
      action: "Register a passkey or a physical security key on your primary email account.", compatiblePriorVersions: NONE,
      helpLinks: [
        link("Google Account Help: passkeys", "https://support.google.com/accounts/answer/13548313"),
        link("Microsoft Support: passkeys", "https://support.microsoft.com/en-us/accounts-billing/security/create-save-passkey"),
        link("Apple Support: security keys", "https://support.apple.com/en-us/102637"),
      ],
    },
    {
      id: "password_manager", source: "self_attested", weight: 15, title: "Password manager",
      rule: "You say you use a password manager for unique passwords on your primary email and other important accounts. Neo does not inspect the manager or any password.",
      action: "Use a password manager so every important account has its own unique password.", compatiblePriorVersions: NONE,
      helpLinks: [
        link("Google Password Manager", "https://support.google.com/chrome/answer/95606"),
        link("Microsoft Password Manager", "https://support.microsoft.com/en-us/accounts-billing/manage/view-or-edit-your-passwords-in-microsoft-password-manager"),
        link("Apple Passwords", "https://support.apple.com/en-us/120758"),
      ],
    },
    {
      id: "recovery_contacts_current", source: "self_attested", weight: 10, title: "Recovery phone and email are current",
      rule: "You say the recovery phone and recovery email for your primary email account are current and accessible (or, where the provider offers neither, its supported recovery methods are).",
      action: "Check that the recovery phone and email on your primary email account are current.", compatiblePriorVersions: NONE,
      helpLinks: [
        link("Google Account Help", "https://support.google.com/accounts/answer/183723"),
        link("Microsoft Support", "https://support.microsoft.com/en-us/accounts-billing/manage/microsoft-account-security-info-verification-codes"),
        link("Apple Support", "https://support.apple.com/en-us/102641"),
      ],
    },
    {
      id: "carrier_port_out_pin", source: "self_attested", weight: 10, title: "Carrier port-out protection",
      rule: "You say an account PIN, port-out lock, or equivalent carrier protection is enabled for every mobile number you use. Neo never asks for the PIN.",
      action: "Turn on a port-out PIN or lock with your mobile carrier.",
      notApplicableWhen: "You have no mobile line.", compatiblePriorVersions: NONE,
      helpLinks: [
        link("Verizon Support", "https://www.verizon.com/support/port-out-faqs/"),
        link("T-Mobile Support", "https://www.t-mobile.com/support/plans-features/help-with-t-mobile-account-fraud"),
        link("AT&T Support", "https://www.att.com/support/article/wireless/KM1447526/"),
      ],
    },
    {
      id: "credit_freeze", source: "self_attested", weight: 10, title: "Credit freeze",
      rule: "You say a security freeze is active with Equifax, Experian, and TransUnion. A paid credit lock is not a freeze.",
      action: "Place a security freeze with Equifax, Experian, and TransUnion.",
      notApplicableWhen: "You are outside the US or have no credit file.", compatiblePriorVersions: NONE,
      helpLinks: [
        link("Equifax", "https://www.equifax.com/personal/credit-report-services/credit-freeze/"),
        link("Experian", "https://www.experian.com/help/credit-freeze"),
        link("TransUnion", "https://www.transunion.com/credit-freeze/credit-freeze-faq"),
      ],
    },
    {
      id: "os_browser_auto_update", source: "self_attested", weight: 10, title: "Automatic security updates",
      rule: "You say automatic security updates are enabled for every supported operating system and browser you regularly use (or an equivalent managed policy enforces them).",
      action: "Turn on automatic security updates for your operating systems and browsers.", compatiblePriorVersions: NONE,
      helpLinks: [
        link("Windows Update", "https://support.microsoft.com/en-us/windows/deployment/updates-lifecycle/windows-update-faq"),
        link("macOS updates", "https://support.apple.com/guide/mac-help/software-update-settings-on-mac-mchla7037245/mac"),
        link("Chrome updates", "https://support.google.com/chrome/answer/95414"),
        link("Edge updates", "https://support.microsoft.com/en-us/edge/microsoft-edge-update-settings"),
        link("Firefox updates", "https://support.mozilla.org/en-US/kb/managing-firefox-updates"),
      ],
    },
    {
      id: "forwarding_used_30d", source: "neo_data", weight: 5, title: "Forwarded something to Neo in the last 30 days",
      rule: "Neo received a message you forwarded within the last 30 days. Another household member's forward does not count.",
      action: "Forward a suspicious message to your household's Neo address.", compatiblePriorVersions: NONE, helpLinks: [],
    },
    {
      id: "browser_extension_enrolled", source: "neo_data", weight: 5, title: "Browser extension enrolled",
      rule: "You have at least one browser extension enrolled and not removed. An offline device still counts as enrolled.",
      action: "Install the Neo browser extension.", compatiblePriorVersions: NONE, helpLinks: [],
    },
    {
      id: "desktop_agent_enrolled", source: "neo_data", weight: 5, title: "Desktop agent enrolled",
      rule: "You have at least one desktop agent enrolled and not removed. An offline device still counts as enrolled.",
      action: "Install the Neo desktop agent.",
      notApplicableWhen: "You use only Linux or a Chromebook.", compatiblePriorVersions: NONE, helpLinks: [],
    },
  ],
};

export const ACCOUNT_HARDENING_MANIFESTS: Readonly<Record<AccountHardeningVersion, AccountHardeningManifest>> = {
  "account-hardening-v1": ACCOUNT_HARDENING_V1,
};
/** The active version. Activating a later one is an explicit release change. */
export const CURRENT_ACCOUNT_HARDENING_VERSION: AccountHardeningVersion = "account-hardening-v1";
export const CURRENT_ACCOUNT_HARDENING_MANIFEST: AccountHardeningManifest = ACCOUNT_HARDENING_MANIFESTS[CURRENT_ACCOUNT_HARDENING_VERSION];

export const ACCOUNT_HARDENING_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;
/** Fewer fresh (non-stale) answered self-attested items than this shows "not enough answers". */
export const ACCOUNT_HARDENING_MIN_ANSWERS = 3;
export const ACCOUNT_HARDENING_MAX_NEXT_ACTIONS = 3;

export interface AccountHardeningAnswerInput {
  itemId: AccountHardeningItemId;
  value: boolean | "not_applicable";
  checklistVersion: AccountHardeningVersion;
  answeredAt: Date;
}
export type AccountHardeningEvidence = Partial<Record<AccountHardeningEvidenceId, "complete" | "needs_action" | "unknown">>;

export interface AccountHardeningScore {
  checklistVersion: AccountHardeningVersion;
  asOf: string;
  scorePercent: number | null;
  partial: boolean;
  items: Array<{ id: AccountHardeningItemId; state: AccountHardeningState; weight: number; answeredAt: string | null }>;
  nextActions: AccountHardeningItemId[];
}

export function isAccountHardeningStale(answeredAt: Date, asOf: Date): boolean {
  return +answeredAt <= +asOf - ACCOUNT_HARDENING_STALE_AFTER_MS;
}

export function scoreAccountHardening(input: {
  answers: readonly AccountHardeningAnswerInput[];
  evidence: AccountHardeningEvidence;
  asOf: Date;
  manifest?: AccountHardeningManifest;
}): AccountHardeningScore {
  const manifest = input.manifest ?? CURRENT_ACCOUNT_HARDENING_MANIFEST;
  const { asOf } = input;
  const stateFor = (item: AccountHardeningManifestItem): { state: AccountHardeningState; answeredAt: Date | null } => {
    // An answer carries forward only for the current version or an explicitly compatible prior one.
    const answer = input.answers.find(a => a.itemId === item.id
      && (a.checklistVersion === manifest.version || item.compatiblePriorVersions.includes(a.checklistVersion)));
    if (item.source === "self_attested") {
      if (!answer) return { state: "unanswered", answeredAt: null };
      const answeredAt = answer.answeredAt;
      if (isAccountHardeningStale(answeredAt, asOf)) return { state: "stale", answeredAt };
      if (answer.value === "not_applicable") {
        return item.notApplicableWhen ? { state: "not_applicable", answeredAt } : { state: "unanswered", answeredAt: null };
      }
      return { state: answer.value ? "complete" : "needs_action", answeredAt };
    }
    const detected = input.evidence[item.id as AccountHardeningEvidenceId] ?? "unknown";
    // N/A never overrides a complete detection; it only exempts an open or unreadable one.
    if (detected !== "complete" && item.notApplicableWhen && answer?.value === "not_applicable") {
      return isAccountHardeningStale(answer.answeredAt, asOf)
        ? { state: "stale", answeredAt: answer.answeredAt }
        : { state: "not_applicable", answeredAt: answer.answeredAt };
    }
    return { state: detected, answeredAt: null };
  };

  const evaluated = manifest.items.map(item => ({ item, ...stateFor(item) }));
  const known = evaluated.filter(e => e.state !== "unknown" && e.state !== "not_applicable");
  const denominator = known.reduce((sum, e) => sum + e.item.weight, 0);
  const earned = known.filter(e => e.state === "complete").reduce((sum, e) => sum + e.item.weight, 0);
  const answered = evaluated.filter(e => e.item.source === "self_attested" && (e.state === "complete" || e.state === "needs_action" || e.state === "not_applicable")).length;
  const scorePercent = answered < ACCOUNT_HARDENING_MIN_ANSWERS || denominator === 0 ? null : Math.round((earned / denominator) * 100);
  const actionable = new Set<AccountHardeningState>(["needs_action", "unanswered", "stale"]);
  const nextActions = evaluated
    .filter(e => actionable.has(e.state))
    .sort((a, b) => b.item.weight - a.item.weight || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
    .slice(0, ACCOUNT_HARDENING_MAX_NEXT_ACTIONS)
    .map(e => e.item.id);

  return {
    checklistVersion: manifest.version,
    asOf: asOf.toISOString(),
    scorePercent,
    partial: evaluated.some(e => e.state === "unknown"),
    items: evaluated.map(e => ({ id: e.item.id, state: e.state, weight: e.item.weight, answeredAt: e.answeredAt ? e.answeredAt.toISOString() : null })),
    nextActions,
  };
}

export function isAccountHardeningItemId(value: unknown): value is AccountHardeningItemId {
  return typeof value === "string" && CURRENT_ACCOUNT_HARDENING_MANIFEST.items.some(i => i.id === value);
}

/**
 * Whether a user may answer `itemId` with `value`: true/false only for self-attested items, and
 * `not_applicable` only where the manifest names an eligibility exception (never a detected result otherwise).
 */
export function isAccountHardeningAnswerAllowed(itemId: unknown, value: unknown): value is boolean | "not_applicable" {
  const item = CURRENT_ACCOUNT_HARDENING_MANIFEST.items.find(i => i.id === itemId);
  if (!item) return false;
  if (value === "not_applicable") return item.notApplicableWhen !== undefined;
  return typeof value === "boolean" && item.source === "self_attested";
}
