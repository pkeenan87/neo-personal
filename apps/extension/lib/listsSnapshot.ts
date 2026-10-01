/**
 * The build-time snapshot of `detectionLists()` (`scripts/build-lists-snapshot.mjs`), used as the
 * first-run and offline fallback until `GET /api/signals/lists` succeeds at least once
 * (`_specs/browser-extension.md` "Background", "Possible Edge Cases": "The skip list is stale on
 * first run"). Plain JSON data, never code — safe to bundle and safe to trust as much as any other
 * server-supplied list.
 */
import snapshot from "./data/lists-snapshot.json" with { type: "json" };
import type { DetectionListsPayload } from "@neo/tools/browser";

export const listsSnapshot: DetectionListsPayload = snapshot as DetectionListsPayload;
