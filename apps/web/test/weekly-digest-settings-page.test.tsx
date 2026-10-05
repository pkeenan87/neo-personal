import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import DigestSettingsPage from "@/app/settings/digest/page";

vi.mock("@/lib/session", () => ({ requireSession: async () => ({ tenantId: "tenant", userId: "user" }) }));
vi.mock("@/lib/server/weekly-digest/services", () => ({ getDigestServices: () => ({ store: { getPreference: async () => true } }) }));
vi.mock("@/components/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
afterEach(() => vi.unstubAllGlobals());

it("loads the saved preference and saves changes with accessible success and failure feedback", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ enabled: false })).mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(await DigestSettingsPage());
  expect(screen.getByRole("heading", { name: "Weekly digest" })).toBeInTheDocument();
  const toggle = screen.getByRole("checkbox", { name: "Email me a weekly security digest" });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved."));
  expect(fetchMock).toHaveBeenCalledWith("/api/settings/digest", expect.objectContaining({ method: "POST", body: '{"enabled":false}' }));
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.click(toggle);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save"));
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

it("exposes the digest in Settings navigation", async () => {
  const { SETTINGS_LINKS } = await vi.importActual<typeof import("@/components/AppShell")>("@/components/AppShell");
  expect(SETTINGS_LINKS).toContainEqual({ href: "/settings/digest", label: "Digest" });
});
