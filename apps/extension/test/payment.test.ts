// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectPaymentPage } from "../lib/detectors/payment.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "payment");

/** Loads a fixture the way the content script sees it: title plus visible text. */
function load(name: string, domain: string, pathname: string) {
  document.documentElement.innerHTML = readFileSync(join(dir, name), "utf8");
  return { domain, pathname, title: document.title, text: document.body.textContent ?? "" };
}

describe("payment_page detector", () => {
  it("flags a gift-card checkout", () => {
    expect(detectPaymentPage(load("giftcard-checkout.html", "pay-now.example", "/checkout"))).toBe("gift_card");
  });
  it("flags a crypto ATM payment page", () => {
    expect(detectPaymentPage(load("crypto-atm.html", "pay-help.example", "/deposit/instructions"))).toBe("crypto");
  });
  it("flags wire-transfer payment instructions", () => {
    expect(detectPaymentPage(load("wire-instructions.html", "billing.example", "/pay"))).toBe("wire");
  });
  it("flags a known money-transfer service only on a checkout-like page", () => {
    expect(detectPaymentPage(load("westernunion-send.html", "westernunion.com", "/us/en/web/send-money/start"))).toBe("wire");
    expect(detectPaymentPage(load("westernunion-home.html", "westernunion.com", "/"))).toBeNull();
  });
  it("does not flag an article that merely talks about these payment methods", () => {
    expect(detectPaymentPage(load("article.html", "news.example", "/scam-awareness"))).toBeNull();
  });
  it("is category 'other' for the other known services, and sends nothing but the category", () => {
    const r = detectPaymentPage({ domain: "cash.app", pathname: "/pay/abc", title: "", text: "" });
    expect(r).toBe("other");
  });
  it("bounds how much page text it reads", () => {
    const huge = "x".repeat(50_000) + " pay with gift card checkout";
    expect(detectPaymentPage({ domain: "a.example", pathname: "/", title: "", text: huge })).toBeNull();
  });
});
