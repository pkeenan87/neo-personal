# Spec for Intake (paste, .eml upload, screenshots) and artifacts

branch: claude/feature/intake

## Summary

Users bring evidence three ways: paste text, upload a `.eml`, or upload screenshots (email or SMS). All three land in the existing chat. Files become **artifacts**: encrypted at rest in Vercel Blob, referenced by id, tenant-scoped, expiring after 30 days. The model sees images directly (vision) and sees `.eml` files only through the `analyze_email` tool result. Raw bytes never enter the model.

## Functional requirements

### Artifact storage (`@neo/db` + `@neo/core`)

`@neo/core` (pure crypto, no I/O):
```ts
export function deriveTenantKey(masterKey: Uint8Array, tenantId: string): Uint8Array;           // HKDF-SHA256, info "neo-artifact-v1:<tenantId>"
export function encryptArtifact(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array; // AES-256-GCM, 12-byte random IV, layout: magic "NEO1" | iv | ciphertext | tag
export function decryptArtifact(key: Uint8Array, blob: Uint8Array, aad: string): Uint8Array;      // throws ArtifactDecryptError
export function masterKeyFromEnv(source?: EnvSource): Uint8Array | undefined;                     // NEO_MASTER_KEY, 32 bytes base64; undefined when unset
```
AAD is the artifact id, so a ciphertext cannot be swapped between rows.

`@neo/db`:
```ts
export interface ArtifactStore {
  put(input: { tenantId: string; userId: string; kind: ArtifactKind; filename?: string; mimeType: string; bytes: Uint8Array; source: "upload" | "inbound" }): Promise<ArtifactMeta>;
  get(id: string, tenantId: string): Promise<ArtifactMeta | undefined>;
  read(id: string, tenantId: string): Promise<Uint8Array | undefined>;   // decrypted
  delete(id: string, tenantId: string): Promise<void>;
  listExpired(limit: number): Promise<ArtifactMeta[]>;                    // for the retention job (owner role; not tenant-scoped)
  purge(id: string): Promise<void>;                                       // blob + row
}
export type ArtifactKind = "eml" | "image" | "text" | "inbound_eml";
export type ArtifactMeta = { id: string; tenantId: string; userId: string; kind: ArtifactKind; filename?: string; mimeType: string; sizeBytes: number; sha256: string; encrypted: boolean; source: string; createdAt: Date; expiresAt: Date | null };
export function createArtifactStore(db: Db, opts: { blob: BlobClient; masterKey?: Uint8Array; retentionDays?: number }): ArtifactStore;   // default 30 days
export interface BlobClient { put(path: string, bytes: Uint8Array, contentType: string): Promise<{ url: string }>; get(url: string): Promise<Uint8Array | undefined>; del(url: string): Promise<void> }
export function createVercelBlobClient(token?: string): BlobClient;      // @vercel/blob, access "private"
export function createMemoryBlobClient(): BlobClient;                     // tests, MOCK_MODE without BLOB_READ_WRITE_TOKEN
```
- Migration `0003_phase1` alters `artifacts`: add `filename text`, `mime_type text not null`, `source text not null default 'upload'`; keep existing columns. RLS policy already covers `artifacts` (verify in the migration test).
- Blob path: `tenants/<tenantId>/artifacts/<artifactId>.bin` (ciphertext; content type `application/octet-stream`). Without `NEO_MASTER_KEY` the store refuses to `put` unless `MOCK_MODE` or no `DATABASE_URL` (in-memory dev), and then stores plaintext with `encrypted: false`. Production (`VERCEL_ENV=production`) always requires the key.
- `sha256` is of the plaintext (dedupe and VT lookups).

### Upload API (`apps/web`)

`POST /api/artifacts` (multipart/form-data, field `file`, up to 4 files per request; total ≤ 4 MB because Vercel functions cap request bodies at 4.5 MB)
- Auth required. Accepts: `message/rfc822` or `.eml` (≤ 2 MB) → kind `eml`; `image/png|jpeg|webp|gif` (≤ 3 MB each after client-side downscale) → kind `image`; `text/plain` (≤ 512 KB) → kind `text`. Type is checked by magic bytes, not just the declared type; mismatch → 415 `unsupported_type`.
- Returns `{ artifacts: [{ id, kind, filename, mimeType, sizeBytes, sha256 }] }`. 413 `too_large`, 401, 415, 503 `storage_unavailable`.
- Rate limit: 30 uploads per tenant per hour (in-memory counter per instance is acceptable in Phase 1; note it).
- `GET /api/artifacts/[id]` → the decrypted bytes with `Content-Disposition: attachment` and `Cache-Control: no-store`, tenant-checked. Used by the verdict detail page to let the user download their own evidence. Images may be displayed inline (`?inline=1`) with `Content-Type` fixed to the stored image type and `X-Content-Type-Options: nosniff`.

### Chat turn with attachments

