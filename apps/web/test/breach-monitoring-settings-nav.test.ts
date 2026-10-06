import { describe, expect, it } from "vitest";
import { SETTINGS_LINKS } from "@/components/AppShell";

describe("settings navigation", () => {
  it("links to breach monitoring", () => {
    expect(SETTINGS_LINKS).toContainEqual({ href: "/settings/breaches", label: "Breaches" });
  });

  it("links to the hardening checklist", () => {
    expect(SETTINGS_LINKS).toContainEqual({ href: "/settings/hardening", label: "Hardening" });
  });
});
