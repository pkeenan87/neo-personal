# Phase 1 — Email and SMS analysis

Status: planned 2026-09-25. Parent plan: `phase-0-and-roadmap.md` §5 (Phase 1) and §2.1–2.2, 2.6. Exit criterion: **the core value proposition works on every mail provider without OAuth.**

## What Phase 1 delivers

| # | Deliverable | Spec | Package(s) |
|---|---|---|---|
| 1 | Email analyzer tool `analyze_email`: MIME parse, header authentication (SPF/DKIM/DMARC), From/Return-Path/Reply-To divergence, display-name and lookalike sender checks, URL extraction feeding `analyzeUrl`, attachment triage (type/extension mismatch, dangerous types, VirusTotal hash lookup), content lure signals | `_specs/email-analysis.md` | `@neo/tools` |
| 2 | SMS analyzer tool `analyze_sms`: sender classification (short code / 10-digit / email-to-SMS / international), lure templates, callback numbers, URLs through the URL pipeline | `_specs/sms-analysis.md` | `@neo/tools` |
| 3 | Intake: paste, `.eml` upload, screenshot upload (vision) for email and SMS in the chat composer; artifacts stored encrypted in Vercel Blob with 30-day retention | `_specs/intake.md` | `apps/web`, `@neo/db` |
| 4 | Forward-to-address: per-tenant `check-<token>@<inbound domain>`, Resend inbound webhook → Inngest job → Sonnet 5 triage (structured output into `Verdict`) → verdict stored → notification email to the forwarder; onboarding pages for Gmail, iCloud, Outlook.com, Yahoo forwarding rules | `_specs/forward-to-address.md` | `apps/web`, `@neo/db`, `@neo/core` (triage helper) |
| 5 | History and dashboard v1: `/dashboard` with verdict list, counts by label and subject type, top indicators, filter by member; verdict detail linking back to its conversation | `_specs/dashboard.md` | `apps/web`, `@neo/db` |
| 6 | Incident playbooks: `clicked_link`, `entered_password`, `sent_gift_cards`, `shared_code`, `paid_scammer` as system-prompt skills the agent applies with `effort: "high"`; entry points on the dashboard and empty state | `_specs/incident-playbooks.md` | `apps/web` |
| 7 | Carried from Phase 0: usage indicator in the chat header, warn-once log for invalid cap env values, `email_verified` mapped from Google, click-to-confirm page for magic links, sign-out-everywhere | (in the relevant specs) | `apps/web` |

Not in Phase 1 (deferred, see roadmap): mobile app, QR decoding, Outlook connector, sign-in-alert parser (Phase 2), extension and desktop (Phase 3), HIBP, paid tier.

## Decisions taken for Phase 1

| Decision | Choice | Why |
|---|---|---|
| MIME parser | `postal-mime` | Pure JS, no Node stream dependency, works in tests and on Vercel; handles nested multipart, encoded words, inline images. |
| Header authentication | Parse existing `Authentication-Results` / `Received-SPF` / `DKIM-Signature` / `ARC-Authentication-Results` headers written by the receiving provider. **No live DNS SPF/DKIM verification.** | The user's provider already evaluated the message on receipt; a forwarded copy breaks SPF anyway. Absent headers are reported as absent, not as failures. |
| Inbound email | Resend (Vercel Marketplace `resend/resend-email`) | Also does magic links and notifications, one vendor, free tier. Webhook signatures verified with Svix (`svix` package) using `RESEND_WEBHOOK_SECRET`. |
| Background jobs | Inngest (Vercel Marketplace `inngest/account`) | Decided in Phase 0. Functions live under `apps/web/app/api/inngest/route.ts`. Local dev uses the Inngest dev server; `MOCK_MODE` runs the job inline. |
| Triage model | `claude-sonnet-5`, `output_config.effort: "low"`, structured output (`output_config.format` with `verdictJsonSchema`) | Forwarded mail is bulk. A tenant can ask for a deeper Opus review from the notification link, which opens a chat seeded with the artifact. |
| Raw artifact storage | Vercel Blob (private store), envelope-encrypted with a per-tenant data key wrapped by `NEO_MASTER_KEY` (AES-256-GCM); 30-day retention via a daily Inngest cron | Plan §3. Blob is private-by-default and OIDC-authenticated on new stores; encryption is defense in depth against a leaked blob URL. |
| Screenshot intake | Send the image to the chat model as an `image` content block; the model transcribes and analyzes. Extracted URLs still go through `check_url`. | No OCR dependency; the Opus 5 vision path is the same model doing the analysis. Max 5 images, 5 MB each, JPEG/PNG/WebP/GIF. |
| `.eml` intake | Uploaded through `POST /api/artifacts` (multipart) → parsed server-side → the chat turn carries an `artifact_ref`, and the agent calls `analyze_email` with that ref | Raw MIME never enters the model directly; only the analyzer's structured result does, through `wrapToolResult`. |
| Usage accounting | Each forwarded message triage counts as one `check` against the tenant's monthly cap; over-cap messages are stored as `insufficient_evidence` with reason `usage_cap` and the notification says so | Caps are the only spend control at launch. |
| Notification email | One email per forwarded message: headline, verdict, top 3 indicators, actions, link to the verdict page. Sent to the address that forwarded it, only if it belongs to a member of the tenant. | Unknown forwarders get no reply (no backscatter). |
| Inbound address format | `check-<12 base32 chars>@<NEO_INBOUND_DOMAIN>`, one active address per tenant, rotatable from settings | Long enough that guessing is impractical; rotation handles leaks. |

