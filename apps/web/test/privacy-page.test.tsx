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

  it("lists the model routing processors", () => {
    render(<PrivacyPage />);
    for (const name of ["Vercel AI Gateway", "TypeSafe AI", "OpenAI", "Moonshot AI", "xAI"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("explains what protected devices send and who is told", () => {
    render(<PrivacyPage />);
    expect(screen.getByText("Protected devices.")).toBeInTheDocument();
    expect(screen.getByText(/checks in regularly with its app version and the time/)).toBeInTheDocument();
    expect(screen.getByText(/removing one tells the owner/)).toBeInTheDocument();
  });

  it("explains device signals: what they contain, retention, and expected tools (_specs/signals.md)", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/domain of a page that looked like a scam \(never the/)).toBeInTheDocument();
    expect(screen.getByText(/remote peer ID during a remote-access session/)).toBeInTheDocument();
    expect(screen.getByText(/screen-recording or accessibility permission grants/)).toBeInTheDocument();
    expect(screen.getByText(/On a Mac, with your permission \(Full Disk Access\), Neo\s+also checks which apps were newly allowed to record your screen/)).toBeInTheDocument();
    expect(screen.getByText(/sends only the app's name and which permission changed/)).toBeInTheDocument();
    expect(screen.getByText("Signal records")).toBeInTheDocument();
    expect(screen.getByText(/a protected device reports are kept for 30 days\./)).toBeInTheDocument();
    expect(screen.getByText(/mark a remote-access tool as expected on a device/)).toBeInTheDocument();
  });

  it("discloses encrypted digest retries, payload retention, secret rotation, and personal opt-out", () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? "";
    expect(screen.getByText("Weekly digests.")).toBeInTheDocument();
    expect(text).toContain("Resend receives your address and the rendered digest to deliver it.");
    expect(text).toContain("phone-like digit runs and long alphanumeric tokens redacted");
    expect(text).toContain("stores the exact request encrypted in the tenant-scoped delivery ledger");
    expect(text).toContain("Inngest step state and digest fan-out events contain no address or rendered request");
    expect(text).toContain("The daily sweep removes non-sending payloads and sending payloads at least 24 hours old");
    expect(text).toContain("under the daily schedule, encrypted request bytes may remain roughly 24–48 hours after creation");
    expect(text).not.toContain("within 24 hours");
    expect(text).toContain("Rotating `AUTH_SECRET` invalidates existing digest unsubscribe links");
    expect(text).toContain("Weekly digest events and step state carry only identifiers/status");
    expect(text).toContain("Weekly digest request payloads");
    expect(text).toContain("never member verdict details");
    expect(screen.getByRole("link", { name: "Settings → Digest" })).toHaveAttribute("href", "/settings/digest");
  });

  it("discloses breach monitoring data, HIBP processing, weekly cadence, and deletion", () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Have I Been Pwned");
    expect(text).toContain("verified sign-in email");
    expect(text).toContain("Additional addresses require email confirmation");
    expect(text).toContain("checked weekly");
    expect(text).toContain("encrypted at rest");
    expect(text).toContain("breach names, dates and data types");
    expect(text).toContain("when an address is removed, when you leave the household, or when the owner removes you");
    expect(text).toContain("CC BY 4.0");
    expect(text).toContain("additional-address confirmation emails containing a single-use confirmation URL");
    expect(text).toContain("single-use confirmation URL");
    expect(text).toContain("Encrypted copies in provider-managed backups may remain until those backups expire");
  });

  it("discloses self-reported hardening answers and what the owner can see", () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Account-hardening checklist.");
    expect(text).toContain("self-reported");
    expect(text).toContain("stored per household member");
    expect(text).toContain("A household owner sees only your percentage score");
    expect(text).toContain("never your individual answers");
  });

  it("discloses the sign-in alert facts it stores from forwarded mail", () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Sign-in alerts.");
    expect(text).toContain("the provider, the kind of event, the device label, a coarse location, and the time");
    expect(text).toContain("A household owner sees only the resulting alert, never the list of your sign-in events");
  });

  it("falls back to the default contact address", () => {
    vi.stubEnv("NEO_CONTACT_EMAIL", "");
    render(<PrivacyPage />);
    expect(screen.getAllByRole("link", { name: "privacy@neoshield.dev" }).length).toBeGreaterThan(0);
  });
});
