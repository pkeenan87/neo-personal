import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SigninCheck } from "@neo/verdict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictDetail } from "@/components/dashboard/VerdictDetail";
import { ToastProvider } from "@/components/toast-context";
import type { VerdictDetailResponse } from "@/lib/dashboard-types";
import { renderVerdictEmail } from "@/lib/server/email/verdict-email";
import { VERDICT_FIXTURE } from "./fixtures";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

const ID = "00000000-0000-4000-8000-000000000042";
const CHECK: SigninCheck = { provider: "google", event: "new_signin", device_label: "Windows", first_seen: true, coarse_location: "Seattle, WA" };
const HOSTILE: SigninCheck = { ...CHECK, device_label: '<img src=x onerror="alert(1)">Windows', coarse_location: '<script>alert("x")</script>' };

function detail(check: SigninCheck | undefined, patch: Partial<VerdictDetailResponse> = {}): VerdictDetailResponse {
  return {
    id: ID, subjectType: "signin_alert", verdict: "suspicious", confidence: 0.6, headline: "Alert", source: "inbound",
    createdAt: "2026-09-20T12:00:00.000Z", userId: "u1", conversationId: null, artifactId: null,
    body: { ...VERDICT_FIXTURE, subject_type: "signin_alert", ...(check ? { signin_check: check } : {}) },
    conversation: null, artifact: null, inbound: null, memberName: "Max", ...patch,
  };
}
const show = (d: VerdictDetailResponse) => render(<ToastProvider><VerdictDetail detail={d} /></ToastProvider>);
const fetchMock = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  push.mockReset();
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("Was this you? prompt", () => {
  it("shows for a first-seen device, labels the location advisory and escapes hostile values", () => {
    const { container } = show(detail(HOSTILE));
    expect(screen.getByRole("heading", { name: "Was this you?" })).toBeInTheDocument();
    expect(screen.getByText(/location is advisory/)).toBeInTheDocument();
    // Parsed values are text, never markup.
    expect(container.querySelector("img[onerror], script")).toBeNull();
    expect(screen.getByText(/<img src=x onerror="alert\(1\)">Windows/)).toBeInTheDocument();
  });

  it("is hidden when the device is not first-seen, already remembered, or there is no check", () => {
    for (const d of [detail({ ...CHECK, first_seen: false }), detail(CHECK, { signinDeviceKnown: true }), detail(undefined)]) {
      const { unmount } = show(d);
      expect(screen.queryByRole("heading", { name: "Was this you?" })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("Yes posts the answer and confirms the device is remembered", async () => {
    show(detail(CHECK));
    await userEvent.click(screen.getByRole("button", { name: "Yes, that was me" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("remember this device"));
    expect(fetchMock).toHaveBeenCalledWith(`/api/verdicts/${ID}/signin-response`, expect.objectContaining({ method: "POST", body: JSON.stringify({ response: "yes" }) }));
    expect(push).not.toHaveBeenCalled();
  });

  it("No opens the account_takeover playbook", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, playbook: "account_takeover" }), { status: 200 }));
    show(detail(CHECK));
    await userEvent.click(screen.getByRole("button", { name: "No, that was not me" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/chat?playbook=account_takeover"));
  });

  it("shows an error and keeps the buttons when saving fails", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    show(detail(CHECK));
    await userEvent.click(screen.getByRole("button", { name: "Yes, that was me" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save your answer");
    expect(screen.getByRole("button", { name: "No, that was not me" })).toBeEnabled();
  });
});

describe("renderVerdictEmail sign-in question", () => {
  const verdict = (check: SigninCheck | undefined) => ({ ...VERDICT_FIXTURE, subject_type: "signin_alert" as const, ...(check ? { signin_check: check } : {}) });
  const opts = { detailUrl: "https://neo.example.test/verdicts/1", forwardedSubject: "Security alert" };

  it("escapes every parsed value, strips control and bidi characters, and bounds length", () => {
    const mail = renderVerdictEmail(verdict({ ...HOSTILE, device_label: `${HOSTILE.device_label}\u202E\u200B\u0007${"B".repeat(300)}` }), opts);
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Windows");
    expect(mail.html + mail.text).not.toMatch(/[\u202E\u200B\u0007]/);
    expect(mail.html).toContain("advisory");
    expect(mail.text).toContain("Was this you?");
    expect(mail.text.length).toBeLessThan(3000);
  });

  it("asks nothing for a known device or a verdict without a check", () => {
    expect(renderVerdictEmail(verdict({ ...CHECK, first_seen: false }), opts).html).not.toContain("Was this you?");
    expect(renderVerdictEmail(verdict(undefined), opts).html).not.toContain("Was this you?");
  });
});
