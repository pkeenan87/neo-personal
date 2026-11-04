import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Confirm } from "../src/lib/types";
import { ConfirmView } from "../src/views/ConfirmView";
import { fakeClient, fakeShell } from "./helpers";

const confirm: Confirm = { id: "c-1", kind: "end_session", title: "Your helper asked to end the remote session from AnyDesk.", body: "End it now?" };

describe("ConfirmView", () => {
  it("asks the question in plain words with two buttons", () => {
    render(<ConfirmView confirm={confirm} client={fakeClient()} shell={fakeShell()} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Your helper asked to end the remote session from AnyDesk.");
    expect(screen.getByText("End it now?")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["End the session", "Keep it"]);
  });

  it("sends 'end' for this command id and closes the window", async () => {
    const client = fakeClient();
    const shell = fakeShell();
    render(<ConfirmView confirm={confirm} client={client} shell={shell} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "End the session" }));
    expect(client.commandAnswer).toHaveBeenCalledWith("c-1", "end");
    expect(shell.close).toHaveBeenCalledTimes(1);
  });

  it("sends 'keep' and closes the window", async () => {
    const client = fakeClient();
    const shell = fakeShell();
    render(<ConfirmView confirm={confirm} client={client} shell={shell} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Keep it" }));
    expect(client.commandAnswer).toHaveBeenCalledWith("c-1", "keep");
    expect(shell.close).toHaveBeenCalledTimes(1);
  });

  it("does nothing until a button is chosen", () => {
    const client = fakeClient();
    const shell = fakeShell();
    render(<ConfirmView confirm={confirm} client={client} shell={shell} />);
    expect(client.commandAnswer).not.toHaveBeenCalled();
    expect(shell.close).not.toHaveBeenCalled();
  });

  it("stays open and says so when the service cannot be reached", async () => {
    const client = fakeClient({ commandAnswer: vi.fn(async () => ({ ok: false as const, code: "agent_unavailable", error: "down" })) });
    const shell = fakeShell();
    render(<ConfirmView confirm={confirm} client={client} shell={shell} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "End the session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Neo Protection isn't running");
    expect(shell.close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "End the session" })).toBeEnabled();
  });
});
