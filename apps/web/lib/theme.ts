export type Theme = "light" | "dark" | "system";
export const THEME_STORAGE_KEY = "neo-theme";
export const THEME_EVENT = "neo-theme-change";
/** Routes that always render light regardless of the saved preference (the marketing homepage). */
export const FIXED_LIGHT_PATHS: readonly string[] = ["/"];

export function isFixedLightPath(pathname: string): boolean {
  return FIXED_LIGHT_PATHS.includes(pathname);
}

/** Browser chrome (`theme-color`) for each resolved theme; matches `--bg` in globals.css. */
export const THEME_COLORS = { light: "#f6f9f7", dark: "#07110e" } as const;

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme, pathname: string = window.location.pathname) {
  const dark =
    !isFixedLightPath(pathname) &&
    (theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches));
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePreference = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? THEME_COLORS.dark : THEME_COLORS.light);
}

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.themePreference;
  return isTheme(value) ? value : "system";
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The current session can still change theme when storage is unavailable.
  }
  applyTheme(theme);
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function subscribeTheme(callback: () => void) {
  window.addEventListener(THEME_EVENT, callback);
  return () => window.removeEventListener(THEME_EVENT, callback);
}

// Runs before the body paints so a saved preference never flashes the other theme.
// Only the compile-time THEME_COLORS and FIXED_LIGHT_PATHS constants (plain
// path literals) are interpolated, never user input.
// If the Content-Security-Policy is ever enforced with nonces, this inline
// script must carry the request nonce.
export const THEME_INIT_SCRIPT = `(()=>{let t="system";try{const v=localStorage.getItem("neo-theme");if(v==="light"||v==="dark")t=v}catch{}const d=![${FIXED_LIGHT_PATHS.map((path) => `"${path}"`).join(",")}].includes(location.pathname)&&(t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches));document.documentElement.dataset.theme=d?"dark":"light";document.documentElement.dataset.themePreference=t;document.querySelector('meta[name="theme-color"]')?.setAttribute("content",d?"${THEME_COLORS.dark}":"${THEME_COLORS.light}")})()`;
