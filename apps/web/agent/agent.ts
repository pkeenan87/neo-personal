import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";
import { chooseModel } from "./lib/model-choice";

// The model is chosen per caller and per turn (agent/lib/model-choice.ts): the member's routing preference and
// family, Neo's gateway policy, and no thinking or effort for Haiku 4.5. No `budget_tokens`, ever.
export default defineAgent({ model: defineDynamic(chooseModel) });
