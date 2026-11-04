import { useEffect, useRef, useState } from "react";
import { sendToBackground } from "@/lib/messages.js";
import { CATEGORY_LABELS, REASON_MAX, destinationAfterApproval, parseBlockPageParams, requestErrorText } from "@/lib/blockPage.js";
import { defangDomain } from "@/lib/format.js";
import type { BlockInfo, RequestStatusResult, UnblockResult } from "@/lib/sync.js";

/** Request reads are limited to 300 an hour per device; 20 s is 180. */
const POLL_MS = 20_000;

type RequestState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "pending"; id: string }
  | { phase: "approved"; id: string }
  | { phase: "denied" }
  | { phase: "expired" }
  | { phase: "error"; message: string };

export function App() {
  const params = parseBlockPageParams(location.search);
  const [info, setInfo] = useState<BlockInfo | null | undefined>(undefined);
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState<RequestState>({ phase: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Confirm with the background that this domain is really blocked (and report it once).
  useEffect(() => {
    if (!params) return;
    sendToBackground<BlockInfo>({ type: "block-page-shown", domain: params.domain })
      .then((result) => {
        setInfo(result);
        // Only go on by itself when it knows the exact page; otherwise a stale redirect rule could bounce straight back here.
        if (!result.blocked) {
          if (params.returnUrl) location.replace(params.returnUrl);
        } else if (result.pendingRequest) setRequest({ phase: "pending", id: result.pendingRequest.id });
      })
      .catch(() => setInfo(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a request is pending, ask for its status; reload the site once the new settings allow it.
  const pendingId = request.phase === "pending" || request.phase === "approved" ? request.id : null;
  useEffect(() => {
    if (!params || !pendingId) return;
    let cancelled = false;
    async function poll() {
      const result = await sendToBackground<RequestStatusResult>({ type: "request-status", id: pendingId!, domain: params!.domain }).catch(() => null);
      if (cancelled) return;
      if (result?.ok) {
        if (result.status === "approved" && !result.blocked) {
          location.replace(destinationAfterApproval(params!));
          return;
        }
        if (result.status === "approved") setRequest({ phase: "approved", id: pendingId! });
        else if (result.status === "denied") {
          setRequest({ phase: "denied" });
          return;
        } else if (result.status === "expired") {
          setRequest({ phase: "expired" });
          return;
        }
      }
      timer.current = setTimeout(poll, POLL_MS);
    }
    timer.current = setTimeout(poll, 3_000);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId]);

  async function askToUnblock() {
    if (!params) return;
    setRequest({ phase: "sending" });
    const result = await sendToBackground<UnblockResult>({ type: "request-unblock", domain: params.domain, reason: reason.trim() || undefined }).catch(
      () => ({ ok: false as const, error: "offline" }),
    );
    if (!result.ok) {
      setRequest({ phase: "error", message: requestErrorText(result.error) });
      return;
    }
    setRequest(result.status === "pending" ? { phase: "pending", id: result.id } : result.status === "approved" ? { phase: "approved", id: result.id } : { phase: result.status });
  }

  if (!params) {
    return (
      <main style={{ maxWidth: 560, margin: "0 auto", padding: "48px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 28 }}>Blocked in Child mode</h1>
        <p>This site is blocked.</p>
      </main>
    );
  }
  if (info === undefined) return null;
  if (info && !info.blocked) {
    return (
      <main style={{ maxWidth: 560, margin: "0 auto", padding: "48px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 28 }}>This site isn&apos;t blocked right now</h1>
        <p>
          <a href={destinationAfterApproval(params)}>Open {defangDomain(params.domain)}</a>
        </p>
      </main>
    );
  }

  const label = CATEGORY_LABELS[info?.category && info.category in CATEGORY_LABELS ? (info.category as keyof typeof CATEGORY_LABELS) : params.category];

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "48px 24px", textAlign: "center" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Blocked in Child mode</h1>
      <p style={{ fontSize: 20, margin: "0 0 4px" }}>
        <strong>{defangDomain(params.domain)}</strong>
      </p>
      <p style={{ margin: "0 0 24px", color: "#4a5361" }}>{label}</p>
      <p>Your family set Neo to block this kind of site on this browser.</p>

      {request.phase === "idle" || request.phase === "error" || request.phase === "sending" ? (
        <div style={{ marginTop: 24 }}>
          <label style={{ display: "block", textAlign: "left", fontSize: 15, marginBottom: 12 }}>
            Why do you want to open it? (optional)
            <input
              type="text"
              value={reason}
              maxLength={REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
              style={{ display: "block", width: "100%", boxSizing: "border-box", padding: 8, marginTop: 4, fontSize: 16 }}
            />
            <span style={{ color: "#6b727c" }}>
              {reason.length}/{REASON_MAX}
            </span>
          </label>
          <button
            type="button"
            onClick={() => void askToUnblock()}
            disabled={request.phase === "sending"}
            style={{ fontSize: 18, padding: "12px 24px", background: "#1d4a7a", color: "#ffffff", border: "none", borderRadius: 6 }}
          >
            Ask to unblock
          </button>
          {request.phase === "error" && <p style={{ color: "#a33" }}>{request.message}</p>}
        </div>
      ) : (
        <p style={{ marginTop: 24, fontSize: 20 }} role="status">
          {request.phase === "pending" && "Asked. Waiting for a parent to answer."}
          {request.phase === "approved" && "Approved. Opening the site…"}
          {request.phase === "denied" && "A parent said no this time."}
          {request.phase === "expired" && "This request ran out. You can ask again."}
        </p>
      )}
      {request.phase === "expired" && (
        <button type="button" onClick={() => setRequest({ phase: "idle" })} style={{ marginTop: 8 }}>
          Ask again
        </button>
      )}
    </main>
  );
}
