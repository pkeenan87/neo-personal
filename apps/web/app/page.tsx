import { ArrowDown, ArrowRight, Check, Code2, KeyRound, Link2, LockKeyhole, MailWarning, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NeoMark } from "@/components/NeoMark";
import { SignInPanel } from "@/components/SignInPanel";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env } from "@/lib/env";
import { getSession } from "@/lib/session";
import styles from "./landing.module.css";

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
  // Signed-in users land on their dashboard.
  if (session) redirect("/dashboard");
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
    <div className={styles.landing}>
      {e.DEV_AUTH_BYPASS && <DevBypassBanner />}
      <a href="#main" className={styles.skipLink}>Skip to content</a>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Neo home">
          <NeoMark className={styles.brandMark} />
          <span>neo<span className={styles.brandDot}>.</span></span>
        </Link>
        <nav aria-label="Main navigation" className={styles.nav}>
          <a href="#how-it-works" className={styles.navAbout}>How it works</a>
          <a href="#get-started" className={styles.navSignIn}>Sign in <ArrowRight size={15} aria-hidden="true" /></a>
        </nav>
      </header>

      {notice && <div className={styles.notice} role="status">{notice} <a href="#get-started" className="underline">Go to sign in</a></div>}

      <main id="main" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}><span /> YOUR PERSONAL SECURITY ASSISTANT</p>
            <h1 id="hero-title">A little doubt.<br />A <span>clear answer.</span></h1>
            <p className={styles.heroDescription}>
              Strange link? Urgent email? Something just feels off?
              Ask Neo before you click. Get a clear verdict, the reasons behind it,
              and a safer next step.
            </p>
            <div className={styles.heroActions}>
              <a href="#get-started" className={styles.primaryButton}>Ask Neo <ArrowRight size={18} aria-hidden="true" /></a>
              <a href="#how-it-works" className={styles.secondaryButton}>See how it works <ArrowDown size={16} aria-hidden="true" /></a>
            </div>
            <p className={styles.heroNote}><Code2 size={15} aria-hidden="true" /> Free &amp; open source <span>·</span> Built for everyday life</p>
          </div>

          <div className={styles.heroVisual}>
            <div className={styles.orbit} aria-hidden="true" />
            <div className={styles.orbitInner} aria-hidden="true" />
            <NeoMark className={styles.heroMark} />
            <div className={styles.shieldCaption}><ShieldCheck size={14} aria-hidden="true" /> A second look. A smarter next step.</div>
            <div className={styles.example}>
              <div className={styles.exampleHeader}><span className={styles.exampleDot} /> NEO LINK CHECK <span>EXAMPLE</span></div>
              <p className={styles.exampleQuestion}>“Your package is on hold. Pay a small fee to release it.”</p>
              <div className={styles.verdict}><TriangleAlert size={17} aria-hidden="true" /> Looks suspicious</div>
              <p className={styles.exampleAnswer}>An unexpected payment request is a warning sign. Open the delivery company’s official app to check your shipment.</p>
              <div className={styles.exampleFoot}><Check size={13} aria-hidden="true" /> Clear reasoning. Practical next steps.</div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className={styles.features} aria-labelledby="features-title">
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}>LESS GUESSWORK. MORE PEACE OF MIND.</p><h2 id="features-title">You don’t have to figure it out alone.</h2></div>
            <p>From the first “is this real?”<br />to knowing what to do next.</p>
          </div>
          <div className={styles.featureGrid}>
            {FEATURES.map((f, index) => (
              <article key={f.title} className={styles.feature}>
                <div className={styles.featureTop}><f.icon size={23} aria-hidden="true" /><span>0{index + 1}</span></div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="get-started" className={styles.getStarted} aria-labelledby="start-title">
          <div className={styles.startCopy}>
            <p className={styles.eyebrow}><LockKeyhole size={14} aria-hidden="true" /> A SAFER NEXT STEP STARTS HERE</p>
            <h2 id="start-title">Trust your instincts.<br /><span>Then ask Neo.</span></h2>
            <p>Bring the message, link, or question that’s on your mind. We’ll help you make sense of it.</p>
            <Link href="/privacy" className={styles.privacyLink}>Your privacy matters <ArrowRight size={14} aria-hidden="true" /></Link>
          </div>
          <div className={styles.signIn}>
            <h3>Welcome to Neo</h3>
            <p>Sign in to check something suspicious.</p>
            <SignInPanel providers={e.AUTH_PROVIDERS} />
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <Link href="/" className={styles.footerBrand} aria-label="Neo home"><NeoMark className={styles.footerMark} /> neo.</Link>
        <p>A little more clarity. A little less worry.</p>
        <div className={styles.footerLinks}><span>Free &amp; open source (MIT)</span><span aria-hidden="true">·</span><Link href="/privacy">Privacy policy</Link></div>
        <p className={styles.disclaimer}>Neo can make mistakes. When in doubt, don’t click.</p>
      </footer>
    </div>
  );
}
