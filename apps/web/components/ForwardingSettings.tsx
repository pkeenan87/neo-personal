"use client";

import { TriangleAlert, ArrowLeft, Inbox, Mail, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import type { ForwardingMessage, ForwardingSettings, InboundMessageStatus } from "@/lib/forwarding-types";
import { CopyButton } from "./CopyButton";
import { relativeTime } from "./ConversationSidebar";
import { useToast } from "./toast-context";

type ProviderId = "gmail" | "icloud" | "outlook" | "yahoo" | "attachment";

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "gmail", label: "Gmail" },
  { id: "icloud", label: "iCloud" },
  { id: "outlook", label: "Outlook.com" },
  { id: "yahoo", label: "Yahoo" },
  { id: "attachment", label: "One-off check" },
];

const STATUS_LABELS: Record<InboundMessageStatus, string> = {
  received: "Received",
  analyzing: "Analyzing",
  done: "Checked",
  rejected: "Not accepted",
  over_cap: "Monthly limit reached",
  failed: "Could not analyze",
};

const REASON_LABELS: Record<string, string> = {
  unknown_sender: "Forwarded from an address that isn't on your account",
  rate_limited: "Too many messages in the last hour",
  too_large: "Message larger than 2 MB",
  storage_unavailable: "Storage unavailable",
  job_failed: "Analysis failed",
  queue_unavailable: "Could not start the analysis",
  gmail_confirmation: "Gmail forwarding confirmation",
};

function Guide({ provider, address }: { provider: ProviderId; address: string }) {
  const addr = <code className="rounded bg-surface-2 px-1 py-0.5 text-xs break-all">{address}</code>;
  switch (provider) {
    case "gmail":
      return (
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            In Gmail on the web, open <strong>Settings → See all settings → Forwarding and POP/IMAP</strong> and choose{" "}
            <strong>Add a forwarding address</strong>. Enter {addr}.
          </li>
          <li>
            Gmail sends a confirmation email to that address. Neo catches it and shows the confirmation code at the top of
            this page. Enter the code in Gmail. Don&apos;t click links in emails that claim to be this confirmation: real
            phishing imitates it.
          </li>
          <li>
            To forward only some mail, create a filter (<strong>Settings → Filters → Create a new filter</strong>) and pick{" "}
            <strong>Forward it to</strong> {addr}. Leave the general &quot;Forward a copy&quot; option off unless you want
            every message checked.
          </li>
        </ol>
      );
    case "icloud":
      return (
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            On iCloud.com, open <strong>Mail → Settings → Rules → Add a rule</strong>.
          </li>
          <li>
            Choose a condition (for example &quot;is from&quot; a sender you get suspicious mail from), then{" "}
            <strong>Forward to</strong> {addr}.
          </li>
          <li>For a single message, open it and use Forward, sending it to the address above.</li>
        </ol>
      );
    case "outlook":
      return (
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            In Outlook.com, open <strong>Settings → Mail → Rules → Add new rule</strong>.
          </li>
          <li>
            Add a condition, then the action <strong>Forward to</strong> {addr} and save.
          </li>
          <li>For a single message, choose Forward (or &quot;Forward as attachment&quot;) and send it to the address above.</li>
        </ol>
      );
    case "yahoo":
      return (
        <ol className="list-decimal space-y-2 pl-5">
          <li>Automatic forwarding is a paid Yahoo Mail feature, so forward messages one at a time.</li>
          <li>
            Open the suspicious message, choose <strong>Forward</strong>, and send it to {addr}.
          </li>
        </ol>
      );
    case "attachment":
      return (
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            For the most accurate check, forward the message <strong>as an attachment</strong> (Gmail: open the message, ⋮ →{" "}
            <strong>Forward as attachment</strong>; Outlook: ⋯ → <strong>Forward as attachment</strong>; Apple Mail:{" "}
            <strong>Message → Forward as Attachment</strong>). This keeps the original headers.
          </li>
          <li>Send it to {addr}. Neo emails you the result in a minute or two.</li>
          <li>Forward from an email address on your Neo account: mail from other addresses is ignored.</li>
        </ol>
      );
  }
}

function MessageRow({ m }: { m: ForwardingMessage }) {
  const reason = m.reason ? (REASON_LABELS[m.reason] ?? m.reason) : null;
  return (
    <li className="flex items-center gap-3 py-3">
      <Mail className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium">{STATUS_LABELS[m.status]}</div>
        <div className="text-xs text-muted">
          <span suppressHydrationWarning>{relativeTime(m.receivedAt)}</span>
          {reason && m.status !== "done" ? <> · {reason}</> : null}
        </div>
      </div>
      {m.verdictId && (m.status === "done" || m.status === "over_cap") ? (
        <Link href={`/verdicts/${encodeURIComponent(m.verdictId)}`} className="shrink-0 text-sm font-medium text-accent hover:underline">
          View result
        </Link>
      ) : null}
    </li>
  );
}

