/**
 * Well-known domains per category that get a DNR redirect rule, so they are blocked before any
 * request is made (`_specs/v2-m2-child.md` section 5). The category data in the hashed lists covers
 * everything else through the content script. Hand-curated (MIT, Neo project), deliberately short:
 * a Chrome dynamic-rule budget is shared with SafeSearch and the parent's own block list, and a
 * wrong entry here blocks a real site. Only domains whose purpose is unambiguous belong here.
 * `self_harm` and `drugs` are empty on purpose: the lists and the parent's block list cover them.
 */
import type { WebCategory } from "@neo/verdict";

export const TOP_DOMAINS: Record<WebCategory, readonly string[]> = {
  adult: ["pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com", "youporn.com", "chaturbate.com", "stripchat.com", "spankbang.com", "eporner.com", "onlyfans.com"],
  gambling: ["bet365.com", "draftkings.com", "fanduel.com", "betmgm.com", "williamhill.com", "pokerstars.com", "stake.com", "888casino.com", "bovada.lv"],
  weapons: [],
  self_harm: [],
  drugs: [],
  proxy_vpn: ["nordvpn.com", "expressvpn.com", "protonvpn.com", "surfshark.com", "privateinternetaccess.com", "cyberghostvpn.com", "windscribe.com", "tunnelbear.com", "hide.me", "hidemyass.com", "proxysite.com", "croxyproxy.com"],
  social: ["facebook.com", "instagram.com", "tiktok.com", "twitter.com", "x.com", "snapchat.com", "reddit.com", "pinterest.com", "tumblr.com"],
  games: ["roblox.com", "steampowered.com", "epicgames.com", "miniclip.com", "poki.com", "crazygames.com", "friv.com"],
  streaming: ["netflix.com", "hulu.com", "disneyplus.com", "primevideo.com", "twitch.tv"],
  dating: ["tinder.com", "bumble.com", "hinge.co", "match.com", "okcupid.com", "grindr.com", "badoo.com"],
};
