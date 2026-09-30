import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HouseholdSettingsView } from "@/components/HouseholdSettings";
import type { RemoteAccessToolOption } from "@/components/household/DevicesSection";
import { Toaster } from "@/components/Toaster";
import { ToastProvider } from "@/components/toast-context";
import type { HouseholdResponse } from "@/lib/dashboard-types";
import type { DeviceItem, EnrollmentCodeItem } from "@/lib/household-types";

const HOUR = 3_600_000;

function device(over: Partial<DeviceItem> = {}): DeviceItem {
  return {
    id: crypto.randomUUID(),
    userId: "u-gran",
    memberName: "Grandma",
    kind: "browser_extension",
    platform: "chrome",
    name: "Grandma's Chrome",
    clientVersion: "0.1.0",
    enrollment: "code",
    enrolledByName: "Pat",
    createdAt: new Date(Date.now() - 72 * HOUR).toISOString(),
    lastSeenAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    status: "active",
    expectedTools: [],
    ...over,
  };
}

const TOOLS: RemoteAccessToolOption[] = [
  { id: "anydesk", name: "AnyDesk" },
  { id: "teamviewer", name: "TeamViewer" },
];

const CHROME = device({ id: "d-chrome" });
const PC = device({
  id: "d-pc",
  kind: "desktop_agent",
  platform: "windows",
  name: "Living room PC",
  lastSeenAt: new Date(Date.now() - 50 * HOUR).toISOString(),
  status: "offline",
});
const NEW_LAPTOP = device({ id: "d-new", userId: "u-kid", memberName: "Kid", name: "Kid's laptop", lastSeenAt: null, status: "never_seen" });

const HOME: HouseholdResponse = {
  tenantId: "t",
  name: "Pat's household",
  role: "owner",
  members: [
    { userId: "u-owner", name: "Pat", email: "pat@example.test", role: "owner" },
    { userId: "u-gran", name: "Grandma", email: "gran@example.test", role: "member" },
    { userId: "u-kid", name: "Kid", email: "kid@example.test", role: "member" },
  ],
  invites: [],
  devices: [CHROME, PC, NEW_LAPTOP],
  enrollmentCodes: [],
};

const CODE: EnrollmentCodeItem = {
  id: "c-1",
  userId: "u-gran",
  memberName: "Grandma",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
};

function renderView(home: HouseholdResponse, currentUserId = "u-owner", remoteAccessTools: RemoteAccessToolOption[] = TOOLS) {
  return render(
    <ToastProvider>
      <HouseholdSettingsView initial={home} currentUserId={currentUserId} remoteAccessTools={remoteAccessTools} />
      <Toaster />
    </ToastProvider>,
  );
}

