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

  it("discloses digest content, Inngest retry-state storage, and personal opt-out", () => {
    render(<PrivacyPage />);
    expect(screen.getByText("Weekly digests.")).toBeInTheDocument();
    expect(screen.getByText(/Resend receives your address and the rendered digest/)).toBeInTheDocument();
    expect(screen.getByText(/receives forwarded email for your household address and sends sign-in links, result emails, and weekly digests/)).toBeInTheDocument();
    expect(screen.getByText(/For weekly digest retries, it durably stores the recipient address and rendered digest in function state/)).toBeInTheDocument();
    expect(screen.getByText(/never member verdict details/)).toBeInTheDocument();
    expect(screen.getByText(/Inngest durably stores the recipient address and rendered digest in\s+function state/)).toBeInTheDocument();
    expect(screen.getByText(/not in the database delivery records or digest fan-out events/)).toBeInTheDocument();
    expect(screen.getByText(/not verified a retention period for Inngest function state/)).toBeInTheDocument();
    expect(screen.getByText(/For weekly digest retries, it durably stores the recipient address and rendered digest in function state; digest fan-out events carry only record identifiers/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings → Digest" })).toHaveAttribute("href", "/settings/digest");
  });

  it("falls back to the default contact address", () => {
    vi.stubEnv("NEO_CONTACT_EMAIL", "");
    render(<PrivacyPage />);
    expect(screen.getAllByRole("link", { name: "privacy@neoshield.dev" }).length).toBeGreaterThan(0);
  });
});
