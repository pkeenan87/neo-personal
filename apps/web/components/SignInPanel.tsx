"use client";

import { Loader2, Mail } from "lucide-react";
import { useState } from "react";
import { signIn } from "@/lib/auth-client";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path fill="#4285F4" d="M22.5 12.27c0-.78-.07-1.53-.2-2.27H12v4.3h5.9a5.05 5.05 0 0 1-2.2 3.3v2.75h3.55c2.08-1.92 3.25-4.74 3.25-8.08Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.75c-.98.66-2.24 1.06-3.72 1.06-2.86 0-5.29-1.93-6.15-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.85 14.12a6.6 6.6 0 0 1 0-4.24V7.04H2.18a11 11 0 0 0 0 9.92l3.67-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.2 1.64l3.15-3.15A10.98 10.98 0 0 0 2.18 7.04l3.67 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

export function SignInPanel({ notice }: { notice?: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"google" | "resend" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const google = async () => {
    setBusy("google");
    setError(null);
    const r = await signIn("google");
    if (!r.ok) {
      setError(r.error ?? "Sign-in failed.");
      setBusy(null);
    }
  };

  const magic = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("resend");
    setError(null);
    const r = await signIn("resend", { email });
    setBusy(null);
    if (!r.ok) setError(r.error ?? "Couldn't send the link.");
    else if (r.emailSent) setSent(true);
  };

  return (
    <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-sm">
      {notice && (
        <p role="status" className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
          {notice}
        </p>
      )}
      <button
        type="button"
        onClick={() => void google()}
        disabled={busy !== null}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-border-strong bg-surface px-4 text-sm font-semibold hover:bg-surface-2 disabled:opacity-60"
      >
        {busy === "google" ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : <GoogleIcon />}
        Sign in with Google
      </button>

      <div className="my-4 flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      {sent ? (
        <p role="status" className="text-sm">
          Check your inbox for a sign-in link.
        </p>
      ) : (
        <form onSubmit={(e) => void magic(e)} className="space-y-2">
          <label htmlFor="signin-email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="signin-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-error" : undefined}
            className="min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-base placeholder:text-muted focus:border-accent focus:outline-none sm:text-sm"
          />
          <button
            type="submit"
            disabled={busy !== null}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            {busy === "resend" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Mail className="size-4" aria-hidden="true" />
            )}
            Email me a link
          </button>
        </form>
      )}
      {error && (
        <p id="signin-error" role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <p className="mt-4 text-xs text-muted">No password needed. We&apos;ll never sell or share your data.</p>
    </div>
  );
}