`POST /api/agent` body gains `attachments?: { id: string }[]` (max 5). The route:
- Loads each artifact meta for the tenant (404 `not_found` if any is missing).
- Builds the user `MessageParam` content as blocks: the text block, then for each `image` artifact an `image` block (`source: { type: "base64", media_type, data }`) read through the store, and for each `eml`/`text` artifact a text block `[Attached file: <filename> (<kind>, <size>). Use analyze_email with artifact_ref "<id>".]`. The `eml` bytes are **not** inlined.
- The persisted turn stores images as blocks too (so history renders), but `prepareMessages` in `@neo/core` must count image blocks at a fixed 1600-token estimate and, when compressing, replace older image blocks with `[image omitted]` text blocks. Add this to the context manager with a test.
- `analyze_email`'s `loadArtifact` is bound to the session tenant via `ToolContext.tenantId` (the tool must not accept a tenant id from the model).
- `MAX_MESSAGE_CHARS` stays 20,000; pasted emails longer than that are told to upload as `.eml` or text file (the composer does this automatically: if pasted text > 20,000 chars it becomes a `text` artifact).

### Composer

- Attach button and drag-and-drop and paste of files. Accepted types as above. Client downscales images to ≤ 1568 px on the long edge (canvas) and re-encodes JPEG/PNG; shows thumbnails and file chips with remove buttons; uploads on send (not on attach) via `POST /api/artifacts`, then sends the agent request with `attachments`.
- Pasting an image from the clipboard (common: screenshot of a text) works.
- Message history renders image blocks as thumbnails (click to open `GET /api/artifacts/[id]?inline=1` in a new tab) and file references as chips.
- Composer placeholder rotates hints: "Paste a suspicious text…", "Drop an .eml file…", "Screenshot of an email or message…".

### Usage indicator (carried from Phase 0)

Chat header shows `checks used / limit this month` from `GET /api/usage`, refreshed after every turn; turns amber at 80%, red at 100% with the reset date.

### System prompt

Add intake guidance: when an image is present, first transcribe what you see (sender, subject, visible text, links exactly as displayed) then analyze; call `analyze_sms` for texts and `analyze_email` for emails (`pasted` variant with the transcription when there is no artifact); call `check_url` only for URLs not already analyzed by those tools (their results include URL analyses). Register `analyze_email`, `analyze_sms` in `buildToolRegistry`.

### Mock mode

`MOCK_MODE` scripted model: an image or `[Attached file …]` block → `analyze_email`/`analyze_sms` tool_use with a fixed input → verdict built from the result. Memory blob client when `BLOB_READ_WRITE_TOKEN` is unset.

## Possible Edge Cases

- HEIC from iPhone: browsers cannot decode it in canvas everywhere; reject with a message to use JPEG/PNG (the share sheet in Phase 2 converts).
- Upload succeeds, agent request fails: artifacts stay until expiry; the composer keeps chips so the user can resend without re-uploading.
- `.eml` with a 20 MB attachment: 413; tell the user to remove attachments or forward the mail to their Neo address.
- The same file uploaded twice: separate artifact rows (same sha256); dedupe is not needed in Phase 1.
- Image that is not an email/SMS (a cat photo): the model says it cannot find a message to analyze, no verdict block.
- Artifact expired between attach and send: 404 `not_found` with a clear message.
- Missing `NEO_MASTER_KEY` in production: `/api/artifacts` returns 503 `storage_unavailable`, `/api/health` reports `artifacts: "unconfigured"`.

## Acceptance Criteria

- Round trip: upload `.eml` → chat turn with `attachments` → `analyze_email` receives decrypted bytes → verdict stored with `artifact_id`.
- Ciphertext in the blob client differs from plaintext and fails to decrypt with another tenant's key or another artifact id as AAD.
- Image blocks are persisted, rendered, counted by the context manager, and dropped from compressed history.
- All routes tenant-check; foreign ids 404.
- `pnpm turbo run typecheck lint test build` green with `MOCK_MODE=true` and no Blob token.

## Open Questions

- Whether verdict retention should also be 30 days by default. Phase 1 keeps verdicts indefinitely (they hold no raw content, only IOCs and excerpts ≤ 2000 chars).

## Testing Guidelines
- `packages/core/test/artifact-crypto.test.ts`: derive/encrypt/decrypt, wrong key, wrong AAD, tampered tag, `masterKeyFromEnv` validation.
- `packages/db/test/artifact-store.test.ts` (pglite + memory blob): put/get/read/delete, tenant isolation, expiry listing, plaintext fallback rules.
- `apps/web/test/artifacts-route.test.ts`: multipart parsing, magic-byte checks, limits, tenant checks, inline image response headers.
- `apps/web/test/agent-attachments.test.ts`: message block construction, 404 on foreign artifact, image estimate in `prepareMessages`.
- `apps/web/test/composer-attachments.test.tsx`: attach, paste image, remove chip, send flow with mocked fetch.
