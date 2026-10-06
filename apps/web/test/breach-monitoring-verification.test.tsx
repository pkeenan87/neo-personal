import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreachAddressConfirmation } from "@/components/BreachAddressConfirmation";

const TOKEN = "A".repeat(43);
afterEach(() => vi.unstubAllGlobals());

describe("breach-address email confirmation page", () => {
  it("does not consume a token on page open and confirms only after the user's click", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "verified" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BreachAddressConfirmation token={TOKEN} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm address" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/breaches/addresses/verify", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: TOKEN }) }));
    expect(screen.getByRole("heading", { name: /address confirmed/i })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(/next weekly breach check/i);
  });

  it("offers same-account sign-in without consuming the token and returns to verification", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BreachAddressConfirmation token={TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm address" }));
    const link = await screen.findByRole("link", { name: /sign in to the same neo account/i });
    const url = new URL(link.getAttribute("href")!, "https://neo.example.test");
    expect(url.pathname).toBe("/api/auth/signin");
    expect(url.searchParams.get("callbackUrl")).toBe(`/settings/breaches/verify?token=${TOKEN}`);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not suggest signing in will repair an invalid or expired link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_or_expired_token" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BreachAddressConfirmation token={TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm address" }));
    expect(await screen.findByText(/invalid, expired, or already used/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign in to the same neo account/i })).not.toBeInTheDocument();
  });

  it("does not echo an invalid or expired bearer token", () => {
    render(<BreachAddressConfirmation token="" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/confirmation link is missing/i);
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
