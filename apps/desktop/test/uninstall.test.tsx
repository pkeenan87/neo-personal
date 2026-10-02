import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UninstallView } from "../src/views/UninstallView";
import { fakeClient, fakeShell, status } from "./helpers";

describe("UninstallView (macOS)", () => {
  it("asks first, names who will be told and mentions the administrator password", async () => {
    const client = fakeClient({ status: vi.fn(async () => status({ state: "enrolled", platform: "macos", ownerName: "Pat" })) });
    const shell = fakeShell();
    render(<UninstallView client={client} shell={shell} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Uninstall Neo?");
    expect(await screen.findByText("Pat")).toBeInTheDocument();
    expect(screen.getByText(/will be told/)).toBeInTheDocument();
    expect(screen.getByText("This removes Neo and its protection from this Mac. You will be asked for an administrator password.")).toBeInTheDocument();
    expect(shell.uninstallMac).not.toHaveBeenCalled();
  });

  it("falls back to 'the household owner' when no owner is known", async () => {
    render(<UninstallView client={fakeClient()} shell={fakeShell()} />);
    expect(await screen.findByText("the household owner")).toBeInTheDocument();
  });

  it("uninstalls only after the button", async () => {
    const shell = fakeShell();
    render(<UninstallView client={fakeClient()} shell={shell} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Uninstall" }));
    expect(shell.uninstallMac).toHaveBeenCalledTimes(1);
  });

  it("keeping Neo changes nothing", async () => {
    const shell = fakeShell();
    render(<UninstallView client={fakeClient()} shell={shell} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Keep Neo" }));
    expect(shell.uninstallMac).not.toHaveBeenCalled();
    expect(shell.close).toHaveBeenCalled();
  });

  it("stays open and says nothing changed when the password prompt was cancelled", async () => {
    const shell = fakeShell();
    shell.uninstallMac.mockRejectedValueOnce(new Error("cancelled"));
    render(<UninstallView client={fakeClient()} shell={shell} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Uninstall" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Neo was not uninstalled. If you cancelled the password window, nothing was changed.");
    expect(shell.close).not.toHaveBeenCalled();
  });
});
