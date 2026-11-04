# Third-party notices

Neo is MIT licensed (`LICENSE`). The browser extension's Child mode uses domain category data from the projects below. Package dependencies are listed in `pnpm-lock.yaml`; this file covers data that ships in the repository.

## Category lists (`apps/web/public/category-lists/`)

This product includes domain category data from the UT1 Blacklists, © Université Toulouse Capitole (Fabrice Prigent), http://dsi.ut-capitole.fr/blacklists/, licensed under CC BY-SA 4.0. The data has been converted to a compact format and filtered; no endorsement by the licensor is implied. The adapted data in ut1-* files is distributed under the same licence.

Includes data from The Block List Project (https://github.com/blocklistproject/Lists), released under the Unlicense.

Details:

- **UT1 Blacklists** (Creative Commons Attribution-ShareAlike 4.0, https://creativecommons.org/licenses/by-sa/4.0/), taken from the mirror https://github.com/olbat/ut1-blacklists at the commit pinned in `scripts/category-lists/sources.json`. Categories used: vpn, residential-proxies and doh (`proxy_vpn`), games, dating, audio-video (`streaming`), dangerous_material (`weapons`) and social_networks (`social`). The files derived from it are the `ut1-*.bin` files; they are CC BY-SA 4.0, and `LICENSE-UT1.txt` ships next to them. They contain 32-bit hash prefixes, not the domain names. The licence version is unverified on the licensor's own site (see `_specs/v2-m2-child.md`, Open Questions).
- **The Block List Project** (Unlicense; some file headers say MIT), at the commit pinned in `scripts/category-lists/sources.json`. Categories used: porn (`adult`), gambling, drugs, and facebook, tiktok and twitter (`social`). The upstream rights of the lists it aggregates are unverified.
- `scripts/category-lists/self-harm.txt` is written by the Neo project (MIT) and is empty.
- The well-known-domain lists in `apps/extension/lib/policy/topDomains.ts` and `apps/extension/lib/detectors/payment.ts` are written by the Neo project (MIT).

The extension credits both sources on its options page ("About and credits").
