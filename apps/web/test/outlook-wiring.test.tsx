import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacy/page";
import { OutlookSettings } from "@/components/OutlookSettings";
import { SETTINGS_LINKS } from "@/components/AppShell";
import { functions } from "@/inngest/functions";
import { outlookAudit, outlookAuditCron, outlookPoll, outlookPollCron, OUTLOOK_POLL_CRON } from "@/inngest/functions/outlook";
import { ALERT_KINDS } from "@neo/db";
import { outlookEnv } from "@/lib/env";
import { mailboxForwardingAlertText } from "@/lib/server/alerts/templates";

const view = (over = {}) => ({ mode: "mock" as const, connector: null, findings: [], appAccessUrl: "https://account.microsoft.com/privacy/app-access", ...over });

describe("Outlook wiring", () => {
  it("registers the functions, the nav link and the alert kind", () => {
    for (const f of [outlookPollCron, outlookAuditCron, outlookPoll, outlookAudit]) expect(functions).toContain(f);
    expect(OUTLOOK_POLL_CRON).toBe("*/15 * * * *");
    expect(SETTINGS_LINKS).toContainEqual({ href: "/settings/outlook", label: "Outlook" });
    expect(ALERT_KINDS).toContain("mailbox_forwarding");
    expect(mailboxForwardingAlertText("Max", "mail-drop.example")).toMatchObject({ severity: "high" });
  });
  it("is off unless all three vars and the master key are set (MOCK_MODE uses the fake flow)", () => {
    expect(outlookEnv({}).mode).toBe("off");
    expect(outlookEnv({ OUTLOOK_CLIENT_ID: "a", OUTLOOK_CLIENT_SECRET: "b", OUTLOOK_REDIRECT_URI: "https://x/cb" }).mode).toBe("off");
    expect(outlookEnv({ OUTLOOK_CLIENT_ID: "a", OUTLOOK_CLIENT_SECRET: "b", OUTLOOK_REDIRECT_URI: "https://x/cb", NEO_MASTER_KEY: "k" }).mode).toBe("live");
    expect(outlookEnv({ MOCK_MODE: "true" }).mode).toBe("mock");
    expect(outlookEnv({ MOCK_MODE: "true", NODE_ENV: "production" }).mode).toBe("off");
  });
  it("settings page: disabled message, connect button, status and owner view", () => {
    const { unmount } = render(<OutlookSettings initial={view({ mode: "off" })} notice={null} isOwner={false} />);
    expect(screen.getByText(/not available on this server/)).toBeInTheDocument();
    expect(screen.getByText(/cannot verify account-level forwarding/)).toBeInTheDocument();
    unmount();
    const r2 = render(<OutlookSettings initial={view()} notice="denied" isOwner={false} />);
    expect(screen.getByRole("button", { name: "Connect Outlook.com" })).toBeInTheDocument();
    expect(screen.getByText(/declined access/)).toBeInTheDocument();
    r2.unmount();
    render(<OutlookSettings isOwner initial={view({ connector: { status: "connected", displayAddress: "a@outlook.com", lastAuditAt: null, lastPollAt: null }, findings: [{ id: "1", state: "active", action: "redirect_to", destinationDomain: "mail-drop.example", observedAt: "2026-10-05T00:00:00Z", resolvedAt: null }], household: [{ userId: "m", name: "Max", status: "connected", lastCheckAt: null }] })} notice={null} />);
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.getByText(/outside address at mail-drop.example/)).toBeInTheDocument();
    expect(screen.getByText(/Max: Connected/)).toBeInTheDocument();
  });
  it("privacy page states scopes, what is read and stored, and how to disconnect", () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Outlook.com connector.");
    for (const s of ["offline_access", "User.Read", "Mail.Read", "MailboxSettings.Read"]) expect(text).toContain(s);
    expect(text).toContain("polls your Inbox every 15 minutes");
    expect(text).toContain("never stores message bodies");
    expect(text).toContain("cannot see account-level forwarding");
    expect(text).toContain("keyed fingerprint of each processed message id");
    expect(text).toContain("for 45 days");
    expect(text).toContain("never visits or fetches links found in your mail");
    expect(screen.getByRole("link", { name: "account.microsoft.com/privacy/app-access" })).toHaveAttribute("href", "https://account.microsoft.com/privacy/app-access");
  });
});
