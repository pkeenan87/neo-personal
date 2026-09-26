import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivacyPage, { PRIVACY_POLICY_UPDATED } from "@/app/privacy/page";

afterEach(() => vi.unstubAllEnvs());

describe("privacy policy page", () => {
  it("renders every section, the update date, and the contact address from env", () => {
    vi.stubEnv("NEO_CONTACT_EMAIL", "hello@example.test");
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeInTheDocument();
    expect(screen.getByText(PRIVACY_POLICY_UPDATED)).toBeInTheDocument();
    for (const title of ["What Neo collects", "How long it is kept", "Your choices", "Children"]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("link", { name: "hello@example.test" }).length).toBeGreaterThan(0);
    expect(PRIVACY_POLICY_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to the default contact address", () => {
    vi.stubEnv("NEO_CONTACT_EMAIL", "");
    render(<PrivacyPage />);
    expect(screen.getAllByRole("link", { name: "privacy@neoshield.dev" }).length).toBeGreaterThan(0);
  });
});