## Sequencing and parallel work

Five build agents run in parallel worktrees, then one integration agent, as in Phase 0. Contracts first: `docs/contracts.md` gains the Phase 1 section before any agent starts.

| Agent | Owns | Depends on |
|---|---|---|
| A. tools-email | `packages/tools`: `analyze_email`, `analyze_sms`, `parseEmail`, header auth, attachment triage, fixtures, mock mode, `EMAIL_ANALYSIS_GUIDANCE`, `SMS_ANALYSIS_GUIDANCE` | Phase 0 `analyzeUrl` |
| B. db-artifacts | `packages/db`: migrations `0003_phase1` (inbound_addresses, artifacts changes, verdicts.source/artifact_id, notifications), `createArtifactStore`, `inboundAddresses`, `verdicts` query helpers for the dashboard, RLS for new tables; `packages/core`: `encryptArtifact`/`decryptArtifact`, `runTriage` (Sonnet structured output) | Phase 0 schema |
| C. web-intake | `apps/web`: composer attachments, `POST /api/artifacts`, image blocks in `/api/agent`, `.eml` flow, `artifact_ref` in messages, `ArtifactChip`, usage indicator in header | Contracts for artifacts API |
| D. web-inbound | `apps/web`: `/api/inbound/resend` webhook, Inngest client and functions (`email/received`, `artifacts/expire`), notification email template, `/settings/forwarding` page with onboarding guides, `/verdicts/[id]` page | B's interfaces (built against the contract; integration agent wires real implementations) |
| E. web-dashboard | `apps/web`: `/dashboard`, `/api/verdicts`, verdict detail, incident playbooks in the system prompt, effort escalation, empty-state entry points, `docs/self-hosting.md` update | B's dashboard query contract |

Integration agent: merge, single `pnpm install`, wire C/D/E to A/B's real exports, update `docs/contracts.md` "Shipped additions", `.env.example`, `CHECKLIST.md`, run the full pipeline, open PRs.

## Owner prerequisites (CHECKLIST.md §9)

Code ships fully testable in `MOCK_MODE`. Going live needs: a domain (inbound subdomain MX to Resend), the Resend and Inngest marketplace installs (terms acceptance is the owner's), a Vercel Blob store, `NEO_MASTER_KEY`, `RESEND_WEBHOOK_SECRET`, `NEO_INBOUND_DOMAIN`, then migration `0003`.

## Risks

- **Forwarded mail loses evidence.** Gmail "forward" rewrites the message; only "forward as attachment" (or a filter-based auto-forward, which preserves headers) keeps the original. Onboarding guides say which to use per provider, and the analyzer reports when it is looking at a forwarded wrapper rather than the original.
- **Backscatter and abuse of the inbound address.** Only mail to a valid active address is processed; everything else is dropped silently. Per-address rate limit of 30 messages/hour; Inngest concurrency 5 per tenant.
- **Vision cost.** A 5 MB screenshot is roughly 1.5K tokens at Opus 5 after resizing; five images stay under a cent of input. Images are downscaled client-side to max 1568 px on the long edge before upload.
- **Attachment handling.** Attachments are never opened or executed. Triage uses declared type, magic bytes, name, size, and SHA-256 lookups only. Archives are not unpacked in Phase 1.
