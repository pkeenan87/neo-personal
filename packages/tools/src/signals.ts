import emailSignals from "./data/email-signals.json" with { type: "json" };
import injection from "./data/injection-patterns.json" with { type: "json" };
import smsLures from "./data/sms-lures.json" with { type: "json" };
import { compilePatterns, matchSignals } from "./text.js";

type Table = ReadonlyArray<readonly [string, RegExp[]]>;

const EMAIL_TABLE: Table = Object.entries(emailSignals.signals as Record<string, string[]>).map(([code, list]) => [code, compilePatterns(list)] as const);
const INJECTION: RegExp[] = compilePatterns(injection.patterns);
const SMS_TABLE: Table = Object.entries(smsLures.signals as Record<string, Record<string, string[]>>).map(
  ([code, byLang]) => [code, compilePatterns(Object.values(byLang).flat())] as const,
);

/** Email content signal codes present in normalized text (includes the internal `callback_context`). */
export function emailContentSignals(normalized: string): string[] {
  return matchSignals(normalized, EMAIL_TABLE);
}

/** SMS lure codes present in normalized text (includes the internal `reply_stop_bait` / `reply_to_activate_link` candidates). */
export function smsLureSignals(normalized: string): string[] {
  return matchSignals(normalized, SMS_TABLE);
}

/** Content that addresses an AI reviewer or tries to override instructions. */
export function looksLikeInjection(normalized: string): boolean {
  return INJECTION.some((re) => re.test(normalized));
}
