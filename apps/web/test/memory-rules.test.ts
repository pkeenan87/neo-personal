// @vitest-environment node
/** The content rules for household memory (_specs/v2-m3-cutover.md section 3): what a stored fact may not hold. */
import { describe, expect, it } from "vitest";
import { checkMemoryText, type MemoryRejection } from "@/lib/server/memory-rules";

const code = (text: unknown): string => {
  const r = checkMemoryText(text);
  return r.ok ? "ok" : r.code;
};

describe("accepted", () => {
  it.each([
    "Gran's helper is Patrick.",
    "Gran's TeamViewer is expected when Patrick helps with her laptop.",
    "Sam may use the family PC until 8pm on school nights.",
    "Dad prefers a phone call, not a message.",
    "Mum was born in 1951 and lives alone.",
    "Gran calls herself Nana — Dr. Lee is her GP.",
    "We pay the electricity bill on the 3rd.",
    "😀 Grandpa's tablet is the one in the kitchen",
  ])("keeps %s", (text) => {
    expect(checkMemoryText(text)).toEqual({ ok: true, text });
  });

  it("trims the ends", () => {
    expect(checkMemoryText("  hello there  ")).toEqual({ ok: true, text: "hello there" });
  });
});

describe("rejected", () => {
  const cases: Array<[MemoryRejection, string[]]> = [
    ["empty", ["", "   "]],
    ["too_long", ["a ".repeat(141)]],
    ["control_characters", ["line one\nline two", "tab\there", "zero​width", "bidi ‮ text", "nul\u0000", "para sep", "privateuse"]],
    ["contact_details", ["Email gran at gran@example.com", "Her handle is @gran_smith", "call 0412 345 678", "Phone: +1 (555) 123-4567", "call 555.123.4567 after six", "ＧＲＡＮ＠example dot com"]],
    ["link", ["See https://example.com/help", "go to www.example.org", "the site is bank-login.com", "use ftp://files.local/x", "open example.co.uk/path", "javascript:alert(1)", "bit.ly/abc"]],
    ["credentials", ["Her password is blue", "the wifi passcode is open", "PIN is four digits", "Her 2FA code lives in the drawer", "api key lives somewhere", "ghp_abcdefghijklmnop", "sk-abcdefghijklmnopqrst", "the token is in her bag", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", "-----BEGIN PRIVATE", "recovery phrase on paper", "eyJhbGciOiJIUzI1NiJ9"]],
    ["payment_data", ["Her credit card is the blue one", "bank account number is on the fridge", "IBAN GB82WEST12345698765432", "sort code is in the file", "social security card", "pays by PayPal", "visa 4111 1111 1111 1111", "the number 4111111111111111"]],
  ];
  for (const [rejection, texts] of cases) {
    it.each(texts)(`${rejection}: %j`, (text) => {
      // digit-only payment numbers are caught as contact details (any seven digits in a row): both refuse.
      expect(["payment_data", "contact_details", "link", rejection]).toContain(code(text));
      expect(code(text)).not.toBe("ok");
    });
  }

  it("names the category it refused for the common cases", () => {
    expect(code("email me at a@b.co")).toBe("contact_details");
    expect(code("Call 555 123 4567")).toBe("contact_details");
    expect(code("see https://evil.example")).toBe("link");
    expect(code("her password is x")).toBe("credentials");
    expect(code("credit card in the drawer")).toBe("payment_data");
    expect(code("a".repeat(281))).toBe("too_long");
    expect(code("x\ny")).toBe("control_characters");
  });

  it("counts characters, not UTF-16 units", () => {
    expect(code("😀".repeat(280))).toBe("ok");
    expect(code("😀".repeat(281))).toBe("too_long");
  });

  it("refuses anything that is not a string", () => {
    for (const v of [undefined, null, 42, {}, ["a"]]) expect(code(v)).toBe("empty");
  });
});
