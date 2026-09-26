import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Route } from "@neo/core";
import { MessageActions } from "@/components/MessageActions";

const route: Route = {
  tier: "medium",
  family: "anthropic",
  model: "anthropic/claude-sonnet-5",
  displayName: "Sonnet 5",
  effort: "medium",
  preference: "balanced",
  router: "jev",
  signals: { complexity: 1, stakes: 0, reason: "Jev: complexity 1/2, stakes 0/2" },
};

describe("MessageActions model chip", () => {
  it("is absent when the message has no route", () => {
    render(<MessageActions content="hi" />);
    expect(screen.queryByTestId("model-chip")).toBeNull();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("shows model, tier and preference with the route reason as tooltip", () => {
    render(<MessageActions content="hi" route={route} servedModel="anthropic/claude-sonnet-5" />);
    const chip = screen.getByTestId("model-chip");
    expect(chip.tagName).toBe("SPAN");
    expect(chip).toHaveTextContent("Sonnet 5 · medium · balanced");
    expect(chip).toHaveAttribute("title", "Jev: complexity 1/2, stakes 0/2");
    expect(chip).toHaveAttribute("aria-label", expect.stringContaining("Sonnet 5 · medium · balanced"));
  });

  it("falls back to the router kind when there is no reason", () => {
    render(<MessageActions content="hi" route={{ ...route, router: "rule", signals: undefined }} />);
    expect(screen.getByTestId("model-chip")).toHaveAttribute("title", "Routed by rule");
  });

  it("names the served model and notes it in the tooltip when it differs from the route", () => {
    render(<MessageActions content="hi" route={route} servedModel="anthropic/claude-opus-5" />);
    const chip = screen.getByTestId("model-chip");
    expect(chip).toHaveTextContent("Opus 5 · medium · balanced");
    expect(chip).toHaveAttribute("title", "Jev: complexity 1/2, stakes 0/2 (served by Opus 5)");
  });

  it("renders the MOCK_MODE model by its display name", () => {
    render(<MessageActions content="hi" route={{ ...route, signals: undefined }} servedModel="neo-mock-model" />);
    const chip = screen.getByTestId("model-chip");
    expect(chip).toHaveTextContent("Mock model · medium · balanced");
    expect(chip).toHaveAttribute("title", "Routed by jev (served by Mock model)");
  });
});
