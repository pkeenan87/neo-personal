# Spec for v2-followups

branch: one per slice (below)
plan: `_plans/v2.md`; follow-ups recorded at the end of the overnight run (2026-11-04)
status: in progress, 2026-11-04

## Summary

The overnight v2 run (M2 to M4, PRs #78 to #91) left six follow-ups. This spec covers the four that can be built without the owner. Claude writes each slice's exact changes here. The local model (Qwen) implements them, and Claude reviews every line and runs the full pipeline before committing.

The other two:
- **Desktop rollback check:** already in place. `apps/desktop/crates/agent-service/src/agent/child.rs` ignores a signed bundle whose `issuedAt` is older than the applied one. Test: `an_older_bundle_does_not_replace_a_newer_one`. The desktop deliberately doesn't report tamper for a stale bundle. The extension does (sync.ts); the two are allowed to differ, because a stale bundle alone isn't an attack.
- **`self_harm` category list:** still blocked. No list exists whose licence allows redistribution.

## Functional requirements

### Slice A: `eve build` in CI (`claude/ci/eve-build`)
- In `.github/workflows/ci.yml`, job `checks`, add a step after "Typecheck, lint, test, build": `pnpm --filter @neo/web exec eve build`. Turbo has already built the packages' `dist`, which the eve bundle imports. Locally, a stale `packages/db/dist` made `eve build` fail with `MISSING_EXPORT`, which is exactly the failure CI should catch.
- No secrets; it runs with the job's `MOCK_MODE=true`.

### Slice B: heartbeat `extensionEnrolled` (`claude/feature/heartbeat-extension-enrolled`)
The desktop agent already reads `extensionEnrolled` from the heartbeat and reports `tamper_detected { reason: "browser_without_extension" }` on `false`, as `docs/contracts.md` describes. The server never sends it. This slice adds it.
- `apps/web/lib/household-types.ts` `HeartbeatResponse`: add `extensionEnrolled?: boolean`, with a comment pointing to this spec.
- `apps/web/lib/server/device-enrollment.ts` `heartbeat()`: after `recordHeartbeat` returns `device`:
  - Only when `device.kind === "desktop_agent"` and `device.memberId` is set: call `listDevices(session.tenantId, { memberId: device.memberId })`. It is tenant-scoped and lists active (not revoked) devices only. `extensionEnrolled` is whether any of them has `kind === "browser_extension"`.
  - Spread it into the response only in that case (`...(enrolled !== undefined ? { extensionEnrolled: enrolled } : {})`).
  - If the lookup throws, omit the field and log through `logger.error`, as `currentPolicyInfo` does. A failure must not fail the check-in.
  - The tenant comes from the device session, never from the request body.
- Extension heartbeats never carry the field.
- `docs/contracts.md`: change the "not sent by any server yet" note to say the server sends it for desktop agents with a member, and add a v2 changelog line.

### Slice C: timed purges for the rest of the household data (`claude/feature/retention-purges`)
New migration `0031_retention_purges`. It contains functions only and makes no schema change. It adds one `SECURITY DEFINER` function, `purge_old_household_records(p_now timestamptz) RETURNS TABLE (kind text, n integer)`, in the style of `purge_old_child_requests` and `retention_preview` (0030):
- `SET search_path = pg_catalog, public`;
- `REVOKE ALL … FROM PUBLIC`;
- `GRANT EXECUTE … TO app_user` inside the same `DO` block as 0030.

It deletes across households and returns one row per kind:

| kind | table | deleted when |
|---|---|---|
| `outbox` | `notification_outbox` | `created_at < p_now - 30 days` and finished (`sent_at is not null` or `attempts >= 5`, the outbox's max attempts), or `created_at < p_now - 90 days` whatever its state |
| `invites` | `household_invites` | `coalesce(accepted_at, revoked_at, expires_at) < p_now - 30 days` |
| `device_commands` | `device_commands` | `expires_at < p_now - 30 days` and (`completed_at is null` or `completed_at < p_now - 30 days`) |
| `eve_sessions` | `eve_sessions` | `created_at < p_now - 90 days`. The table has no last-used column, so a chat older than 90 days can no longer be continued, because the owner check fails closed |
| `usage_events` | `usage_events` | `created_at < p_now - 400 days`. The spend cap reads only the current month, and 13 months keeps a year-over-year view |

Not purged, by decision:
- `consents`: proof that notice and consent were given; it must outlive the monitoring.
- `audit_events`: the record of who changed what.
- Both are under Open Questions.

Code:
- `packages/db/src/retention.ts`:
  - `export interface HouseholdRecordsPurged { outbox; invites; deviceCommands; eveSessions; usageEvents }` (numbers);
  - `export async function purgeOldHouseholdRecords(db, now = new Date())`, which parses the rows as `previewRetention` does;
  - export both from `packages/db/src/index.ts`.
- `apps/web/lib/server/inbound/artifacts-expire-job.ts`:
  - optional dep `purgeOldHouseholdRecords?(): Promise<number>`, the total;
  - step `purge-household-records` after `purge-household-memory`;
  - result field `householdRecordsPurged?`.
- `apps/web/lib/server/inbound/deps.ts`: wire it like `purgeExpiredMemory`. With no database it returns 0. If the call throws, it logs `logger.warn("Household records purge failed", "retention", …)` and returns 0, so a database without migration 0031 doesn't break retention. It logs the per-kind counts with `logger.info`.
- `apps/web/lib/server/schedules/jobs/retention.ts`: add `"household_records"` to `RETENTION_PURGES`.
- The privacy page and `SECURITY.md` state the new periods.

**Deployment:** the code is safe to merge before the migration (it logs a warning and returns 0). Until the migration runs on production, nothing is purged.

### Slice D: eve chat attachments (`claude/feature/eve-chat-attachments`)
`/chat-v2` gets the old chat's attachments: an `.eml` file or a screenshot.
- The client reuses the old chat's attachment picker and limits.
- The server stores the upload through the same artifact path as the old chat (encrypted, tenant-scoped, retention-expired). It passes only the artifact id into the eve session.
- The tool that reads it returns the content through `wrapToolResult`.
- Exact files are filled in when the slice starts.

## Possible Edge Cases
- **Heartbeat:**
  - A desktop agent whose member was deleted is revoked by the `devices_member_check` constraint, so it gets a 401 first.
  - A member with only a revoked extension gets `false`.
- **Purges:** a session used within the 90 days survives, and the age is counted from its last use.

## Acceptance Criteria
- CI fails if the eve agent bundle doesn't build.
- **Heartbeat:**
  - A desktop agent whose member has an active extension gets `extensionEnrolled: true`.
  - With no extension, or only a revoked one, it gets `false`.
  - An extension in another household doesn't count.
  - Extension heartbeats don't carry the field.
- **Purges:** `purge_old_household_records` deletes only rows past each rule, keeps the rest, returns per-kind counts, and is callable by the app role. Both runners plan `household_records`.

## Open Questions
- **Consents and audit log retention:** kept indefinitely for now, as the safer option for proving consent and accountability. If owners need deletion, add per-household settings with a floor (for example, a consent kept at least a year after monitoring ends).
- **Purge periods:** the fixed 30 and 90 days could become settings later. They are not household content, so they are fixed for now.

## Testing Guidelines
- **Slice B:** add to `apps/web/test/device-enrollment.test.ts`:
  - desktop agent with the member's extension enrolled → `true`;
  - without one → `false`;
  - after the extension is removed → `false`;
  - an extension enrolled for another member → `false`;
  - the extension's own heartbeat has no `extensionEnrolled`.
- **Slice C:** in `packages/db/test/household-records-purge.test.ts` (PGlite, app role), for each kind seed one row past the rule and one inside it (rows inserted as the migration owner), call `purgeOldHouseholdRecords` as `app_user`, and check the counts and the survivors. The job-plan test includes `household_records`.
