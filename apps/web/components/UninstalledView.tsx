"use client";

/**
 * /uninstalled (_specs/browser-extension.md "Uninstall"): posts `{ d, s }` from the query
 * string to POST /api/devices/uninstalled once on load, then shows the same generic result
 * either way — the route reveals nothing about whether the device or signature were valid, so
 * neither does this page. `d`/`s` are read from `window.location.search` (not
 * `useSearchParams`) so the page needs no Suspense boundary.
 */
import { useEffect } from "react";
import Link from "next/link";
import { NeoMark } from "./NeoMark";

export function UninstalledView() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get("d");
    const s = params.get("s");
    if (!d || !s) return;
    fetch("/api/devices/uninstalled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ d, s }),
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-8 text-center">
      <Link href="/" className="mb-8 flex items-center gap-2 text-lg font-semibold">
        <NeoMark className="size-7 text-accent" />
        Neo
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Neo was removed from this browser.</h1>
      <p className="mt-3 max-w-md text-muted">
        The person who set it up has been told. If this wasn&apos;t you, or you&apos;d like Neo watching for scams
        again, you can reinstall it any time.
      </p>
      <Link
        href="/"
        className="mt-6 min-h-11 rounded-xl border border-border px-4 py-2 text-sm font-medium hover:bg-surface-2"
      >
        Go to Neo
      </Link>
    </div>
  );
}
