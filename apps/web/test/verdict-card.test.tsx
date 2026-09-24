import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageContent } from "@/components/MessageContent";
import { VerdictCard } from "@/components/VerdictCard";
import { VERDICT_FIXTURE } from "./fixtures";

describe("VerdictCard", () => {
  it("renders label, confidence, headline, indicators, actions, and IOC chips", () => {
    render(<VerdictCard verdict={VERDICT_FIXTURE} />);
    const card = screen.getByRole("article", { name: "Verdict: Suspicious" });
    expect(card).toHaveAttribute("data-verdict", "suspicious");
    expect(within(card).getByRole("heading", { name: "Suspicious" })).toBeInTheDocument();
    expect(within(card).getByText("72% confidence")).toBeInTheDocument();
    expect(within(card).getByText(VERDICT_FIXTURE.headline)).toBeInTheDocument();

    // Indicators sorted most severe first.
    const categories = within(card).getAllByText(/^(Shortened link|Generic greeting)$/).map((n) => n.textContent);
    expect(categories).toEqual(["Shortened link", "Generic greeting"]);

    expect(within(card).getByText("Do now")).toBeInTheDocument();
    expect(within(card).getByText("Don't tap the link.")).toBeInTheDocument();

    // IOC chips are defanged so they can't be clicked by accident.
    const chips = within(card).getAllByTestId("ioc-chip").map((c) => c.textContent);
    expect(chips).toEqual(["hxxps://bit[.]ly/3xYz", "bit[.]ly", "203[.]0[.]113[.]7", "+1 555 0100"]);
  });

  it("only links https deep links", () => {
    render(<VerdictCard verdict={VERDICT_FIXTURE} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://www.usps.com/");
    expect(links[0]).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("copies a plain-text report", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<VerdictCard verdict={VERDICT_FIXTURE} />);
    await user.click(screen.getByRole("button", { name: /copy report/i }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Neo verdict: Suspicious (72% confidence)"));
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("is rendered in place of a ```verdict fence inside assistant markdown", () => {
    const text = `**Be careful.**\n\n\`\`\`verdict\n${JSON.stringify(VERDICT_FIXTURE)}\n\`\`\`\n\nAnything else?`;
    render(<MessageContent text={text} />);
    expect(screen.getByRole("article", { name: "Verdict: Suspicious" })).toBeInTheDocument();
    expect(screen.getByText("Be careful.")).toBeInTheDocument();
    expect(screen.getByText("Anything else?")).toBeInTheDocument();
    expect(screen.queryByText(/"subject_type"/)).not.toBeInTheDocument();
  });

  it("shows a placeholder while a verdict block is still streaming", () => {
    render(<MessageContent text={'```verdict\n{"subject_type":'} streaming />);
    expect(screen.getByTestId("verdict-pending")).toBeInTheDocument();
  });

  it("falls back to raw output for an invalid verdict", () => {
    render(<MessageContent text={"```verdict\n{\"verdict\":\"nope\"}\n```"} />);
    expect(screen.getByTestId("verdict-invalid")).toHaveTextContent('"verdict":"nope"');
  });
});
