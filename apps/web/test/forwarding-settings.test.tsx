import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForwardingSettingsView } from "@/components/ForwardingSettings";
import { ToastProvider } from "@/components/toast-context";
import type { ForwardingSettings } from "@/lib/forwarding-types";

const BASE: ForwardingSettings = {
  address: "check-abcdefghjkmn@inbound.example.test",
  localPart: "check-abcdefghjkmn",
  configured: true,
  acceptedSenders: ["alex@example.test"],
  canRotate: true,
  gmailConfirmation: null,
  messages: [
    { id: "m1", status: "done", reason: null, receivedAt: new Date().toISOString(), completedAt: null, verdictId: "v-1" },
    { id: "m2", status: "rejected", reason: "unknown_sender", receivedAt: new Date().toISOString(), completedAt: null, verdictId: null },
  ],
};

function renderView(s: ForwardingSettings = BASE) {
  return render(
    <ToastProvider>
      <ForwardingSettingsView initial={s} />
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ForwardingSettingsView", () => {
  it("shows the address, guides as tabs, and links done messages to their verdict", async () => {
    renderView();
    expect(screen.getByTestId("inbound-address")).toHaveTextContent(BASE.address!);
    expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View result" })).toHaveAttribute("href", "/verdicts/v-1");
    expect(screen.getByText(/isn't on your account/)).toBeInTheDocument();

    expect(screen.getByRole("tab", { name: "Gmail" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Yahoo" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/paid Yahoo Mail feature/);
    await userEvent.click(screen.getByRole("tab", { name: "One-off check" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/as an attachment/);
  });

  it("shows the Gmail confirmation code when present", () => {
    renderView({ ...BASE, gmailConfirmation: { code: "482915736", receivedAt: new Date().toISOString() } });
    expect(screen.getByTestId("gmail-code")).toHaveTextContent("482915736");
  });

  it("rotates only after confirmation", async () => {
    const next = { ...BASE, address: "check-zzzzzzzzzzzz@inbound.example.test", localPart: "check-zzzzzzzzzzzz" };
    const fetchMock = vi.fn(async () => Response.json(next));
    vi.stubGlobal("fetch", fetchMock);
    renderView();
    await userEvent.click(screen.getByRole("button", { name: /Rotate address/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/stops working immediately/);
    await userEvent.click(screen.getByRole("button", { name: "Yes, rotate" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/forwarding", expect.objectContaining({ method: "POST" }));
    await vi.waitFor(() => expect(screen.getByTestId("inbound-address")).toHaveTextContent(next.address));
  });

  it("hides rotation for members", () => {
    renderView({ ...BASE, canRotate: false });
    expect(screen.queryByRole("button", { name: /Rotate address/ })).toBeNull();
  });
});
