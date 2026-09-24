import type { Metadata } from "next";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env } from "@/lib/env";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Chat" };

/** Auth gate for everything under /chat. */
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  if (!env().DEV_AUTH_BYPASS) return children;
  return (
    <>
      <DevBypassBanner />
      {children}
    </>
  );
}
