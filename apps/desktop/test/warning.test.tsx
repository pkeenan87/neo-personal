import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Warning } from "../src/lib/types";
import { WarningView } from "../src/views/WarningView";
import { fakeShell } from "./helpers";

const session: Warning = { eventId: "e1", kind: "session", toolName: "AnyDesk", peerId: "123456789", severity: "critical", ownerName: "Pat", ownerTold: false };

describe("WarningView", () => {
  it("uses the spec's wording for an incoming session", () => {
    render(<WarningView warning={session} shell={fakeShell()} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Someone is connected to this computer with AnyDesk.");
    expect(
      screen.getByText("If someone called you and asked for this, it is a scam. Hang up the phone and restart your computer. Do not log in to your bank."),
    ).toBeInTheDocument();
  });

  it("says the owner was told only when ownerTold is true", () => {
    const { rerender } = render(<WarningView warning={session} shell={fakeShell()} />);
    expect(screen.queryByText(/let .* know/)).not.toBeInTheDocument();
    rerender(<WarningView warning={{ ...session, ownerTold: true }} shell={fakeShell()} />);
    expect(screen.getByText("Neo let Pat know.")).toBeInTheDocument();
  });

  it("never shows the peer ID in the plain-words window", () => {
    render(<WarningView warning={session} shell={fakeShell()} />);
    expect(screen.queryByText(/123456789/)).not.toBeInTheDocument();
  });

  it("has one button, and it only closes the window", async () => {
    const shell = fakeShell();
    render(<WarningView warning={session} shell={shell} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("I understand");
    await userEvent.setup().click(buttons[0]!);
    expect(shell.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'the household owner' when no owner name is known", () => {
    render(<WarningView warning={{ ...session, ownerName: "", ownerTold: true }} shell={fakeShell()} />);
    expect(screen.getByText("Neo let the household owner know.")).toBeInTheDocument();
  });

  describe("permission grants (macOS)", () => {
    const grant: Warning = { eventId: "e2", kind: "permission", toolName: "AnyDesk", service: "accessibility", severity: "critical", ownerName: "Pat", ownerTold: false };

    it("uses the spec's wording, adapted to the permission", () => {
      const advice = "If someone on the phone asked you to allow this, it is a scam. Hang up, then open System Settings \u2192 Privacy & Security and turn it off.";
      for (const [service, what] of [
        [undefined, "see and control this Mac"],
        ["screen_recording", "see your screen"],
        ["accessibility", "control this Mac"],
        ["full_disk_access", "read all your files"],
      ] as const) {
        const { unmount } = render(<WarningView warning={{ ...grant, service }} shell={fakeShell()} />);
        expect(screen.getByRole("heading")).toHaveTextContent(`AnyDesk can now ${what}.`);
        expect(screen.getByText(advice)).toBeInTheDocument();
        unmount();
      }
    });

    it("has one button that only closes the window", async () => {
      const shell = fakeShell();
      render(<WarningView warning={grant} shell={shell} />);
      expect(screen.getAllByRole("button")).toHaveLength(1);
      await userEvent.setup().click(screen.getByRole("button", { name: "I understand" }));
      expect(shell.close).toHaveBeenCalledTimes(1);
    });
  });
});
