import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnrollView } from "../src/views/EnrollView";
import { PermissionsView } from "../src/views/PermissionsView";
import { fakeClient, fakeShell, status } from "./helpers";

describe("PermissionsView (Full Disk Access step)", () => {
  it("says why in plain words, and that Neo never asks for this on a call", () => {
    render(<PermissionsView client={fakeClient()} shell={fakeShell()} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Let Neo check app permissions");
    expect(screen.getByText(/Scammers make you allow screen recording or control of your Mac/)).toBeInTheDocument();
    expect(screen.getByText("This is the only setting Neo asks for, and you can turn it off any time.")).toBeInTheDocument();
    expect(screen.getByText(/Neo will never ask you to do this on a phone call/)).toBeInTheDocument();
  });

  it("opens System Settings and shows Neo Protection in Finder, nothing else", async () => {
    const user = userEvent.setup();
    const shell = fakeShell();
    const client = fakeClient();
    render(<PermissionsView client={client} shell={shell} />);
    await user.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(shell.openFullDiskAccess).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Show Neo Protection in Finder" }));
    expect(shell.showDaemonInFinder).toHaveBeenCalledTimes(1);
    expect(client.probePermissions).not.toHaveBeenCalled();
    expect(shell.close).not.toHaveBeenCalled();
  });

  it("asks the service to probe on Done and shows success", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    const shell = fakeShell();
    render(<PermissionsView client={client} shell={shell} />);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(client.probePermissions).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent("Neo can now check app permissions.");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(shell.close).toHaveBeenCalled();
  });

  it("explains a grant that is not visible yet and lets the person try again", async () => {
    const user = userEvent.setup();
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, fullDiskAccess: false, restarting: false })
      .mockResolvedValueOnce({ ok: true as const, fullDiskAccess: true, restarting: false });
    render(<PermissionsView client={fakeClient({ probePermissions: probe })} shell={fakeShell()} />);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Neo can't read it yet. Make sure Neo Protection is switched on in the list, then press Done again.");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Neo can now check app permissions.")).toBeInTheDocument();
  });

  it("says the service is restarting, both when it tells us and when it stops answering", async () => {
    const user = userEvent.setup();
    const restarting = fakeClient({ probePermissions: vi.fn(async () => ({ ok: true as const, fullDiskAccess: false, restarting: true })) });
    const { unmount } = render(<PermissionsView client={restarting} shell={fakeShell()} />);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Neo is restarting to pick up the change.");
    unmount();

    const gone = fakeClient({ probePermissions: vi.fn(async () => ({ ok: false as const, code: "agent_unavailable", error: "x" })) });
    render(<PermissionsView client={gone} shell={fakeShell()} />);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Neo is restarting to pick up the change.");
  });

  it("can be skipped, and skipping probes nothing", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    const shell = fakeShell();
    render(<PermissionsView client={client} shell={shell} />);
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(shell.close).toHaveBeenCalledTimes(1);
    expect(client.probePermissions).not.toHaveBeenCalled();
  });

  it("tells the person when System Settings could not be opened", async () => {
    const user = userEvent.setup();
    const shell = fakeShell();
    shell.openFullDiskAccess.mockRejectedValueOnce(new Error("no"));
    render(<PermissionsView client={fakeClient()} shell={shell} />);
    await user.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open System Settings.");
  });
});

describe("EnrollView and the Full Disk Access step", () => {
  const enrolledMac = (fullDiskAccess: boolean | null) =>
    status({ state: "enrolled", platform: "macos", fullDiskAccess, memberName: "Grandma", householdName: "The Keenans" });

  it("continues to the step on a Mac without Full Disk Access", async () => {
    const user = userEvent.setup();
    const client = fakeClient({ status: vi.fn(async () => enrolledMac(false)) });
    render(<EnrollView client={client} shell={fakeShell()} />);
    expect(await screen.findByText("Neo is protecting this computer.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading")).toHaveTextContent("Let Neo check app permissions");
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeInTheDocument();
  });

  it("goes straight to Done when the access is already on, or on Windows", async () => {
    for (const s of [enrolledMac(true), enrolledMac(null), status({ state: "enrolled" })]) {
      const { unmount } = render(<EnrollView client={fakeClient({ status: vi.fn(async () => s) })} shell={fakeShell()} />);
      expect(await screen.findByRole("button", { name: "Done" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
      unmount();
    }
  });
});
