import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StopView } from "../src/views/StopView";
import { fakeClient, fakeShell, status } from "./helpers";

describe("StopView", () => {
  it("asks first and names who will be told", async () => {
    const client = fakeClient({ status: vi.fn(async () => status({ state: "enrolled", ownerName: "Pat" })) });
    render(<StopView client={client} shell={fakeShell()} />);
    expect(await screen.findByText("Pat")).toBeInTheDocument();
    expect(screen.getByText(/will be told/)).toBeInTheDocument();
    expect(client.unenroll).not.toHaveBeenCalled();
  });

  it("stops protecting only after the button, then closes", async () => {
    const client = fakeClient();
    const shell = fakeShell();
    render(<StopView client={client} shell={shell} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop protecting" }));
    expect(client.unenroll).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(shell.close).toHaveBeenCalled());
  });

  it("keeps protecting and does nothing else", async () => {
    const client = fakeClient();
    const shell = fakeShell();
    render(<StopView client={client} shell={shell} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Keep protecting" }));
    expect(client.unenroll).not.toHaveBeenCalled();
    expect(shell.close).toHaveBeenCalled();
  });

  it("stays open with a message when the owner could not be told", async () => {
    const client = fakeClient({ unenroll: vi.fn(async () => ({ ok: false as const, code: "server_unreachable", error: "x" })) });
    const shell = fakeShell();
    render(<StopView client={client} shell={shell} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop protecting" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Neo.");
    expect(shell.close).not.toHaveBeenCalled();
  });
});
