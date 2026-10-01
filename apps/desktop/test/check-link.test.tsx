import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CheckLinkView } from "../src/views/CheckLinkView";
import { fakeClient } from "./helpers";

async function check(client = fakeClient(), link = "https://example.com/login") {
  const user = userEvent.setup();
  render(<CheckLinkView client={client} />);
  await user.type(screen.getByLabelText("Paste a link to check"), link);
  await user.click(screen.getByRole("button", { name: "Check" }));
  return client;
}

describe("CheckLinkView", () => {
  it("disables Check until something is pasted", () => {
    render(<CheckLinkView client={fakeClient()} />);
    expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();
  });

  it("shows the extension's ratings, with the domain defanged", async () => {
    const client = fakeClient({
      checkUrl: vi.fn(async () => ({ ok: true as const, rating: "dangerous" as const, domain: "evil.example.com", reasons: ["Known phishing page"], checkedAt: "" })),
    });
    await check(client);
    expect(client.checkUrl).toHaveBeenCalledWith("https://example.com/login");
    expect(await screen.findByText("Dangerous")).toBeInTheDocument();
    expect(screen.getByText("evil[.]example[.]com")).toBeInTheDocument();
    expect(screen.getByText("Known phishing page")).toBeInTheDocument();
  });

  it("does not promise safety for 'no known problems'", async () => {
    await check();
    expect(await screen.findByText("No known problems")).toBeInTheDocument();
    expect(screen.getByText("That doesn't guarantee it's safe.")).toBeInTheDocument();
  });

  it("explains a bad address and an unreachable service", async () => {
    await check(fakeClient({ checkUrl: vi.fn(async () => ({ ok: false as const, code: "invalid_request", error: "x" })) }), "not a link");
    expect(await screen.findByText("Paste a full web address that starts with http:// or https://.")).toBeInTheDocument();
  });

  it("says when it could not reach Neo", async () => {
    await check(fakeClient({ checkUrl: vi.fn(async () => ({ ok: false as const, code: "server_unreachable", error: "x" })) }));
    expect(await screen.findByText("Couldn't reach Neo. Check your connection and try again.")).toBeInTheDocument();
  });
});
