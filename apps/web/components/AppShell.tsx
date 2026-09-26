"use client";

import { LayoutDashboard, LogOut, MessageSquare, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { NeoMark } from "./NeoMark";

export type NavKey = "dashboard" | "chat" | "settings";

export const NAV_ITEMS: { key: NavKey; href: string; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "dashboard", href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "chat", href: "/chat", label: "Chat", icon: MessageSquare },
  { key: "settings", href: "/settings/forwarding", label: "Settings", icon: Settings },
];

/** Settings pages, shown as a sub-navigation on every settings page. */
export const SETTINGS_LINKS: { href: string; label: string }[] = [
  { href: "/settings/forwarding", label: "Forwarding" },
  { href: "/settings/routing", label: "Routing" },
];

function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="mx-auto mb-5 flex w-full max-w-2xl gap-1">
      {SETTINGS_LINKS.map((l) => {
        const current = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={current ? "page" : undefined}
            className={`flex min-h-9 items-center rounded-lg px-3 text-sm ${
              current ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Top navigation for signed-in pages outside the chat (dashboard, verdict detail). */
export function AppShell({ active, children }: { active?: NavKey; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-bg/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-1 px-3 py-2 sm:gap-3 sm:px-4">
          <Link href="/dashboard" className="mr-1 flex items-center gap-2 font-semibold sm:mr-3">
            <NeoMark className="size-6 text-accent" />
            <span className="max-sm:sr-only">Neo</span>
          </Link>
          <nav aria-label="Main" className="flex min-w-0 flex-1 items-center gap-0.5">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active === item.key ? "page" : undefined}
                className={`flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm ${
                  active === item.key ? "bg-surface-2 font-semibold" : "text-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                <item.icon className="size-4" aria-hidden="true" />
                {item.label}
              </Link>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => void signOut()}
            aria-label="Sign out"
            className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg"
          >
            <LogOut className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-6 sm:px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {active === "settings" ? <SettingsNav /> : null}
        {children}
      </main>
    </div>
  );
}
