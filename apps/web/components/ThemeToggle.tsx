"use client";

import { ChevronDown, Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { currentTheme, isTheme, setTheme, subscribeTheme, type Theme } from "@/lib/theme";

const serverTheme = (): Theme => "system";

/** Native select supports keyboard, touch, and screen readers without a custom menu. */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, serverTheme);
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <div className="relative flex shrink-0 items-center text-muted">
      <Icon className="pointer-events-none absolute left-3 size-4" aria-hidden="true" />
      <select
        aria-label="Appearance"
        value={theme}
        onChange={(event) => { if (isTheme(event.target.value)) setTheme(event.target.value); }}
        className="min-h-11 w-11 cursor-pointer appearance-none rounded-xl border border-border bg-surface pl-10 pr-0 text-sm text-transparent transition-colors hover:border-border-strong sm:w-auto sm:pr-8 sm:text-fg"
      >
        <option value="system" className="bg-surface text-fg">System</option>
        <option value="light" className="bg-surface text-fg">Light</option>
        <option value="dark" className="bg-surface text-fg">Dark</option>
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 hidden size-3.5 sm:block" aria-hidden="true" />
    </div>
  );
}
