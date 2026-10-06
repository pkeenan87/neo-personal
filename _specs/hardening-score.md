# Spec for account-hardening checklist and score

branch: `hermes/feature/hardening-score`
plan: `_plans/deferred-roadmap-items.md`, step 3
status: owner-approved; implemented (migration 0014). Help links re-checked 2026-10-05: all HTTP 200 except transunion.com (403 to non-browser clients)

## Summary

Give each signed-in person a fixed, versioned, deterministic account-hardening checklist. The current user's dashboard card shows a weighted percentage and up to three next actions; `/settings/hardening` shows that user's full checklist. Answers are self-attestations, not provider verification. Neo-derived items use only tenant-scoped forwarding and device data. No model, provider scraping, credentials, or third-party scoring is involved.

The owner may see each current member's percentage only, or “not enough answers”; no open-item count, item-level status, answer, or incomplete-data flag is exposed.

## Functional requirements

### Checklist and item semantics

- The checklist manifest is immutable and versioned in code. It contains stable item IDs, source, exact completion rule, weight, action text, an explicit list of compatible prior answer versions, and a static allowlist of first-party help links. The scoring function is pure deterministic code; it does not call or depend on a model.
- Ship `account-hardening-v1` only (10 items, no breach item). Add v2 with `no_unresolved_breach` only after roadmap step 2 merges and its evidence contract is available; activating a later version is an explicit release change, never automatic.
- Seven items are self-attested. Their answers are stored per user; Neo does not verify them with the provider. The three v1 Neo-data items are calculated from Neo's records. `not_applicable` is allowed for `credit_freeze` outside the US or without a credit file, `carrier_port_out_pin` without a mobile line, and `desktop_agent_enrolled` on Linux or Chromebook.

| Stable item ID | Source | Completion rule |
|---|---|---|
| `primary_email_2fa` | Self-attested | The user says two-factor authentication is enabled on their primary email account. |
| `passkey_or_hardware_key` | Self-attested | The user says at least one passkey or physical FIDO security key is registered on their primary email account. |
| `recovery_contacts_current` | Self-attested | The user says the recovery phone and recovery email for their primary email account are current and accessible; when that provider does not offer one of those methods, its supported recovery methods must be current. |
| `password_manager` | Self-attested | The user says they use a password manager for unique passwords on their primary email and other important accounts. Neo does not inspect the manager or passwords. |
| `carrier_port_out_pin` | Self-attested | The user says an account PIN, port-out lock, or equivalent carrier protection is enabled for every mobile number they use. N/A when the user has no mobile line. Never collect the PIN itself. |
| `credit_freeze` | Self-attested | The user says a security freeze is active with Equifax, Experian, and TransUnion. A paid credit lock is not a freeze. N/A outside the US or when the user has no credit file. |
| `os_browser_auto_update` | Self-attested | The user says automatic security updates are enabled for every supported operating system and browser they regularly use (or are enforced by an equivalent managed policy). |
| `forwarding_used_30d` | Neo data | Complete when an inbound message attributed to this user by `inbound_messages.forwarder_user_id` has `received_at` in the rolling 30 days ending at `asOf`. Count an attributed forward whatever its status (including a failed analysis) except `rejected`, which Neo refused to process; do not credit another member's forward. If no attributed row exists in the last 30 days, state is `needs_action`, including while an unattributed row is stuck. A row attributed to this user becomes silent/out of window after 30 days. Do not use household-wide `inbound_addresses.last_used_at`. |
| `browser_extension_enrolled` | Neo data | Complete when this user has at least one non-revoked `devices` row with `kind = 'browser_extension'` in the session tenant. An offline device still counts as enrolled; the UI must not imply that it is currently checking in. |
| `desktop_agent_enrolled` | Neo data | Complete when this user has at least one non-revoked `devices` row with `kind = 'desktop_agent'` in the session tenant. N/A on Linux or Chromebook. An offline device still counts as enrolled. |

### Official help links

