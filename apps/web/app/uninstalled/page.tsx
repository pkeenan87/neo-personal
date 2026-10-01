/**
 * /uninstalled?d=<deviceId>&s=<sig> — public, no session (_specs/browser-extension.md
 * "Uninstall"). Opened by `runtime.setUninstallURL` when the extension is removed or
 * disabled. The secret is in the query string, so vercel.json sends `Referrer-Policy:
 * no-referrer` here, like /invite/*.
 */
import type { Metadata } from "next";
import { UninstalledView } from "@/components/UninstalledView";

export const metadata: Metadata = { title: "Neo removed", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default function UninstalledPage() {
  return <UninstalledView />;
}
