import { SIGNIN_TEMPLATES } from "./templates.js";
import type { SignInAlertEvent, SignInAlertProvider } from "./types.js";

export { SIGNIN_ALERT_SENDERS, SIGNIN_ALERT_DOMAINS, SIGNIN_ALERT_LINK_HOSTS } from "./providers.js";
export { parseSigninAlert, parseEventTime, type SigninParseInput } from "./parse.js";
export { assessSigninAlert, type SigninAlertAssessment } from "./rules.js";
export type { SignInAlert, SignInAlertEvent, SignInAlertProvider, SigninFakeRule } from "./types.js";

/** Which templates exist and whether the owner has verified each against a real provider alert. */
export const SIGNIN_ALERT_TEMPLATES: readonly { id: string; provider: SignInAlertProvider; event: SignInAlertEvent; verified: boolean }[] =
  SIGNIN_TEMPLATES.map((t) => ({ id: t.id, provider: t.provider, event: t.event, verified: t.verified }));
