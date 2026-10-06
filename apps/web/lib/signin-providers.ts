import type { SignInAlertProvider } from "@neo/tools";

/** Display names for the in-scope providers (static text: never taken from a message). */
export const PROVIDER_NAMES: Record<SignInAlertProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
  apple: "Apple",
  meta: "Facebook or Instagram",
  amazon: "Amazon",
  paypal: "PayPal",
};
