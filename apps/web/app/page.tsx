import { KeyRound, Link2, MailWarning, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { NeoMark } from "@/components/NeoMark";
import { SignInPanel } from "@/components/SignInPanel";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env } from "@/lib/env";
import { getSession } from "@/lib/session";

const AUTH_ERRORS: Record<string, string> = {
  OAuthAccountNotLinked: "This email is already registered with a different sign-in method. Please sign in with your original method.",
  AccessDenied: "Sign-in was denied. Google sign-in needs a verified email address.",
  Verification: "That sign-in link has expired or was already used. Send yourself a new one.",
};

const FEATURES = [
  {
    icon: Link2,
    title: "Check any link",
    body: "Paste a link before you open it. Neo looks up its reputation, age, and where it really leads.",
  },
  {
    icon: MailWarning,
    title: "Spot scam emails and texts",
    body: "Paste a message that feels off. Neo explains the warning signs in plain language.",
  },
  {
    icon: KeyRound,
    title: "Know what to do next",
    body: "Clicked something or shared a password? Neo walks you through the steps that matter, in order.",
  },
];

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ signin?: string; error?: string }>;
}) {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  const e = env();
  const notice =
    params.signin === "required"
      ? "Please sign in to continue."
      : params.signin === "check-email"
        ? "Check your inbox for a sign-in link. It expires in 10 minutes."
        : params.error
          ? (AUTH_ERRORS[params.error] ?? "Sign-in failed. Please try again.")
          : undefined;

  return (
    <div className="flex min-h-dvh flex-col">
      {e.DEV_AUTH_BYPASS && <DevBypassBanner />}
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <NeoMark className="size-7 text-accent" />
          Neo
        </div>
        {session && (
          <Link href="/chat" className="text-sm font-medium text-accent hover:text-accent-hover">
            Open Neo →
          </Link>
        )}
      </header>

      <main className="mx-auto grid w-full max-w-5xl flex-1 content-center items-center gap-10 px-4 py-8 md:grid-cols-[1.2fr_1fr] md:py-16">
        <section>
          <p className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Your personal security assistant
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Not sure if it&apos;s a scam? Ask Neo.
          </h1>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted">
            Neo checks suspicious links, emails, and text messages and tells you, in plain language, whether they&apos;re
            safe and exactly what to do next.
          </p>
          <ul className="mt-8 space-y-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-accent">
                  <f.icon className="size-5" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="font-semibold">{f.title}</h2>
                  <p className="text-sm leading-relaxed text-muted">{f.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Sign in" className="flex justify-center md:justify-end">
          {session ? (
            <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 text-center shadow-sm">
              <p className="text-sm text-muted">Signed in as {session.email}</p>
              <Link
                href="/chat"
                className="mt-3 flex min-h-11 items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover"
              >
                Start a check
              </Link>
            </div>
          ) : (
            <SignInPanel notice={notice} providers={e.AUTH_PROVIDERS} />
          )}
        </section>
      </main>

      <footer className="mx-auto w-full max-w-5xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-xs text-muted">
        Neo is free and open source (MIT). It can make mistakes. When in doubt, don&apos;t click.
      </footer>
    </div>
  );
}