Every self-attested item has one or more fixed, direct HTTPS links to the relevant provider's own help/support page, with one link per provider where possible. Links are advisory: Neo does not fetch, scrape, proxy, or summarize them. Do not accept a URL from a user, model, email, API response, or redirect service; do not substitute third-party blogs or search results. The account/carrier/OS/browser provider is not stored. Link labels name the provider, links open directly to that provider, and the UI uses `rel="noopener noreferrer"` when opening a new tab. When no curated official link exists for a provider, show the item's general instructions without an external href rather than inventing one.

Seed links found on first-party support sites on 2026-10-04; re-check each URL and its official status before implementation and record the check date. This is a seed catalog, not an exhaustive promise of provider coverage.

| Item | Official provider help links (examples) |
|---|---|
| Primary email 2FA | [Google Account Help](https://support.google.com/accounts/answer/185839); [Microsoft Support](https://support.microsoft.com/en-us/accounts-billing/security/how-to-use-two-step-verification-with-your-microsoft-account); [Apple Support](https://support.apple.com/en-us/102660) |
| Passkey or hardware key | [Google Account Help: passkeys](https://support.google.com/accounts/answer/13548313); [Microsoft Support: passkeys](https://support.microsoft.com/en-us/accounts-billing/security/create-save-passkey); [Apple Support: security keys](https://support.apple.com/en-us/102637) |
| Recovery phone/email | [Google Account Help](https://support.google.com/accounts/answer/183723); [Microsoft Support](https://support.microsoft.com/en-us/accounts-billing/manage/microsoft-account-security-info-verification-codes); [Apple Support](https://support.apple.com/en-us/102641) |
| Password manager | [Google Password Manager](https://support.google.com/chrome/answer/95606); [Microsoft Password Manager](https://support.microsoft.com/en-us/accounts-billing/manage/view-or-edit-your-passwords-in-microsoft-password-manager); [Apple Passwords](https://support.apple.com/en-us/120758) |
| Carrier port-out protection | [Verizon Support](https://www.verizon.com/support/port-out-faqs/); [T-Mobile Support](https://www.t-mobile.com/support/plans-features/help-with-t-mobile-account-fraud); [AT&T Support](https://www.att.com/support/article/wireless/KM1447526/) |
| Credit freeze | [Equifax](https://www.equifax.com/personal/credit-report-services/credit-freeze/); [Experian](https://www.experian.com/help/credit-freeze); [TransUnion](https://www.transunion.com/credit-freeze/credit-freeze-faq) |
| OS/browser auto-update | [Windows Update](https://support.microsoft.com/en-us/windows/deployment/updates-lifecycle/windows-update-faq); [macOS updates](https://support.apple.com/guide/mac-help/software-update-settings-on-mac-mchla7037245/mac); [Chrome updates](https://support.google.com/chrome/answer/95414); [Edge updates](https://support.microsoft.com/en-us/edge/microsoft-edge-update-settings); [Firefox updates](https://support.mozilla.org/en-US/kb/managing-firefox-updates) |

### Deterministic v1 weights

The v1 weights sum to 100 points. A `complete` item earns its whole weight; other known states earn zero. A shipped version's item set, criteria, weights, status rules, actions, and links are immutable; changes require a new version.

| Item | v1 weight |
|---|---:|
| `primary_email_2fa` | 15 |
| `passkey_or_hardware_key` | 15 |
| `password_manager` | 15 |
| `recovery_contacts_current` | 10 |
| `carrier_port_out_pin` | 10 |
| `credit_freeze` | 10 |
| `os_browser_auto_update` | 10 |
| `forwarding_used_30d` | 5 |
| `browser_extension_enrolled` | 5 |
| `desktop_agent_enrolled` | 5 |
| **Total** | **100** |

### Scoring, answers, and version changes

- Score states are `complete`, `needs_action`, `unanswered`, `stale`, `unknown`, and `not_applicable`. N/A is an explicit user response only for the three documented eligibility exceptions; it cannot override a Neo-data result except for the documented Linux/Chromebook desktop-agent exemption.
  - A fresh self-attested `true` answer is `complete`; fresh `false` is `needs_action`.
  - No answer is `unanswered`. An answer is `stale` when `answered_at <= asOf - 180 * 24 hours` (exactly 180 days is stale). Stale answers earn zero points and must be explicitly re-confirmed; rendering or opening Settings never refreshes `answered_at`.
  - A known detected signal maps to `complete` or `needs_action`; a signal that cannot be evaluated is `unknown`.
- N/A items are removed from the denominator. A `not_applicable` self-attestation, including `desktop_agent_enrolled` on Linux/Chromebook, becomes stale on the same 180-day boundary as any other answer and must be reconfirmed. `unknown` items do not blank the score: calculate earned weight divided by the total weight of known, non-N/A items, rounded to an integer, and flag the result as partial. Show “not enough answers” until at least 3 self-attested items have a fresh answer (`complete`, `needs_action` or `not_applicable`; a `stale` answer does not count); otherwise show the score. Unanswered and stale items are known incomplete states, earn zero, and remain in the denominator.
- The personal checklist distinguishes unknown and N/A items from actionable items. `nextActions` contains only actionable `needs_action`, `unanswered`, or `stale` items; sort by weight descending, then stable item ID ascending, and return at most three.
- Each self-attested answer stores `{ tenantId, userId, itemId, value: boolean | not_applicable, checklistVersion, answeredAt }`. The POST body includes `checklistVersion`; if it does not match the current manifest, return 409 `checklist_version_mismatch` without mutating the answer. `answeredAt` is set by the server on explicit answer or re-confirmation, never accepted from the client. Answering `false` is different from leaving an item unanswered. N/A is accepted only for `credit_freeze`, `carrier_port_out_pin`, and `desktop_agent_enrolled` when their stated circumstance applies. Users can clear an answer, returning the item to unanswered. Writing an answer when the session user has no membership row returns 403 `forbidden` (not 503).
- A new version does not silently refresh answers. The new manifest must explicitly list compatible prior versions for each unchanged self-attested item. A compatible answer is carried forward with its original `answeredAt`, `value`, and `checklistVersion`; it still becomes stale at the original 180-day deadline. New or semantically changed self-attested items are `unanswered` (not `unknown`). Never infer compatibility from a similar title. Detected items are re-evaluated from current Neo data. Recalculate under the new version's weights and denominator after excluding N/A items.
- A database/store error that prevents reading required answers or detected signals returns 503 `storage_unavailable`, not a cached score. The in-memory store must match DB semantics. A missing device or forwarding record in a working store is known `needs_action`, not an error.

### Roles, privacy, and UI

- The personal route always resolves the subject from the session. It accepts no `userId` selector. A member sees and edits only their own answers. An owner sees and edits their own checklist through the same personal route.
- The owner summary is limited to current member percentage only, or “not enough answers”; no open count, `incomplete_data`, or item detail. Implement `loadHouseholdHardeningPercents(session)` for the owner dashboard; a member calling it gets 403. Personal route remains session-subject scoped.
- `/dashboard`: current-user card with percentage, next actions, and link to `/settings/hardening`; show “not enough answers” when fewer than 3 self-attested items have a fresh answer. Owners see only the permitted percentage summary for other members.
- `/settings/hardening`: the current user's full checklist, current status, last self-attested answer date, weight, action, and official help links. Clearly label self-attestations as “You told Neo”; do not call them verified. Show unknown detected items as data unavailable, not as complete or failed. The owner does not get a switcher or route to open a member's checklist.
- No monitoring/device token can read or mutate this data. Mutations require a browser session. Reads require normal full API scope.
- The answer is personal data. The future implementation PR must update `apps/web/app/privacy/page.tsx` and `apps/web/test/privacy-page.test.tsx` per `CLAUDE.md`; this docs-only task must not change either file.

## Possible Edge Cases

- A member forwards an email, but later analysis fails: the forwarding item still counts because Neo attributed the sender to that member.
- Another household member uses the shared forwarding address: it cannot satisfy the current user's item.
- A device is enrolled but offline: it still satisfies the enrolled item and must be labeled offline elsewhere rather than described as active protection.
- A member has no enrolled devices or no attributed forward in a working store: those are known open items.
- An answer reaches exactly 180 days old: it is stale, contributes zero, and appears as an action to re-confirm.
- A new checklist version adds an item: unchanged compatible answers retain their original `answeredAt`; a new self-attested item is `unanswered` and the score uses the new fixed weights.
- A help URL breaks or a provider changes its page: replace only with a re-verified first-party URL in a new immutable manifest version; never route through Neo or use a third-party replacement.
- A member joins a new household: delete that user's previous household answers; removal/leaving also cascades answer rows. The database and in-memory stores behave identically.
- An unattributed forwarding row is stuck: the forwarding item remains `needs_action`; after 30 silent days with no attributed row it is still `needs_action`.
- The owner attempts to load a member's personal endpoint, or a member guesses another user's ID: the session remains the only subject selector; no member answer is returned.
- A v2 breach item is not added until roadmap step 2 merges.

## Acceptance Criteria

- [ ] The approved active checklist is a fixed versioned manifest with deterministic criteria, integer weights totaling 100, and no model calls.
- [ ] The seven self-attested and three v1 detected items match the definitions above; no breach item ships in v1.
- [ ] Every self-attested item's external help links are direct first-party HTTPS support pages from a curated allowlist; no scraping or user-supplied links.
- [ ] A true answer earns its weight only while fresh; false, unanswered, stale, and needs-action items earn zero. A 180-day boundary test proves the exact stale rule; N/A removes an item from the denominator.
- [ ] N/A items leave the denominator and age out after 180 days; unknown items yield a partial score over known items rather than blanking it. Fewer than 3 freshly answered self-attested items displays “not enough answers”; otherwise unanswered items count as zero in the score.
- [ ] A new version reuses only explicitly compatible answers without changing their original timestamp/version; new or changed items need a new answer.
- [ ] The current user's dashboard card and full Settings checklist show only their own item details.
- [ ] Owner view exposes only percentage or “not enough answers”; `loadHouseholdHardeningPercents(session)` is owner-only and a member receives 403; no open count or `incomplete_data` field is serialized.
- [ ] Database tests exercise tenant scoping/RLS as `app_user`; leaving/removal cascades the answer rows.
- [ ] A submitted checklist version mismatch returns 409 `checklist_version_mismatch`. Implementation updates the privacy page and its test in the same PR. This spec-only commit creates neither implementation nor migration.

## Implementation notes

- Migration number is the next free number at implementation time. The answer table uses `tenant_isolation` RLS, `tenantTables`, and explicit `app_user` CRUD grants.
- N/A is available only for the defined credit-freeze, carrier-PIN, and desktop-agent circumstances; N/A contributes neither points nor denominator weight.
- In-memory store behavior must match database behavior, including household-join answer deletion and forwarding's 30-day transition.

## Testing Guidelines

- `packages/core/test/account-hardening.test.ts`: exact v1 manifest/weight sum; N/A denominator exclusion; partial score with unknown items; no-known-answers state; unanswered, false, stale at/after 180 days; household join deletion; forwarding 30-day cutoff; stable top-three ordering; no model dependency.
- `packages/db/test/account-hardening.test.ts` (PGlite as `app_user`): per-user upsert/clear, `answered_at` and version persistence, tenant isolation/RLS, forwarding attribution and 30-day cutoff, active versus revoked devices, membership-cascade deletion.
- `apps/web/test/hardening-score.test.ts`: session-only subject selection, owner/member separation, browser-only mutation, invalid item/value/version, 409 `checklist_version_mismatch`, 403 member and device-token paths, fewer-than-three/partial score behavior and storage failures; owner serialization has percentage only and no item/answer fields.
- `apps/web/test/hardening-score.test.tsx`: dashboard ready/incomplete/empty states, exactly the next three ordered actions, full self-only Settings checklist, stale/unanswered labels, first-party links, no member answer switcher or item detail for owners.
- Update `apps/web/test/privacy-page.test.tsx` in the future implementation PR to cover the added personal-data disclosure; do not edit it in this spec-only task.