/** Serves GET /api/household from `home()` and records every mutation. */
function stubApi(home: () => HouseholdResponse, handlers: Record<string, () => Response> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (handlers[key]) return handlers[key]();
    if (key === "GET /api/household") return Response.json(home());
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("HouseholdSettingsView devices (owner)", () => {
  it("groups devices by member with their status", () => {
    renderView(HOME);
    const gran = screen.getByRole("group", { name: "Grandma's devices" });
    expect(within(gran).getByText("Grandma's Chrome")).toBeInTheDocument();
    expect(within(gran).getByText("Last checked in 3 hours ago")).toBeInTheDocument();
    expect(within(gran).getByText("PC app · Windows")).toBeInTheDocument();
    expect(within(gran).getByText(/^Offline since /)).toBeInTheDocument();

    const kid = screen.getByRole("group", { name: "Kid's devices" });
    expect(within(kid).getByText("Waiting for first check-in")).toBeInTheDocument();
    expect(within(kid).queryByText("Grandma's Chrome")).toBeNull();

    const pat = screen.getByRole("group", { name: "Pat's devices" });
    expect(within(pat).getByText("No devices yet.")).toBeInTheDocument();
    expect(screen.getByText(/Add a device below to get an enrollment code/)).toBeInTheDocument();
  });

  it("shows an enrollment code once and lists it as pending", async () => {
    let home = HOME;
    const fetchMock = stubApi(() => home, {
      "POST /api/household/members/u-gran/enrollment-codes": () => {
        home = { ...HOME, enrollmentCodes: [CODE] };
        return Response.json({ id: CODE.id, code: "ABCD-EFGH-JKLM", expiresAt: CODE.expiresAt, memberName: "Grandma" }, { status: 201 });
      },
    });
    renderView(HOME);

    await userEvent.click(screen.getByRole("button", { name: "Add a device for Grandma" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/household/members/u-gran/enrollment-codes", expect.objectContaining({ method: "POST" }));
    expect(await screen.findByLabelText("Enrollment code")).toHaveTextContent("ABCD-EFGH-JKLM");
    expect(screen.getByText(/Expires in 24 hours/)).toBeInTheDocument();
    expect(screen.getByText(/I have an enrollment code/)).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Pending enrollment codes for Grandma" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("ABCD-EFGH-JKLM")).toBeNull();
    // The pending code stays listed without its secret.
    expect(screen.getByRole("button", { name: "Cancel enrollment code for Grandma" })).toBeInTheDocument();
  });

  it("explains the household limits", async () => {
    stubApi(() => HOME, {
      "POST /api/household/members/u-kid/enrollment-codes": () =>
        Response.json({ error: "limit", code: "device_limit" }, { status: 409 }),
    });
    renderView(HOME);
    await userEvent.click(screen.getByRole("button", { name: "Add a device for Kid" }));
    expect(await screen.findByText(/reached its device limit/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Enrollment code")).toBeNull();
  });

  it("cancels a pending code", async () => {
    let home: HouseholdResponse = { ...HOME, enrollmentCodes: [CODE] };
    const fetchMock = stubApi(() => home, {
      "DELETE /api/household/enrollment-codes/c-1": () => {
        home = HOME;
        return new Response(null, { status: 204 });
      },
    });
    renderView(home);
    await userEvent.click(screen.getByRole("button", { name: "Cancel enrollment code for Grandma" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/household/enrollment-codes/c-1", { method: "DELETE" });
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Cancel enrollment code for Grandma" })).toBeNull());
  });

  it("renames a device inline", async () => {
    const fetchMock = stubApi(() => HOME);
    renderView(HOME);
    await userEvent.click(screen.getByRole("button", { name: "Rename Living room PC" }));
    const input = screen.getByRole("textbox", { name: "Device name" });
    await userEvent.clear(input);
    await userEvent.type(input, "  Den PC {Enter}");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/household/devices/d-pc",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Den PC" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/household", expect.anything());
  });

  it("confirms before removing a device", async () => {
    const fetchMock = stubApi(() => ({ ...HOME, devices: [PC, NEW_LAPTOP] }));
    renderView(HOME);
    await userEvent.click(screen.getByRole("button", { name: "Remove Grandma's Chrome" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Remove Grandma's Chrome?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/household/devices/d-chrome", { method: "DELETE" });
    await vi.waitFor(() => expect(screen.queryByText("Last checked in 3 hours ago")).toBeNull());
  });
});

describe("HouseholdSettingsView devices (member)", () => {
  const MEMBER_HOME: HouseholdResponse = { ...HOME, role: "member", devices: [CHROME] };

  it("lists only their devices with Remove, and says the owner will be told", async () => {
    const fetchMock = stubApi(() => ({ ...MEMBER_HOME, devices: [] }));
    renderView(MEMBER_HOME, "u-gran");
    expect(screen.getByText("Grandma's Chrome")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add a device/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();
    expect(screen.queryByText(/enrollment code/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Remove Grandma's Chrome" }));
    expect(screen.getByText(/Pat will be told\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/household/devices/d-chrome", { method: "DELETE" });
  });

  it("hides the section for a member without devices", () => {
    renderView({ ...MEMBER_HOME, devices: [] }, "u-kid");
    expect(screen.queryByText("Your devices")).toBeNull();
    expect(screen.queryByText(/coming soon/)).toBeNull();
  });
});

describe("HouseholdSettingsView expected remote-access tools (_specs/signals.md)", () => {
  it("lets the owner add a tool with a peer ID and saves the full set via PUT", async () => {
    let home = HOME;
    const fetchMock = stubApi(() => home, {
      "PUT /api/household/devices/d-pc/expected-tools": () => {
        home = {
          ...HOME,
          devices: HOME.devices.map((d) =>
            d.id === "d-pc" ? { ...d, expectedTools: [{ toolId: "anydesk", name: "AnyDesk", peerIds: ["Pat-ID"] }] } : d,
          ),
        };
        return Response.json({ tools: [{ toolId: "anydesk", name: "AnyDesk", peerIds: ["Pat-ID"] }] });
      },
    });
    renderView(HOME);

    await userEvent.click(screen.getByText("Expected remote-access tools"));
    await userEvent.selectOptions(screen.getByLabelText("Add an expected tool"), "anydesk");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.type(screen.getByLabelText("Peer ID for AnyDesk"), "Pat-ID");
    await userEvent.click(screen.getByRole("button", { name: "Add ID" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/household/devices/d-pc/expected-tools",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ tools: [{ toolId: "anydesk", peerIds: ["Pat-ID"] }] }) }),
    );
    await vi.waitFor(() => expect(screen.getByText("Expected remote-access tools (1)")).toBeInTheDocument());
  });

  it("shows an inline error for an invalid peer ID and does not save it", async () => {
    const fetchMock = stubApi(() => HOME);
    renderView(HOME);
    await userEvent.click(screen.getByText("Expected remote-access tools"));
    await userEvent.selectOptions(screen.getByLabelText("Add an expected tool"), "anydesk");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.type(screen.getByLabelText("Peer ID for AnyDesk"), "bad id!");
    await userEvent.click(screen.getByRole("button", { name: "Add ID" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/letters, numbers/);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/household/devices/d-pc/expected-tools", expect.anything());
  });

  it("shows a member the owner's expected tools, read-only", () => {
    const memberPc = device({
      id: "d-pc",
      kind: "desktop_agent",
      platform: "windows",
      name: "Living room PC",
      expectedTools: [{ toolId: "anydesk", name: "AnyDesk", peerIds: ["Pat-ID"] }],
    });
    renderView({ ...HOME, role: "member", devices: [memberPc] }, "u-gran");

    expect(screen.getByText("Expected remote-access tools (1)")).toBeInTheDocument();
    expect(screen.getByText(/Your household owner marked these as expected\./)).toBeInTheDocument();
    expect(screen.getByText("AnyDesk")).toBeInTheDocument();
    expect(screen.getByText(/Pat-ID/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByLabelText("Add an expected tool")).toBeNull();
  });
});
