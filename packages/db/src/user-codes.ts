/**
 * Human-typed codes (device-flow user codes, device enrollment codes): no vowels or
 * look-alikes (0/O, 1/I/L, 5/S, U/V) so they can be read out over the phone and typed.
 */
import { randomInt } from "node:crypto";

export const USER_CODE_ALPHABET = "BCDFGHJKMNPQRTWXYZ2346789";

/** `length` random characters from the alphabet, grouped by four with dashes. */
export function randomGroupedCode(length: number): string {
  let raw = "";
  for (let i = 0; i < length; i++) raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return groupCode(raw);
}

export function groupCode(raw: string): string {
  return raw.match(/.{1,4}/g)?.join("-") ?? "";
}
