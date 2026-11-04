/**
 * `payment_page` (`_specs/v2-m2-child.md` section 6, the M1 handoff): a checkout-looking page for a
 * payment method scammers ask for (gift cards, crypto ATMs and exchanges, wire transfers). Pure
 * matching; the content script supplies the page's host, path, title and visible text. It reports
 * only `{ domain, category }`, never the URL or the page text, and runs in every mode: whether a
 * payment under pressure matters is the server's call (Elder rule 4).
 */
import type { PaymentCategory } from "@neo/verdict";

/** Registrable domains of services people are told to pay through. A small list on purpose. */
export const PAYMENT_HOSTS: Record<string, PaymentCategory> = {
  "giftcards.com": "gift_card",
  "blackhawknetwork.com": "gift_card",
  "cardcash.com": "gift_card",
  "raise.com": "gift_card",
  "giftcardgranny.com": "gift_card",
  "gyft.com": "gift_card",
  "coinflip.tech": "crypto",
  "bitcoindepot.com": "crypto",
  "athenabitcoin.com": "crypto",
  "localcoinatm.com": "crypto",
  "bitcoinofamerica.org": "crypto",
  "coinme.com": "crypto",
  "moonpay.com": "crypto",
  "banxa.com": "crypto",
  "transak.com": "crypto",
  "coinbase.com": "crypto",
  "kraken.com": "crypto",
  "westernunion.com": "wire",
  "moneygram.com": "wire",
  "wise.com": "wire",
  "remitly.com": "wire",
  "ofx.com": "wire",
  "worldremit.com": "wire",
  "xoom.com": "wire",
  "sendwave.com": "wire",
  "cash.app": "other",
  "zellepay.com": "other",
};

const CHECKOUT_PATH = /\/(?:checkout|payment|pay|send|transfer|cart|order|buy|purchase|redeem|deposit|wire|confirm)(?:\/|$|-|_|\.|\?)/i;
const CHECKOUT_TEXT = /\b(?:card number|enter (?:the )?amount|send money|pay now|place (?:your )?order|review (?:your )?order|confirm (?:the )?payment|recipient(?:'s)? (?:name|details)|billing (?:address|information))\b/i;

/** Phrases that are enough on their own, on any site: a page asking for payment in a scammer's favourite form. */
const TEXT_PATTERNS: { category: PaymentCategory; test: (text: string) => boolean }[] = [
  {
    category: "gift_card",
    test: (t) => /\bpay(?:ment)? (?:with|by|using) (?:a |an )?(?:itunes |apple |google play |steam |amazon )?gift ?cards?\b/.test(t) || /\benter (?:the |your )?(?:gift ?card|redemption) (?:code|number|pin)\b/.test(t),
  },
  {
    category: "crypto",
    test: (t) => /\b(?:bitcoin|crypto(?:currency)?) atm\b/.test(t) || (/\bwallet address\b/.test(t) && /\b(?:send|deposit|transfer)\b/.test(t) && /\b(?:bitcoin|btc|usdt|ethereum)\b/.test(t)),
  },
  {
    category: "wire",
    test: (t) => /\bwire transfer\b/.test(t) && /\b(?:account number|routing number|swift|iban)\b/.test(t) && /\b(?:pay|payment|send|instructions)\b/.test(t),
  },
];

/** How much page text is looked at: enough for a checkout form, bounded so a huge page costs little. */
export const PAYMENT_TEXT_LIMIT = 8000;

export interface PaymentPageInput {
  /** Registrable domain of the page (from the content script's own `location`). */
  domain: string;
  pathname: string;
  title: string;
  text: string;
}

export function detectPaymentPage(input: PaymentPageInput): PaymentCategory | null {
  const text = `${input.title}\n${input.text}`.slice(0, PAYMENT_TEXT_LIMIT).toLowerCase();
  const listed = PAYMENT_HOSTS[input.domain.toLowerCase()];
  if (listed && (CHECKOUT_PATH.test(input.pathname) || CHECKOUT_TEXT.test(text))) return listed;
  for (const p of TEXT_PATTERNS) if (p.test(text) && (CHECKOUT_PATH.test(input.pathname) || CHECKOUT_TEXT.test(text) || /\bcheckout\b/.test(text))) return p.category;
  return null;
}
