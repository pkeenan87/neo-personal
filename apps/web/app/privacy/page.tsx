import type { Metadata } from "next";
import Link from "next/link";
import { NeoMark } from "@/components/NeoMark";
import { contactEmail } from "@/lib/env";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What Neo collects, why, who processes it, how long it is kept, and how to delete it.",
};

/** Bump when the policy text changes materially. */
export const PRIVACY_POLICY_UPDATED = "2026-09-26";

const REPO_URL = "https://github.com/pkeenan87/neo-personal";

type Section = { id: string; title: string; body: React.ReactNode };

function sections(email: string): Section[] {
  return [
    {
      id: "scope",
      title: "Who this covers",
      body: (
        <p>
          This policy covers the hosted Neo service at <strong>neoshield.dev</strong>. Neo is open source, and anyone can
          run their own copy; a self-hosted instance is operated by whoever runs it, not by us, and this policy does not
          apply to it.
        </p>
      ),
    },
    {
      id: "collect",
      title: "What Neo collects",
      body: (
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Your account.</strong> Your name, email address, and profile picture from Google when you sign in
            with Google, or just your email address when you sign in with an emailed link. A session cookie keeps you
            signed in.
          </li>
          <li>
            <strong>What you ask Neo to check.</strong> Links, pasted emails and text messages, screenshots, uploaded
            email files, and the messages you type in chat. If you set up email forwarding, the full original message
            you forward to your household address, including its headers and the names and types of any attachments.
          </li>
          <li>
            <strong>What Neo produces.</strong> Verdicts, the warning signs it found, the domains, addresses, and phone
            numbers it extracted, your conversation history, and counts of how many checks your household has used.
          </li>
          <li>
            <strong>Technical records.</strong> Our hosting provider keeps standard request logs (IP address, browser,
            timestamps). Neo&apos;s own logs record hashed identifiers and outcome codes, never the content of what you
            submitted.
          </li>
        </ul>
      ),
    },
    {
      id: "use",
      title: "How it is used",
      body: (
        <>
          <p>
            Only to do what you asked: analyze the thing you submitted, show you the result, keep your history so you can
            come back to it, email you the result of a forwarded message, and enforce the free usage limits. Members of
            the same household can see each other&apos;s checks; the household owner can see everyone&apos;s.
          </p>
          <p className="mt-3">
            Neo does not sell or rent your data, does not show ads, does not build advertising profiles, and does not use
            what you submit to train AI models.
          </p>
        </>
      ),
    },
    {
      id: "processors",
      title: "Who processes it on our behalf",
      body: (
        <>
          <p>Neo runs on a small number of service providers. Each one receives only what it needs:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong>Anthropic</strong> (Claude models) receives the content being analyzed and your chat messages in
              order to produce the analysis. Anthropic does not use API data to train its models.
            </li>
            <li>
              <strong>Google Safe Browsing</strong> and <strong>VirusTotal</strong> receive links (and, for attachments,
              a fingerprint hash of the file, never the file itself) to check against known-threat databases. The hosted
              service only looks links up; it does not submit new links for public scanning.
            </li>
            <li>
              <strong>Domain registries (RDAP)</strong> receive domain names to look up their age and registrar.
            </li>
            <li>
              <strong>Vercel</strong> hosts the app, keeps request logs, and stores uploaded and forwarded evidence.
              <strong> Neon</strong> stores the database. <strong>Resend</strong> receives forwarded email for your
              household address and sends sign-in links and result emails. <strong>Inngest</strong> runs background jobs
              and sees only record identifiers, not content. <strong>Google</strong> handles Google sign-in.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "retention",
      title: "How long it is kept",
      body: (
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Raw evidence</strong> (uploaded files, screenshots, forwarded emails) is deleted automatically after
            30 days.
          </li>
          <li>
            <strong>Verdicts and conversations</strong> are kept until you delete them, so your history stays useful.
          </li>
          <li>
            <strong>Your account</strong> is kept until you ask us to delete it.
          </li>
          <li>
            <strong>Provider logs</strong> follow each provider&apos;s own retention, typically days to a few weeks.
          </li>
        </ul>
      ),
    },
    {
      id: "security",
      title: "How it is protected",
      body: (
        <p>
          Everything travels over HTTPS. Uploaded and forwarded evidence is encrypted at rest with a key unique to your
          household. Each household&apos;s data is isolated in the database by row-level security. Content you submit is
          treated as untrusted by design, so a malicious email cannot instruct Neo to act on your behalf. The full source
          code is public at{" "}
          <a href={REPO_URL} className="text-accent hover:text-accent-hover">
            {REPO_URL.replace("https://", "")}
          </a>
          , and the threat model is described in its SECURITY file.
        </p>
      ),
    },
    {
      id: "choices",
      title: "Your choices",
      body: (
        <ul className="list-disc space-y-2 pl-5">
          <li>Delete any verdict from its page; this also deletes the evidence attached to it.</li>
          <li>Delete any conversation from the chat sidebar.</li>
          <li>Rotate your household&apos;s forwarding address at any time from Settings; the old one stops working.</li>
          <li>
            Ask for a copy of your data or for your account and household to be deleted by emailing{" "}
            <a href={`mailto:${email}`} className="text-accent hover:text-accent-hover">
              {email}
            </a>
            . We answer within 30 days.
          </li>
        </ul>
      ),
    },
    {
      id: "children",
      title: "Children",
      body: (
        <p>
          Neo is meant for adults and for families where an adult owns the household account. Do not create an account
          for a child under 13 (or the age of digital consent where you live).
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes and contact",
      body: (
        <p>
          When this policy changes, the date at the top changes with it and material changes are noted in the project
          changelog. Questions go to{" "}
          <a href={`mailto:${email}`} className="text-accent hover:text-accent-hover">
            {email}
          </a>{" "}
          or a public issue on GitHub.
        </p>
      ),
    },
  ];
}

export default function PrivacyPage() {
  const email = contactEmail();
  const items = sections(email);
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold">
          <NeoMark className="size-7 text-accent" />
          Neo
        </Link>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy policy</h1>
        <p className="mt-2 text-sm text-muted">
          Last updated <time dateTime={PRIVACY_POLICY_UPDATED}>{PRIVACY_POLICY_UPDATED}</time>
        </p>
        <p className="mt-6 leading-relaxed text-muted">
          Neo exists to tell you whether something is a scam. To do that it has to look at what you send it. This page
          says, in plain language, what that means for your data.
        </p>
        <nav aria-label="Sections" className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {items.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="text-accent hover:text-accent-hover">
              {s.title}
            </a>
          ))}
        </nav>
        {items.map((s) => (
          <section key={s.id} id={s.id} className="mt-10 scroll-mt-6">
            <h2 className="text-xl font-semibold">{s.title}</h2>
            <div className="mt-3 leading-relaxed text-muted">{s.body}</div>
          </section>
        ))}
      </main>
      <footer className="mx-auto w-full max-w-3xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-xs text-muted">
        Neo is free and open source (MIT). It can make mistakes. When in doubt, don&apos;t click.
      </footer>
    </div>
  );
}
