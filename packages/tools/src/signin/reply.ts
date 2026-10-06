/** Longest text scanned for a "reply with the code" request (the body is attacker-controlled). */
export const MAX_REPLY_SCAN_CHARS = 200_000;

/** Bounded windows only (`{0,60}`), so the scan is linear in the text length. */
export const REPLY_WITH_CODE = /\b(reply|respond|text back|send( it)? back)\b[^\n.]{0,60}\b(code|otp|passcode|pin)\b/i;

/** Text a mailto: link pre-fills (subject, body) that names a code or password. */
const MAILTO_CODE_WORDS = /\b(code|otp|passcode|pin|password)\b/i;

/** True when the (already normalized) text asks the reader to reply with a code. Scans the first 200k chars. */
export function asksReplyWithCode(text: string): boolean {
  return REPLY_WITH_CODE.test(text.length > MAX_REPLY_SCAN_CHARS ? text.slice(0, MAX_REPLY_SCAN_CHARS) : text);
}

/** True when a mailto: link's pre-filled subject/body or its visible text asks for a code. */
export function mailtoAsksForCode(query: string, displayText: string | undefined): boolean {
  return MAILTO_CODE_WORDS.test(query) || (!!displayText && REPLY_WITH_CODE.test(displayText));
}
