import type { Metadata } from "next";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Chat" };

/** Auth gate for everything under /chat. */
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  return children;
}
