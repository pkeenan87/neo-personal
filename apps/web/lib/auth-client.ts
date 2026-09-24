/**
 * ─── STUB: REPLACE IN INTEGRATION PASS ───────────────────────────────
 * Client-side auth actions. The integration pass swaps the bodies for
 * `signIn` / `signOut` from `next-auth/react`:
 *
 *   signIn("google", { redirectTo: callbackUrl })
 *   signIn("resend", { email, redirectTo: callbackUrl })
 *   signOut({ redirectTo: "/" })
 *
 * Keep the exported signatures. Until then, sign-in simply navigates to
 * the callback URL; the server (lib/session.ts) lets you through only
 * when DEV_AUTH_BYPASS=true and otherwise bounces back to
 * `/?signin=required`.
 * ─────────────────────────────────────────────────────────────────────
 */

export type SignInProvider = "google" | "resend";

export interface SignInOptions {
  /** Required for the "resend" (email magic link) provider. */
  email?: string;
  /** Where to land after sign-in. Defaults to /chat. */
  callbackUrl?: string;
}

export interface SignInResult {
  ok: boolean;
  /** For "resend": true when a magic link was (or would be) emailed. */
  emailSent?: boolean;
  error?: string;
}

function navigate(url: string): void {
  window.location.assign(url);
}

export async function signIn(provider: SignInProvider, opts: SignInOptions = {}): Promise<SignInResult> {
  const callbackUrl = opts.callbackUrl ?? "/chat";
  if (provider === "resend") {
    const email = opts.email?.trim() ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: "Enter a valid email address." };
    }
  }
  navigate(callbackUrl);
  return { ok: true, emailSent: provider === "resend" };
}

export async function signOut(opts: { callbackUrl?: string } = {}): Promise<void> {
  navigate(opts.callbackUrl ?? "/");
}
