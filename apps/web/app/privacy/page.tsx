import type { Metadata } from "next";
import Link from "next/link";
import { NeoMark } from "@/components/NeoMark";
import { contactEmail } from "@/lib/env";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What Neo collects, why, who processes it, how long it is kept, and how to delete it.",
};

/** Bump when the policy text changes materially. */
export const PRIVACY_POLICY_UPDATED = "2026-10-05";

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
            <strong>Breach monitoring.</strong> Neo automatically monitors your verified sign-in email. Additional addresses
            require email confirmation. Address values are encrypted at rest in tenant-scoped storage; Neo keeps only
            selected breach names, dates and data types, never passwords or raw provider responses.
          </li>
          <li>
            <strong>Protected devices.</strong> When the household owner adds a browser or computer to protect a member,
            Neo keeps its name, kind, and platform, and the device checks in regularly with its app version and the time.
            An enrolled device also reports specific signals: the domain of a page that looked like a scam (never the
            full address, path, or page content) or a fake login page, the names of remote-access tools and flagged
            programs, a remote peer ID during a remote-access session, and screen-recording or accessibility permission
            grants. Signal records are kept for 30 days. When someone uses the browser extension&apos;s own link check
            (right-click a link, or paste one into the popup), Neo sends only that link, checks it the same way it
            checks a link you paste in chat, and does not save or alert on the result. The extension never sends
            browsing history, page content, form contents, or passwords. The Windows app checks programs and
            remote-access tools on the computer. It sends Neo only the name of a remote-access tool or flagged program
            when one appears, a remote peer ID during an incoming session, and the fingerprint (SHA-256) of an unsigned
            new program so it can be checked. It never sends your list of programs, files or browsing. On a Mac, with your permission (Full Disk Access), Neo
            also checks which apps were newly allowed to record your screen, control your Mac or read all your files. It
            sends only the app&apos;s name and which permission changed. The household owner can mark a tool as
            expected on a device, such as one they use to help another member, so their own sessions with it
            don&apos;t raise an alert.
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
            come back to it, email you the result of a forwarded message, and enforce the free usage limits. In a
            household, each member sees their own checks and the household owner sees everyone&apos;s. Chats are private
            to the person who had them. When a member&apos;s check comes back malicious or suspicious, a protected device
            reports a scam page, a remote-access tool, or a permission grant, or someone joins or leaves, the owner gets
            an alert on the dashboard and, depending on their settings, by email. Alerts contain Neo&apos;s one-line
            summary of the check, never the checked message itself, and the member can see the alerts about them. When a
            device is added to protect a member, the member gets an email saying so, and they can see and remove their
            devices in Settings → Household; removing one tells the owner.
          </p>
          <p className="mt-3">
            <strong>Weekly digests.</strong> If enabled, your digest summarizes your own security checks from the past
            week. Owners also receive aggregate household alerts and member-device health, never member verdict details,
            member names or device names. Checked message bodies, checked URLs and free-form alert text are excluded;
            headlines have links, email addresses, phone-like digit runs and long alphanumeric tokens redacted; the email contains only those redacted headlines. Resend receives your address and the rendered digest to deliver it. For retries, Neo stores the exact request encrypted in the tenant-scoped delivery ledger; only the active sending run can read it. Inngest step state and digest fan-out events contain no address or rendered request. Terminal delivery clears the payload. The daily sweep clears non-sending payloads and sending payloads after they reach 24 hours old; under the daily schedule, encrypted request bytes may remain roughly 24–48 hours after creation. A deployed digest requires the operator&apos;s `NEO_MASTER_KEY`; local/mock mode uses a development-only key. We keep your membership preference and minimal delivery identifiers, period, status, timestamps and provider message ID in the database. Rotating `AUTH_SECRET` invalidates existing digest unsubscribe links; you can opt out in Settings or use a fresh link from a later digest.
          </p>
          <p className="mt-3">
            <strong>Breach monitoring.</strong> Neo sends each verified address to{" "}
            <a href="https://haveibeenpwned.com/API/v3" rel="noreferrer" className="text-accent hover:text-accent-hover">Have I Been Pwned (HIBP)</a>{" "}
            and the address is checked weekly against known breached-account records. HIBP receives the normalized email address for this lookup.
            Neo stores selected breach names, dates and data types, not passwords or the raw HIBP response. HIBP data is attributed
            under CC BY 4.0.
          </p>
          <p className="mt-3">
            <strong>Account-hardening checklist.</strong> Your answers to the checklist in Settings → Hardening (for example, whether you
            use a password manager) are self-reported: Neo stores what you tell it and does not verify it with your providers. Answers are
            stored per household member, only you can see them, and they are deleted when you clear them, leave the household, or the owner
            removes you. A household owner sees only your percentage score, or &ldquo;not enough answers&rdquo;, never your individual answers.
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
              <strong>Vercel AI Gateway</strong> routes each request to a model provider and brokers the inference. Every
              request requires zero data retention (the provider may not keep the prompt or the answer) and inference in
              the United States; a request that cannot meet both is refused rather than sent elsewhere.
            </li>
            <li>
              The <strong>model family</strong> each household member picks in Settings decides which model provider
              processes their chat messages: Anthropic by default, or <strong>OpenAI</strong>,{" "}
              <strong>Moonshot AI</strong> (Kimi) or <strong>xAI</strong> (Grok) when the operator has enabled them.
              Background work, such as analyzing forwarded email, always uses Anthropic.
            </li>
            <li>
              <strong>TypeSafe AI</strong> (Jev), only when enabled, receives a shortened, redacted excerpt of your chat
              message (links reduced to their domain, email addresses and phone numbers masked) to decide how large a
              model the question needs. It never receives attachments, analysis results, or the rest of the
              conversation.
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
              <strong>Have I Been Pwned (HIBP)</strong> receives verified email addresses only when Neo checks them against its
              breached-account records. It does not receive passwords or message contents.
            </li>
            <li>
              <strong>Vercel</strong> hosts the app, keeps request logs, and stores uploaded and forwarded evidence.{" "}
              <strong>Neon</strong> stores the database. <strong>Resend</strong> receives forwarded email for your
              household address and sends sign-in links, result emails, weekly digests, and additional-address confirmation emails containing a single-use confirmation URL. Resend necessarily receives the destination address and that URL as part of delivery. <strong>Inngest</strong> runs
              background jobs. Weekly digest events and step state carry only identifiers/status; the temporary email request is stored encrypted in the tenant-scoped database ledger and is cleared on completion or by the daily sweep when it is non-sending or reaches 24 hours of age. <strong>Google</strong> handles Google
              sign-in.
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
            <strong>Removed devices</strong> are deleted 90 days after removal.
          </li>
          <li>
            <strong>Signal records</strong> a protected device reports are kept for 30 days.
          </li>
          <li>
            <strong>Your account</strong> is kept until you ask us to delete it.
          </li>
          <li>
            <strong>Weekly digest request payloads</strong> are encrypted in the delivery ledger while a send is pending,
            cleared when delivery becomes terminal. The daily sweep removes non-sending payloads and sending payloads at least 24 hours old; under the daily schedule, a pending payload may remain roughly 24–48 hours after creation.
          </li>
          <li>
            <strong>Breach-monitoring records</strong> are kept while an address is monitored. The encrypted address and breach observations are hard-deleted when an address is removed, when you leave the household, or when the owner removes you. Verification links expire after 24 hours;
            Neo stores only their hashes and clears expired hashes daily.
          </li>
          <li>
            <strong>Provider logs</strong> follow each provider&apos;s own retention, typically days to a few weeks. Encrypted copies in provider-managed backups may remain until those backups expire.
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
          <li>
            Control your own weekly digest in <Link href="/settings/digest" className="text-accent hover:text-accent-hover">Settings → Digest</Link>
            {" "}or use its unsubscribe link. Owners default on and members default off; changing roles resets that default.
            Empty weeks are skipped. Digest preferences are separate from alert emails, and owners cannot change a member&apos;s preference.
          </li>
          <li>
            Manage additional addresses in <Link href="/settings/breaches" className="text-accent hover:text-accent-hover">Settings → Breaches</Link>.
            You can remove an additional address at any time; leaving or being removed from a household deletes its breach records.
          </li>
          <li>Rotate your household&apos;s forwarding address at any time from Settings; the old one stops working.</li>
          <li>
            Leave a household at any time from Settings → Household; your chats in it are deleted and the checks you ran
            stay with the household. Joining someone else&apos;s household deletes your own one-person household and
            everything in it, after you confirm.
          </li>
          <li>See and remove the devices that protect you from Settings → Household.</li>
          <li>As a household owner, mark a remote-access tool as expected on a device so your own sessions with it don&apos;t alert.</li>
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
