import { anthropicModelFor, gatewayProviderOptions } from "@neo/core";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { defineDynamic } from "eve/models";
import { INCIDENT_CONTEXT_PREFIX } from "./lib/incident-pointer";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Medium rung of Neo's routing table (Sonnet 5 by default), through AI Gateway with Neo's ZDR/region/order policy. */
const medium = anthropicModelFor("medium");

// No `reasoning`, no `budget_tokens`: Haiku 4.5 takes neither thinking nor effort, and Sonnet 5 adapts on its own.
export default defineAgent({
  model: defineDynamic(() => {
    if (process.env.MOCK_MODE === "true") {
      const model = mockModel(({ messages, toolResults, lastUserMessage }) => {
        if (toolResults.length === 0) {
          // An incident chat starts with the server-checked pointer from agent/lib/incident-context.ts.
          const pointer = messages.map((m) => new RegExp(`${INCIDENT_CONTEXT_PREFIX}(${UUID})`, "i").exec(m.text)?.[1]).find(Boolean);
          if (pointer) return { toolCalls: [{ name: "get_incident", input: { incidentId: pointer } }] };
          const url = /https?:\/\/\S+/.exec(lastUserMessage ?? "")?.[0] ?? "https://example.com/";
          return { toolCalls: [{ name: "analyze_url", input: { url } }] };
        }
        return toolResults[0]?.name === "get_incident"
          ? "Mock Neo: I looked at that alert. See the tool result for what happened."
          : "Mock Neo: I checked that link. See the tool result for the evidence.";
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
