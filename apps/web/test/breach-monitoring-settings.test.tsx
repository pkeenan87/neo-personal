import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreachMonitoringSettings } from "@/components/BreachMonitoringSettings";
import type { BreachStatusSnapshot } from "@/lib/server/breach-monitoring/status-service";

const initial: BreachStatusSnapshot = {
  status: "breached",
  lastSuccessfulCheckAt: "2026-10-05T12:00:00.000Z",
  pendingCount: 1,
  attribution: { label: "Have I Been Pwned", url: "https://haveibeenpwned.com", license: "CC BY 4.0" },
  addresses: [
    { id: "primary-id", email: "primary@example.com", source: "sign_in", verificationStatus: "verified", status: "breached", verifiedAt: "2026-10-01T00:00:00.000Z", lastCheckedAt: "2026-10-05T12:00:00.000Z", lastSuccessfulCheckAt: "2026-10-05T12:00:00.000Z", observations: [{ breachName: "Example Breach", domain: "example.com", breachDate: "2024-01-02", addedDate: null, dataClasses: ["Passwords"], firstSeenAt: "2026-10-05T12:00:00.000Z", lastSeenAt: "2026-10-05T12:00:00.000Z", retiredAt: null }] },
    { id: "extra-id", email: "extra@example.com", source: "extra", verificationStatus: "verified", status: "clean", verifiedAt: "2026-10-01T00:00:00.000Z", lastCheckedAt: "2026-10-05T12:00:00.000Z", lastSuccessfulCheckAt: "2026-10-05T12:00:00.000Z", observations: [] },
    { id: "pending-id", email: "pending@example.com", source: "extra", verificationStatus: "pending", status: "pending", verifiedAt: null, lastCheckedAt: null, lastSuccessfulCheckAt: null, observations: [] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("breach monitoring Settings", () => {
  it("shows truthful per-address status, breach metadata, attribution, and locks the sign-in address", () => {
    render(<BreachMonitoringSettings initial={initial} />);
    expect(screen.getByTestId("breach-status-line")).toHaveTextContent(/breach monitoring: breached/i);
    expect(screen.getByText("primary@example.com")).toBeInTheDocument();
    expect(screen.getByText("Example Breach")).toBeInTheDocument();
    expect(screen.getByText("No current breach found")).toBeInTheDocument();
    expect(screen.getByText("Awaiting email confirmation")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Have I Been Pwned/i })).toHaveAttribute("href", "https://haveibeenpwned.com");
    expect(screen.queryByRole("button", { name: /remove primary@example.com/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove extra@example.com/i })).toBeInTheDocument();
  });

  it("labels an old observation that was absent from a later clean check as history", () => {
    const cleanHistory: BreachStatusSnapshot = {
      ...initial,
      status: "clean",
      addresses: initial.addresses.map((address) => address.id === "primary-id" ? {
        ...address,
        status: "clean",
        lastSuccessfulCheckAt: "2026-10-05T12:00:00.000Z",
        observations: address.observations.map((observation) => ({ ...observation, lastSeenAt: "2026-10-01T12:00:00.000Z" })),
      } : address),
    };
    render(<BreachMonitoringSettings initial={cleanHistory} />);
    expect(screen.getByText(/not returned in the latest check; retained in history/i)).toBeInTheDocument();
  });

  it("requests verification for an additional address and reports pending confirmation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending_confirmation" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(initial), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BreachMonitoringSettings initial={initial} />);
    fireEvent.change(screen.getByRole("textbox", { name: /additional email address/i }), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send confirmation/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/settings/breaches/addresses");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ email: "new@example.com" });
    expect(await screen.findByRole("status")).toHaveTextContent(/confirmation email sent/i);
  });

  it("deletes only the selected additional address", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...initial, addresses: initial.addresses.filter((a) => a.id !== "extra-id") }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BreachMonitoringSettings initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: /remove extra@example.com/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/settings/breaches/addresses/extra-id");
    expect(await screen.findByText("primary@example.com")).toBeInTheDocument();
  });
});
