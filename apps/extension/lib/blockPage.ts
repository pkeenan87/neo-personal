/**
 * The block page's pure helpers (`entrypoints/blocked`). The page's URL is attacker-influenced (any web
 * page can navigate to it), so everything read from it is validated here, and the background
 * re-checks that the policy really blocks the domain before reporting or requesting anything.
 */
import { WEB_CATEGORIES, type WebCategory } from "@neo/verdict";

export type BlockCategory = WebCategory | "custom";

export interface BlockPageParams {
  /** The blocked domain (what "Ask to unblock" names). */
  domain: string;
  category: BlockCategory;
  /** The page the person was going to, when it is on the blocked domain; where an approval sends them back. */
  returnUrl: string | null;
}

const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export const CATEGORY_LABELS: Record<BlockCategory, string> = {
  adult: "Adult content",
  gambling: "Gambling",
  weapons: "Weapons",
  self_harm: "Self-harm",
  drugs: "Drugs",
  proxy_vpn: "VPNs and proxies",
  social: "Social media",
  games: "Games",
  streaming: "Streaming",
  dating: "Dating",
  custom: "Blocked by your family",
};

export function parseBlockPageParams(search: string): BlockPageParams | null {
  const params = new URLSearchParams(search);
  const domain = (params.get("d") ?? "").toLowerCase();
  if (!DOMAIN.test(domain)) return null;
  const c = params.get("c") ?? "custom";
  const category: BlockCategory = (WEB_CATEGORIES as readonly string[]).includes(c) ? (c as WebCategory) : "custom";
  let returnUrl: string | null = null;
  const u = params.get("u");
  if (u) {
    try {
      const url = new URL(u);
      const host = url.hostname.toLowerCase();
      if ((url.protocol === "https:" || url.protocol === "http:") && (host === domain || host.endsWith(`.${domain}`))) returnUrl = url.href;
    } catch {
      /* not a URL: ignore it */
    }
  }
  return { domain, category, returnUrl };
}

/** Where to go once a parent allowed the site: the page that was blocked, else the site's front page. */
export function destinationAfterApproval(params: BlockPageParams): string {
  return params.returnUrl ?? `https://${params.domain}/`;
}

export const REASON_MAX = 140;

export function requestErrorText(code: string): string {
  switch (code) {
    case "too_many_pending":
      return "You already have several requests waiting. Wait for a parent to answer them.";
    case "daily_limit":
      return "You have asked a lot today. Try again tomorrow.";
    case "offline":
      return "Couldn't reach Neo. Check your connection and try again.";
    case "not_child_mode":
    case "not_blocked":
      return "This site isn't blocked any more. Reload the page.";
    case "reason_too_long":
      return `Keep your note to ${REASON_MAX} characters or fewer.`;
    default:
      return "Couldn't send your request. Try again in a moment.";
  }
}