export function ForwardingSettingsView({ initial }: { initial: ForwardingSettings }) {
  const [settings, setSettings] = useState(initial);
  const [tab, setTab] = useState<ProviderId>("gmail");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const tabsId = useId();
  const address = settings.address ?? `${settings.localPart}@…`;

  async function rotate() {
    setBusy(true);
    try {
      const res = await fetch("/api/settings/forwarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rotate" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setSettings((await res.json()) as ForwardingSettings);
      setConfirming(false);
      toast({ intent: "success", title: "New address created", description: "Update your forwarding rules to use it." });
    } catch {
      toast({ intent: "error", title: "Could not rotate the address" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <Link href="/chat" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to Neo
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">Forward suspicious email</h1>
      <p className="mt-1 text-sm text-muted">
        Forward any email you&apos;re unsure about to your household&apos;s Neo address. Neo checks it and emails you the
        result.
      </p>

      {settings.gmailConfirmation ? (
        <section
          aria-label="Gmail forwarding confirmation"
          className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <p className="font-medium">
            Gmail is asking to confirm forwarding: code{" "}
            <span className="font-mono text-base tracking-wider" data-testid="gmail-code">
              {settings.gmailConfirmation.code}
            </span>
          </p>
          <p className="mt-1">
            If you just added this address in Gmail, enter the code there. If you didn&apos;t, ignore it: nobody can forward
            your mail without it.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="address-heading" className="mt-5 rounded-xl border border-border bg-surface p-4">
        <h2 id="address-heading" className="text-sm font-semibold">
          Your Neo address
        </h2>
        {!settings.configured ? (
          <p className="mt-2 flex items-start gap-2 text-sm text-muted">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Email forwarding isn&apos;t set up on this Neo server yet.
          </p>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm break-all" data-testid="inbound-address">
            {address}
          </code>
          {settings.address ? <CopyButton text={settings.address} label="Copy address" /> : null}
        </div>
        {settings.acceptedSenders.length ? (
          <p className="mt-3 text-xs text-muted">
            Accepted from: {settings.acceptedSenders.join(", ")}. Mail forwarded from any other address is ignored.
          </p>
        ) : null}
        {settings.canRotate ? (
          <div className="mt-3">
            {confirming ? (
              <div role="alertdialog" aria-labelledby="rotate-title" className="rounded-lg border border-border-strong p-3 text-sm">
                <p id="rotate-title" className="font-medium">
                  Create a new address?
                </p>
                <p className="mt-1 text-muted">
                  The current address stops working immediately. You&apos;ll need to update your forwarding rules.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={rotate}
                    disabled={busy}
                    className="min-h-9 rounded-lg bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {busy ? "Rotating…" : "Yes, rotate"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                    className="min-h-9 rounded-lg border border-border-strong px-3 text-sm hover:bg-surface-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-sm hover:bg-surface-2"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                Rotate address
              </button>
            )}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="guide-heading" className="mt-5 rounded-xl border border-border bg-surface p-4">
        <h2 id="guide-heading" className="text-sm font-semibold">
          Set up forwarding
        </h2>
        <div role="tablist" aria-label="Email provider" className="mt-3 flex gap-1 overflow-x-auto">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              id={`${tabsId}-tab-${p.id}`}
              aria-selected={tab === p.id}
              aria-controls={`${tabsId}-panel`}
              onClick={() => setTab(p.id)}
              className={`min-h-9 shrink-0 rounded-lg px-3 text-sm whitespace-nowrap ${
                tab === p.id ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`${tabsId}-panel`}
          aria-labelledby={`${tabsId}-tab-${tab}`}
          className="mt-3 text-sm leading-relaxed"
        >
          <Guide provider={tab} address={address} />
        </div>
      </section>

      <section aria-labelledby="recent-heading" className="mt-5 rounded-xl border border-border bg-surface p-4">
        <h2 id="recent-heading" className="text-sm font-semibold">
          Recently forwarded
        </h2>
        {settings.messages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted">
            <Inbox className="size-6" aria-hidden="true" />
            Nothing forwarded yet
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {settings.messages.map((m) => (
              <MessageRow key={m.id} m={m} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
