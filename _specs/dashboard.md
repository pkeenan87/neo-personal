# Spec for Dashboard and history v1

branch: claude/feature/dashboard

## Summary

`/dashboard` is the home page after sign-in: what Neo has checked for this household, how risky it was, and what to do next. It reads only the `verdicts` table plus usage. Verdict detail pages `/verdicts/[id]` show the full card, indicators, IOCs, actions, the evidence artifact (download), and a link to the originating conversation or inbound message. Household owners see every member's verdicts; members see their own (role from the session).

## Functional requirements

### Queries (`@neo/db`)

```ts
export const verdictQueries: {
  list(db, tenantId, opts: { userId?: string; label?: VerdictLabel; subjectType?: VerdictSubjectType; source?: "chat" | "inbound" | "api"; cursor?: string; limit?: number /* ≤ 50 */ }): Promise<{ items: VerdictRow[]; nextCursor?: string }>;   // cursor = base64(created_at|id)
  get(db, tenantId, id): Promise<VerdictRow | undefined>;
  summary(db, tenantId, opts: { userId?: string; sinceDays: 7 | 30 | 90 }): Promise<{
    total: number; byLabel: Record<VerdictLabel, number>; bySubjectType: Record<VerdictSubjectType, number>;
    topIndicators: { category: string; count: number }[];    // from body->'indicators', top 8
    topDomains: { domain: string; count: number }[];          // from body->'iocs'->'domains', top 8, excluding likely_safe verdicts
    perDay: { day: string; malicious: number; suspicious: number; likely_safe: number; insufficient_evidence: number }[];
  }>;
};
```
Members (role `member`) are always constrained to `userId = session.userId`; owners may pass any member's id or none. Enforce in the route, and add a `memberships`-based check.

### API (`apps/web`)

- `GET /api/verdicts?label&subjectType&source&userId&cursor&limit` → `{ items: [{ id, subjectType, verdict, confidence, headline, source, createdAt, userId, conversationId, artifactId }], nextCursor }`.
- `GET /api/verdicts/[id]` → full row including `body` (the `Verdict`), plus `conversation: { id, title } | null`, `artifact: { id, kind, filename, sizeBytes, expiresAt } | null`, `inbound: { status, receivedAt } | null`.
- `GET /api/verdicts/summary?sinceDays&userId` → summary above.
- `DELETE /api/verdicts/[id]` → 204 (owner, or the member who owns it); also deletes the linked artifact. Audit event `verdict.deleted`.
- `GET /api/household` → `{ tenantId, name, role, members: [{ userId, name, email, role }] }` (owner sees emails; members see names only).

### Pages

- `/dashboard` (server component shell, client widgets fetching the APIs): header with household name, member filter (owner), range 7/30/90; stat tiles (checked, malicious, suspicious, safe); "needs attention" list = malicious/suspicious in range, newest first, each row → detail; charts: per-day stacked bars and top indicators (simple SVG bars, no chart library); top targeted brands/domains; recent activity list with cursor "load more"; usage tile (checks used / limit, tokens today) from `/api/usage`; quick actions: "Check something" (→ `/chat`), "I clicked a link / entered a password" (→ `/chat?playbook=clicked_link` etc., see `incident-playbooks.md`), "Set up email forwarding" (→ `/settings/forwarding`, with a done state when an address exists and has been used).
- `/verdicts/[id]`: `VerdictCard` (reuse), indicator table with severity chips, actions checklist (client-side check-off, persisted in `localStorage` only), IOCs with copy buttons and a "Check this URL again" action per URL, evidence section (artifact download / inline image / "raw email" download for `.eml`, with expiry date), origin ("From conversation …" link or "Forwarded by … on …"), a "Ask Neo about this" button that opens `/chat?verdict=<id>` seeding a message "Tell me more about verdict <headline>" with the verdict JSON added as a hidden text block by the server (loaded from the DB, not from the client).
- Empty state on `/dashboard` for a new household: three cards (check a link, upload an email/screenshot, set up forwarding).
- Navigation: sidebar/top nav gains Dashboard, Chat, Settings; `/` redirects signed-in users to `/dashboard`.

### Performance and limits

- Summary query uses the existing `verdicts_tenant_created_idx`; JSONB aggregation over ≤ 90 days per tenant is fine at household scale. Cap `list` at 50.
- All pages `dynamic = "force-dynamic"`, `Cache-Control: no-store` on APIs (already global).

## Possible Edge Cases

- Verdict whose conversation was deleted: `conversationId` null (FK set null); detail still renders.
- Artifact expired: evidence section says so.
- Member filter for a user removed from the household: 404.
- Thousands of verdicts (power user): cursor pagination, no offset.
- Non-owner tries `userId` of another member: 403 `forbidden`.

## Acceptance Criteria

- Owner sees all members' verdicts; member sees only their own (route test with two sessions).
- Summary counts match seeded rows; `topIndicators` aggregates categories across bodies.
- Detail page renders every verdict fixture from Phase 0 tests plus inbound and artifact-linked ones.
- Delete removes verdict and artifact, writes audit event, 404 afterwards.
- Lighthouse-ish sanity: dashboard renders with zero verdicts and with 200.

## Open Questions

- Weekly digest email is Phase 3; the summary query is designed so the digest can reuse it.

## Testing Guidelines
- `packages/db/test/verdict-queries.test.ts`: list filters and cursor, summary aggregation, tenant isolation.
- `apps/web/test/verdicts-routes.test.ts`: role enforcement, pagination, delete cascade to artifact, 403/404 paths.
- `apps/web/test/dashboard.test.tsx`: renders empty state and populated state from mocked fetch; member filter hidden for members.
- `apps/web/test/verdict-detail.test.tsx`: sections render/hide per available data; "Ask Neo" link.
