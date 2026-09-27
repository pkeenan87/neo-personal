"use client";

import { LayoutDashboard, LogOut, MessageSquare, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { NeoMark } from "./NeoMark";
import { ThemeToggle } from "./ThemeToggle";

export type NavKey = "dashboard" | "chat" | "settings";

export const NAV_ITEMS: { key: NavKey; href: string; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "dashboard", href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "chat", href: "/chat", label: "Chat", icon: MessageSquare },
  { key: "settings", href: "/settings/forwarding", label: "Settings", icon: Settings },
];

/** Settings pages, shown as a sub-navigation on every settings page. */
export const SETTINGS_LINKS: { href: string; label: string }[] = [
  { href: "/settings/household", label: "Household" },
  { href: "/settings/forwarding", label: "Forwarding" },
  { href: "/settings/routing", label: "Routing" },
  { href: "/settings/desktop", label: "Desktop" },
];

function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="mx-auto mb-7 grid w-full max-w-2xl grid-cols-2 gap-1 rounded-2xl border border-border bg-surface p-1.5 shadow-sm sm:grid-cols-4">
      {SETTINGS_LINKS.map((l) => {
        const current = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={current ? "page" : undefined}
            className={`flex min-h-11 items-center justify-center rounded-xl px-3 text-sm transition-colors ${
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
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(ellipse_at_top_right,var(--accent-soft),transparent_55%)]">
      <a href="#app-main" className="sr-only z-50 rounded-xl bg-accent px-4 py-3 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2">Skip to content</a>
      <header className="sticky top-0 z-20 border-b border-border bg-bg/90 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-3 py-3 sm:gap-3 sm:px-6">
          <Link href="/dashboard" aria-label="Neo dashboard" className="mr-1 flex shrink-0 items-center gap-1 text-2xl font-semibold tracking-tight sm:mr-5">
            <NeoMark className="size-10" />
            <span className="max-sm:hidden">neo<span className="text-accent">.</span></span>
          </Link>
          <nav aria-label="Main" className="flex min-w-0 flex-1 items-center gap-0.5">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active === item.key ? "page" : undefined}
                title={item.label}
                className={`flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-3 text-sm transition-colors ${
                  active === item.key ? "bg-accent-soft font-semibold text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                <item.icon className="size-4" aria-hidden="true" />
                <span className="max-sm:sr-only">{item.label}</span>
              </Link>
            ))}
          </nav>
          <ThemeToggle />
          <button
            type="button"
            onClick={() => void signOut()}
            aria-label="Sign out"
            title="Sign out"
            className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg"
          >
            <LogOut className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>
      <main id="app-main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 pt-7 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-10">
        {active === "settings" ? <SettingsNav /> : null}
        {children}
      </main>
    </div>
  );
}
