import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutingSettingsView } from "@/components/RoutingSettings";
import { ToastProvider } from "@/components/toast-context";
import type { RoutingSettings } from "@/lib/routing-types";
import { preferenceModels, routingFamilies } from "@/lib/server/routing-settings";

function settings(patch: Partial<RoutingSettings> = {}): RoutingSettings {
  return { preference: "balanced", family: "anthropic", families: routingFamilies(), ...patch };
}

function renderView(s: RoutingSettings = settings()) {
  return render(
    <ToastProvider>
      <RoutingSettingsView initial={s} models={preferenceModels()} />
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("RoutingSettingsView", () => {
  it("renders family cards, coming-soon states, the Grok caveat and each preference's models", () => {
    renderView();
    expect(screen.getByRole("radio", { name: /Anthropic/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /OpenAI/ })).toBeDisabled();
    expect(screen.getByTestId("family-openai")).toHaveTextContent("Coming soon");
    expect(screen.getByTestId("family-anthropic")).not.toHaveTextContent("Coming soon");
    expect(screen.getByTestId("family-grok")).toHaveTextContent("US hosting is not verifiable by the gateway");

    expect(screen.getByRole("radio", { name: /Balanced/ })).toBeChecked();
    const cost = within(screen.getByTestId("preference-cost"));
    expect(cost.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "SimpleHaiku 4.5 · low effort",
      "TypicalSonnet 5 · low effort",
      "HardSonnet 5 · medium effort",
    ]);
    expect(screen.getByTestId("preference-intelligence")).toHaveTextContent("Opus 5 · high effort");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves only the changed field and shows success", async () => {
    const fetchMock = vi.fn(async () => Response.json(settings({ preference: "cost" })));
    vi.stubGlobal("fetch", fetchMock);
    renderView();
    await userEvent.click(screen.getByRole("radio", { name: /Cost/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/routing",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ preference: "cost" }) }),
    );
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved."));
    expect(screen.getByRole("radio", { name: /Cost/ })).toBeChecked();
  });

  it("shows an error when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "x", code: "bad_request" }, { status: 400 })));
    renderView();
    await userEvent.click(screen.getByRole("radio", { name: /Intelligence/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Could not save/));
  });

  it("lists the selected family's models when another family is enabled", async () => {
    vi.stubEnv("NEO_MODEL_FAMILIES", "openai");
    renderView();
    await userEvent.click(screen.getByRole("radio", { name: /OpenAI/ }));
    expect(screen.getByTestId("preference-cost")).toHaveTextContent("GPT-6 Luna");
  });
});
