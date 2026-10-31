import { anthropicModelFor, gatewayProviderOptions } from "@neo/core";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { defineDynamic } from "eve/models";

/** Medium rung of Neo's routing table (Sonnet 5 by default), through AI Gateway with Neo's ZDR/region/order policy. */
const medium = anthropicModelFor("medium");

// No `reasoning`, no `budget_tokens`: Haiku 4.5 takes neither thinking nor effort, and Sonnet 5 adapts on its own.
export default defineAgent({
  model: defineDynamic(() => {
    if (process.env.MOCK_MODE === "true") {
      const model = mockModel(({ toolResults, lastUserMessage }) => {
        if (toolResults.length === 0) {
          const url = /https?:\/\/\S+/.exec(lastUserMessage ?? "")?.[0] ?? "https://example.com/";
          return { toolCalls: [{ name: "analyze_url", input: { url } }] };
        }
        return "Mock Neo: I checked that link. See the tool result for the evidence.";
      });
      // The mock isn't in the AI Gateway catalog, so eve needs its context window spelled out.
      return { model, modelContextWindowTokens: 200_000 };
    }
    // Dynamic agents return per-model options from the function, not as sibling fields.
    return {
      model: medium.id,
      modelContextWindowTokens: 200_000,
      modelOptions: { providerOptions: gatewayProviderOptions(medium) as never },
    };
  }),
});
