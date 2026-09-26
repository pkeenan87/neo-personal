"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { applyTheme, currentTheme, storedTheme, THEME_EVENT, THEME_STORAGE_KEY } from "@/lib/theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Re-applied on every route change so fixed-light routes (see FIXED_LIGHT_PATHS)
  // switch in and out correctly during client-side navigation.
  useEffect(() => {
    applyTheme(storedTheme());
    window.dispatchEvent(new Event(THEME_EVENT));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (currentTheme() === "system") applyTheme("system");
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      applyTheme(storedTheme());
      window.dispatchEvent(new Event(THEME_EVENT));
    };
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [pathname]);

  return children;
}
