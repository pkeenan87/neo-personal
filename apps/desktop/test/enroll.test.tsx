import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnrollView } from "../src/views/EnrollView";
import { fakeClient, fakeShell, status } from "./helpers";

describe("EnrollView", () => {
  it("offers the two ways in when the computer is not enrolled", async () => {
    render(<EnrollView client={fakeClient()} shell={fakeShell()} />);
    expect(await screen.findByRole("button", { name: "I have a code from my family" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with my Neo account" })).toBeInTheDocument();
  });

  it("says so when the computer is already protected", async () => {
    const client = fakeClient({ status: vi.fn(async () => status({ state: "enrolled", memberName: "Grandma", householdName: "The Keenans" })) });
    render(<EnrollView client={client} shell={fakeShell()} />);
    expect(await screen.findByText("Neo is protecting this computer.")).toBeInTheDocument();
  });

  it("goes code, preview, consent, enroll with the spec's consent copy", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    render(<EnrollView client={client} shell={fakeShell()} />);
    await user.click(await screen.findByRole("button", { name: "I have a code from my family" }));
    await user.type(screen.getByLabelText(/Enter the code/), "  ABCD-1234 ");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(client.enrollPreview).toHaveBeenCalledWith("ABCD-1234", undefined);
    const consent = await screen.findByText(/This computer will warn you about remote-access scams/);
    expect(consent.textContent).toBe(
      "This computer will warn you about remote-access scams and tell Pat (household The Keenans) when it finds one. Neo never sends the list of your programs, your files or your browsing.",
    );
    // The device name defaults to the Windows computer name and is editable.
    const name = screen.getByLabelText("Name for this computer");
    expect(name).toHaveValue("GRANDMA-PC");
    await user.clear(name);
    await user.type(name, "Grandma's PC");
    await user.click(screen.getByRole("button", { name: "Turn on protection" }));

    expect(client.enroll).toHaveBeenCalledWith("ABCD-1234", "Grandma's PC", undefined);
    expect(await screen.findByText("Neo is protecting this computer.")).toBeInTheDocument();
  });

  it("falls back to 'the household owner' when the code does not name one", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      enrollPreview: vi.fn(async () => ({ ok: true as const, householdName: "The Keenans", memberName: null, ownerName: null, expiresAt: "" })),
    });
    render(<EnrollView client={client} shell={fakeShell()} />);
    await user.click(await screen.findByRole("button", { name: "I have a code from my family" }));
    await user.type(screen.getByLabelText(/Enter the code/), "X");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/tell/)).toHaveTextContent("tell the household owner (household The Keenans)");
  });

  it("shows a plain message for a bad code and stays on the code screen", async () => {
    const user = userEvent.setup();
    const client = fakeClient({ enrollPreview: vi.fn(async () => ({ ok: false as const, code: "invalid_code", error: "x" })) });
    render(<EnrollView client={client} shell={fakeShell()} />);
    await user.click(await screen.findByRole("button", { name: "I have a code from my family" }));
    await user.type(screen.getByLabelText(/Enter the code/), "nope");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't valid, or it has expired.");
    expect(screen.getByLabelText(/Enter the code/)).toBeInTheDocument();
  });

  it("passes a custom server address only when it was changed under Advanced", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    render(<EnrollView client={client} shell={fakeShell()} />);
    await user.click(await screen.findByRole("button", { name: "Advanced" }));
    const server = screen.getByLabelText(/Server address/);
    expect(server).toHaveValue("https://www.neoshield.dev");
    await user.clear(server);
    await user.type(server, "https://neo.example.org");
    await user.click(screen.getByRole("button", { name: "I have a code from my family" }));
    await user.type(screen.getByLabelText(/Enter the code/), "C1");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(client.enrollPreview).toHaveBeenCalledWith("C1", "https://neo.example.org");
  });

  const flowStart = {
    ok: true as const,
    userCode: "ABCD-EFGH",
    verificationUri: "https://neo.test/desktop/authorize",
    verificationUriComplete: "https://neo.test/desktop/authorize?code=ABCD-EFGH",
    expiresIn: 600,
    interval: 3600,
  };

  it("signs in with the device flow: opens the browser and shows the code while waiting", async () => {
    const user = userEvent.setup();
    const shell = fakeShell();
    const client = fakeClient({ selfEnrollStart: vi.fn(async () => flowStart) });
    render(<EnrollView client={client} shell={shell} />);
    await user.click(await screen.findByRole("button", { name: "Sign in with my Neo account" }));
    expect(client.selfEnrollStart).toHaveBeenCalledWith("GRANDMA-PC", undefined);
    expect(shell.openUrl).toHaveBeenCalledWith("https://neo.test/desktop/authorize?code=ABCD-EFGH");
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "I have a code from my family" })).toBeInTheDocument();
  });

  it("finishes when the browser sign-in is approved", async () => {
    const user = userEvent.setup();
    let enrolled = false;
    const client = fakeClient({
      selfEnrollStart: vi.fn(async () => ({ ...flowStart, interval: 0 })),
      selfEnrollPoll: vi.fn(async () => {
        enrolled = true;
        return { ok: true as const, status: "approved" as const };
      }),
      status: vi.fn(async () => (enrolled ? status({ state: "enrolled", memberName: "Grandma", householdName: "The Keenans" }) : status())),
    });
    render(<EnrollView client={client} shell={fakeShell()} />);
    await user.click(await screen.findByRole("button", { name: "Sign in with my Neo account" }));
    expect(await screen.findByText("Neo is protecting this computer.")).toBeInTheDocument();
  });

  it("returns to the choice when the sign-in is declined", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      selfEnrollStart: vi.fn(async () => ({
        ok: true as const,
        userCode: "Z",
        verificationUri: "https://neo.test/a",
        verificationUriComplete: "https://neo.test/a?c=Z",
        expiresIn: 600,
        interval: 0,
      })),
      selfEnrollPoll: vi.fn(async () => ({ ok: true as const, status: "denied" as const })),
    });
    render(<EnrollView client={client} shell={fakeShell()} />);
    await user.click(await screen.findByRole("button", { name: "Sign in with my Neo account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The sign-in was declined in the browser.");
  });

  it("explains when the service is not running", async () => {
    const client = fakeClient({ status: vi.fn(async () => ({ ok: false as const, code: "agent_unavailable", error: "x" })) });
    render(<EnrollView client={client} shell={fakeShell()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Neo Protection isn't running on this computer.");
  });
});
