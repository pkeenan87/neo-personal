import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme";

vi.mock("next/navigation", () => ({ usePathname: () => window.location.pathname }));

let systemDark: boolean;
let change: (() => void) | undefined;

beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard");
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
  systemDark = false;
  change = undefined;
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return systemDark; },
    addEventListener: (_: string, listener: () => void) => { change = listener; },
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
});

function renderTheme() {
  return render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
}

describe("appearance preferences", () => {
  it("follows system changes until the user chooses a theme and remembers that choice", async () => {
    const user = userEvent.setup();
    const view = renderTheme();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    act(() => { systemDark = true; change?.(); });
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await user.selectOptions(screen.getByRole("combobox", { name: "Appearance" }), "light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    act(() => change?.());
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    view.unmount();
    renderTheme();
    expect(screen.getByRole("combobox", { name: "Appearance" })).toHaveValue("light");
    await user.selectOptions(screen.getByRole("combobox", { name: "Appearance" }), "system");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("synchronizes controls and changes made in another tab", async () => {
    render(<ThemeProvider><ThemeToggle /><ThemeToggle /></ThemeProvider>);
    await userEvent.setup().selectOptions(screen.getAllByRole("combobox")[0]!, "dark");
    expect(screen.getAllByRole("combobox")[1]).toHaveValue("dark");
    act(() => {
      localStorage.setItem(THEME_STORAGE_KEY, "light");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getAllByRole("combobox")[0]).toHaveValue("light");
  });

  it("still switches appearance when browser storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    renderTheme();
    await userEvent.setup().selectOptions(screen.getByRole("combobox"), "dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("always renders the homepage light while keeping the saved preference", () => {
    systemDark = true;
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.history.replaceState(null, "", "/");
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.themePreference).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();

    renderTheme();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    act(() => change?.());
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("combobox", { name: "Appearance" })).toHaveValue("dark");
  });

  it.each(["light", "dark", "system", "invalid"])("applies saved %s appearance before hydration", (preference) => {
    systemDark = true;
    localStorage.setItem(THEME_STORAGE_KEY, preference);
    // Exercise the exact static script shipped in the document head.
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBe(preference === "light" ? "light" : "dark");
    expect(document.documentElement.dataset.themePreference).toBe(preference === "invalid" ? "system" : preference);
  });
});
