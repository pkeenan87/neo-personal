"use client";

import { ShieldQuestion } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SigninCheck } from "@neo/verdict";
import { PROVIDER_NAMES } from "@/lib/signin-providers";

type Phase = "ask" | "sending" | "yes" | "error";

/**
 * "Was this you?" on a first-seen sign-in alert (_specs/signin-alerts.md). Every value shown (device, location)
 * came from the alert, so it is rendered as plain text (React escapes it) and the location is labelled advisory.
 * Yes remembers the device; No opens the account_takeover playbook in chat.
 */
export function SigninQuestion({ verdictId, check }: { verdictId: string; check: SigninCheck }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("ask");

  async function answer(response: "yes" | "no") {
    setPhase("sending");
    try {
      const res = await fetch(`/api/verdicts/${verdictId}/signin-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { playbook?: string };
      if (response === "no" && data.playbook) {
        router.push(`/chat?playbook=${encodeURIComponent(data.playbook)}`);
        return;
      }
      setPhase("yes");
    } catch {
      setPhase("error");
    }
  }

  return (
    <section aria-labelledby="signin-question" className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <h2 id="signin-question" className="flex items-center gap-2 text-base font-semibold">
        <ShieldQuestion className="size-5 text-accent" aria-hidden="true" /> Was this you?
      </h2>
      <p className="mt-1 text-sm text-muted">
        A {PROVIDER_NAMES[check.provider]} sign-in alert named a device Neo has not seen before:{" "}
        <strong className="font-semibold text-fg">{check.device_label}</strong>
        {check.coarse_location ? (
          <>
            , near {check.coarse_location} <span className="text-xs">(location is advisory and may be inaccurate)</span>
          </>
        ) : null}
        .
      </p>
      {phase === "yes" ? (
        <p role="status" className="mt-3 text-sm font-medium">
          Thanks. Neo will remember this device.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={phase === "sending"}
            onClick={() => void answer("yes")}
            className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
          >
            Yes, that was me
          </button>
          <button
            type="button"
            disabled={phase === "sending"}
            onClick={() => void answer("no")}
            className="inline-flex min-h-11 items-center rounded-xl bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
          >
            No, that was not me
          </button>
        </div>
      )}
      {phase === "error" ? (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          Couldn&apos;t save your answer. Try again.
        </p>
      ) : null}
    </section>
  );
}
