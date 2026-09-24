/**
 * Client-side auth actions on `next-auth/react`. Signatures are the stable
 * seam the UI uses (SignInPanel, ChatInterface).
 */
import { signIn as nextAuthSignIn, signOut as nextAuthSignOut } from "next-auth/react";
import { safeCallbackPath } from "./safe-redirect";

export type SignInProvider = "google" | "resend";

export interface SignInOptions {
  /** Required for the "resend" (email magic link) provider. */
  email?: string;
  /** Where to land after sign-in (same-origin path only). Defaults to /chat. */
  callbackUrl?: string;
}

export interface SignInResult {
  ok: boolean;
  /** For "resend": true when a magic link was emailed. */
  emailSent?: boolean;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signIn(provider: SignInProvider, opts: SignInOptions = {}): Promise<SignInResult> {
  const redirectTo = safeCallbackPath(opts.callbackUrl);
  if (provider === "google") {
    // Full-page redirect to Google; resolves only if navigation fails.
    await nextAuthSignIn("google", { redirectTo });
    return { ok: true };
  }
  const email = opts.email?.trim().toLowerCase() ?? "";
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  try {
    const res = await nextAuthSignIn("resend", { email, redirectTo, redirect: false });
    if (res?.error) return { ok: false, error: "We couldn't send a sign-in link. Please try again." };
    return { ok: true, emailSent: true };
  } catch {
    return { ok: false, error: "We couldn't send a sign-in link. Please try again." };
  }
}

export async function signOut(opts: { callbackUrl?: string } = {}): Promise<void> {
  await nextAuthSignOut({ redirectTo: safeCallbackPath(opts.callbackUrl, "/") });
}
