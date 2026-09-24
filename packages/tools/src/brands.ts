import type { Brand } from "./types.js";

/**
 * [display name, legitimate registrable domains, extra keywords, owns many ccTLDs]
 * The first label of each domain is always a keyword. Keywords shorter than 4
 * characters are only matched as whole hyphen/dot tokens.
 */
type Row = [string, string[], string[]?, boolean?];

const ROWS: Row[] = [
  // Big tech / mail / identity
  ["Apple", ["apple.com", "icloud.com", "me.com", "mac.com", "apple.news", "appleid.com"], ["appleid", "icloud", "itunes"]],
  ["Microsoft", ["microsoft.com", "microsoftonline.com", "live.com", "outlook.com", "office.com", "office365.com", "hotmail.com", "msn.com", "sharepoint.com", "onedrive.com", "windows.com", "azure.com", "xbox.com", "skype.com", "bing.com", "microsoft365.com"], ["office365", "onedrive", "outlook", "hotmail", "sharepoint", "msonline"]],
  ["Google", ["google.com", "gmail.com", "youtube.com", "googleusercontent.com", "gstatic.com", "googleapis.com", "goo.gl", "android.com", "withgoogle.com", "blogger.com", "google.dev"], ["gmail", "youtube"], true],
  ["Amazon", ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.ca", "amazon.co.jp", "amazon.in", "amazon.com.au", "amazon.es", "amazon.it", "aws.amazon.com", "amazonaws.com", "a2z.com", "primevideo.com", "audible.com"], ["primevideo"], true],
  ["Yahoo", ["yahoo.com", "yahoo.co.jp", "ymail.com", "aol.com"], ["ymail"], true],
  ["Proton", ["proton.me", "protonmail.com", "protonmail.ch"], ["protonmail"]],
  ["Zoho", ["zoho.com", "zoho.eu", "zohomail.com"], []],
  ["GMX", ["gmx.com", "gmx.net", "gmx.de", "mail.com"], []],
  ["Fastmail", ["fastmail.com", "fastmail.fm"], []],
  ["Meta", ["facebook.com", "fb.com", "instagram.com", "whatsapp.com", "whatsapp.net", "messenger.com", "meta.com", "threads.net", "oculus.com"], ["facebook", "instagram", "whatsapp", "messenger"]],
  ["X (Twitter)", ["x.com", "twitter.com", "t.co"], ["twitter"]],
  ["LinkedIn", ["linkedin.com", "lnkd.in"], []],
  ["TikTok", ["tiktok.com"], []],
  ["Snapchat", ["snapchat.com"], []],
  ["Discord", ["discord.com", "discord.gg", "discordapp.com"], []],
  ["Telegram", ["telegram.org", "t.me"], []],
  ["Signal", ["signal.org"], []],
  ["Reddit", ["reddit.com"], []],
  ["Pinterest", ["pinterest.com"], [], true],
  // Payments / fintech
  ["PayPal", ["paypal.com", "paypal.me", "paypalobjects.com", "paypal-community.com"], [], true],
  ["Venmo", ["venmo.com"], []],
  ["Cash App", ["cash.app", "cash.me", "squareup.com", "block.xyz"], ["cashapp"]],
  ["Zelle", ["zellepay.com"], ["zelle"]],
  ["Stripe", ["stripe.com"], []],
  ["Square", ["squareup.com", "square.com"], []],
  ["Wise", ["wise.com", "transferwise.com"], ["transferwise"]],
  ["Revolut", ["revolut.com"], []],
  ["Klarna", ["klarna.com"], []],
  ["Afterpay", ["afterpay.com"], []],
  ["Western Union", ["westernunion.com"], []],
  ["MoneyGram", ["moneygram.com"], []],
  ["Visa", ["visa.com"], []],
  ["Mastercard", ["mastercard.com", "mastercard.us"], []],
  ["American Express", ["americanexpress.com", "aexp.com"], ["amex"]],
  ["Discover", ["discover.com"], []],
  ["Apple Pay", ["apple.com"], ["applepay"]],
  ["Google Pay", ["pay.google.com", "google.com"], ["googlepay", "gpay"]],
  // US banks and brokerages
  ["Chase", ["chase.com", "jpmorganchase.com", "jpmorgan.com"], ["jpmorgan"]],
  ["Bank of America", ["bankofamerica.com", "bofa.com", "ml.com", "merrilledge.com"], ["bofa", "merrill"]],
  ["Wells Fargo", ["wellsfargo.com", "wf.com"], []],
  ["Citi", ["citi.com", "citibank.com", "citigroup.com"], ["citibank"]],
  ["Capital One", ["capitalone.com"], []],
  ["U.S. Bank", ["usbank.com"], []],
  ["PNC", ["pnc.com"], []],
  ["Truist", ["truist.com"], []],
  ["TD Bank", ["td.com", "tdbank.com"], ["tdbank"]],
  ["Ally", ["ally.com"], ["allybank"]],
  ["Navy Federal", ["navyfederal.org"], []],
  ["USAA", ["usaa.com"], []],
  ["Charles Schwab", ["schwab.com"], []],
  ["Fidelity", ["fidelity.com", "fidelityinvestments.com"], []],
  ["Vanguard", ["vanguard.com", "investor.vanguard.com"], []],
  ["Robinhood", ["robinhood.com"], []],
  ["E*TRADE", ["etrade.com"], []],
  ["SoFi", ["sofi.com"], []],
  ["Chime", ["chime.com"], []],
  ["Discover Bank", ["discoverbank.com"], []],
  ["Synchrony", ["synchrony.com", "mysynchrony.com"], []],
  ["Barclays", ["barclays.com", "barclays.co.uk", "barclaycardus.com"], ["barclaycard"]],
  // International banks
  ["HSBC", ["hsbc.com", "hsbc.co.uk", "hsbc.com.hk"], [], true],
  ["Lloyds", ["lloydsbank.com", "lloydsbankinggroup.com"], ["lloydsbank"]],
  ["NatWest", ["natwest.com"], []],
  ["Santander", ["santander.com", "santander.co.uk", "santanderbank.com"], [], true],
  ["Monzo", ["monzo.com"], []],
  ["Halifax", ["halifax.co.uk"], []],
  ["ING", ["ing.com", "ing.nl", "ing.de"], [], true],
  ["Deutsche Bank", ["deutsche-bank.de", "db.com"], ["deutschebank"]],
  ["BNP Paribas", ["bnpparibas.com", "bnpparibas.fr"], ["bnpparibas"]],
  ["RBC", ["rbc.com", "rbcroyalbank.com"], ["royalbank"]],
  ["Scotiabank", ["scotiabank.com"], []],
  ["Commonwealth Bank", ["commbank.com.au"], ["commbank"]],
  ["ANZ", ["anz.com", "anz.com.au"], []],
  ["N26", ["n26.com"], []],
  // Crypto
  ["Coinbase", ["coinbase.com"], []],
  ["Binance", ["binance.com", "binance.us"], []],
  ["Kraken", ["kraken.com"], []],
  ["Crypto.com", ["crypto.com"], []],
  ["Gemini", ["gemini.com"], []],
  ["Bitstamp", ["bitstamp.net"], []],
  ["KuCoin", ["kucoin.com"], []],
  ["OKX", ["okx.com"], []],
  ["Bybit", ["bybit.com"], []],
  ["Bitfinex", ["bitfinex.com"], []],
  ["MetaMask", ["metamask.io"], []],
  ["Ledger", ["ledger.com"], []],
  ["Trezor", ["trezor.io"], []],
  ["Trust Wallet", ["trustwallet.com"], []],
  ["Blockchain.com", ["blockchain.com"], []],
  ["Uniswap", ["uniswap.org", "app.uniswap.org"], []],
  ["OpenSea", ["opensea.io"], []],
  ["Phantom", ["phantom.app", "phantom.com"], []],
  // Shipping / postal
  ["USPS", ["usps.com", "usps.gov"], []],
  ["UPS", ["ups.com"], []],
  ["FedEx", ["fedex.com"], []],
  ["DHL", ["dhl.com", "dhl.de"], [], true],
  ["Royal Mail", ["royalmail.com"], []],
  ["Canada Post", ["canadapost-postescanada.ca", "canadapost.ca"], ["canadapost"]],
  ["Australia Post", ["auspost.com.au"], ["auspost"]],
  ["Evri", ["evri.com"], ["hermes"]],
  ["DPD", ["dpd.com", "dpd.co.uk"], []],
  // Streaming / consumer
  ["Netflix", ["netflix.com", "nflxext.com"], [], true],
  ["Disney+", ["disneyplus.com", "disney.com"], ["disneyplus"]],
  ["Hulu", ["hulu.com"], []],
  ["Spotify", ["spotify.com"], []],
  ["HBO Max", ["max.com", "hbomax.com"], ["hbomax"]],
  ["Amazon Prime", ["amazon.com"], ["amazonprime"]],
  ["Steam", ["steampowered.com", "steamcommunity.com"], ["steampowered", "steamcommunity"]],
  ["Epic Games", ["epicgames.com"], ["epicgames"]],
  ["Roblox", ["roblox.com"], []],
  ["PlayStation", ["playstation.com", "sony.com"], []],
  ["Nintendo", ["nintendo.com"], []],
  ["eBay", ["ebay.com", "ebay.co.uk", "ebay.de"], [], true],
  ["Walmart", ["walmart.com"], []],
  ["Target", ["target.com"], []],
  ["Costco", ["costco.com"], []],
  ["Best Buy", ["bestbuy.com"], ["bestbuy"]],
  ["Home Depot", ["homedepot.com"], ["homedepot"]],
  ["Etsy", ["etsy.com"], []],
  ["Shopify", ["shopify.com", "myshopify.com"], []],
  ["AliExpress", ["aliexpress.com", "alibaba.com"], []],
  ["Temu", ["temu.com"], []],
  ["Shein", ["shein.com"], []],
  ["Uber", ["uber.com"], []],
  ["Lyft", ["lyft.com"], []],
  ["Airbnb", ["airbnb.com"], [], true],
  ["Booking.com", ["booking.com"], []],
  ["Expedia", ["expedia.com"], []],
  ["DoorDash", ["doordash.com"], []],
  // SaaS / productivity / dev
  ["Dropbox", ["dropbox.com", "dropboxusercontent.com"], []],
  ["Box", ["box.com"], []],
  ["DocuSign", ["docusign.com", "docusign.net"], []],
  ["Adobe", ["adobe.com", "adobesign.com", "acrobat.com"], []],
  ["Salesforce", ["salesforce.com", "force.com"], []],
  ["Slack", ["slack.com"], []],
  ["Zoom", ["zoom.us", "zoom.com"], []],
  ["Webex", ["webex.com"], []],
  ["Atlassian", ["atlassian.com", "atlassian.net", "bitbucket.org", "trello.com"], ["jira", "confluence", "trello"]],
  ["GitHub", ["github.com", "github.io", "githubusercontent.com"], []],
  ["GitLab", ["gitlab.com"], []],
  ["Notion", ["notion.so", "notion.com"], []],
  ["Okta", ["okta.com", "oktapreview.com"], []],
  ["Intuit", ["intuit.com", "turbotax.com", "quickbooks.com", "creditkarma.com", "mint.com"], ["turbotax", "quickbooks", "creditkarma"]],
  ["Norton", ["norton.com", "nortonlifelock.com"], []],
  ["McAfee", ["mcafee.com"], []],
  ["Mailchimp", ["mailchimp.com"], []],
  ["WeTransfer", ["wetransfer.com"], []],
  ["OpenAI", ["openai.com", "chatgpt.com"], ["chatgpt"]],
  ["Anthropic", ["anthropic.com", "claude.ai", "claude.com"], []],
  ["Cloudflare", ["cloudflare.com"], []],
  ["GoDaddy", ["godaddy.com"], []],
  ["Namecheap", ["namecheap.com"], []],
  // Telecom / utilities / government
  ["Verizon", ["verizon.com", "verizonwireless.com"], []],
  ["AT&T", ["att.com", "att.net"], []],
  ["T-Mobile", ["t-mobile.com"], ["tmobile"]],
  ["Comcast Xfinity", ["xfinity.com", "comcast.com", "comcast.net"], ["xfinity", "comcast"]],
  ["Spectrum", ["spectrum.com", "spectrum.net"], []],
  ["IRS", ["irs.gov"], []],
  ["Social Security", ["ssa.gov"], []],
  ["Medicare", ["medicare.gov"], []],
  ["HMRC", ["gov.uk"], ["hmrc"]],
  ["E-ZPass", ["e-zpassny.com", "ezpassnj.com", "e-zpassiag.com"], ["ezpass"]],
  ["SunPass", ["sunpass.com"], []],
  ["FasTrak", ["bayareafastrak.org", "thetollroads.com"], ["fastrak"]],
  ["DMV", ["dmv.ca.gov", "dmv.org"], []],
];

/** Domain labels that are not distinctive enough to be brand keywords. */
const NOT_KEYWORDS = new Set([
  "pay", "app", "investor", "mail", "block", "force", "a2z", "gstatic", "googleapis", "googleusercontent", "nflxext",
  "paypalobjects", "dropboxusercontent", "githubusercontent", "withgoogle", "aexp", "cash", "mysynchrony", "sony",
]);

/**
 * Brand keywords that are also ordinary words or common names. They are only
 * matched together with phishing-style affixes or a full brand domain in the
 * subdomain, never by TLD swap or edit distance.
 */
export const GENERIC_KEYWORDS = new Set([
  "box", "target", "discover", "square", "signal", "chase", "ally", "zoom", "notion", "steam", "visa", "phantom",
  "ledger", "kraken", "spectrum", "wise", "gemini", "max", "chime", "hermes", "merrill", "fidelity", "vanguard", "mint",
  "live", "office", "outlook", "messenger", "windows", "meta", "threads", "proton", "crypto", "blockchain", "booking",
  "slack", "halifax", "santander", "citi", "ing", "anz", "dpd", "dmv", "uber", "medicare", "azure", "skype", "bing",
]);

// A domain label becomes a keyword only for the first brand that lists it
// (so "Google Pay" does not re-claim "google" without Google's ccTLD handling).
const claimed = new Set<string>();
export const BRANDS: Brand[] = ROWS.map(([name, domains, extra = [], ccTLDs = false]) => {
  const keywords = new Set<string>(extra);
  for (const d of domains) {
    const label = d.split(".")[0]?.replace(/-/g, "");
    if (label && label.length >= 3 && !NOT_KEYWORDS.has(label) && !claimed.has(label)) keywords.add(label);
  }
  for (const k of keywords) claimed.add(k);
  return { name, domains, keywords: [...keywords], ccTLDs };
});
