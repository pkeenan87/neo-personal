import type { RegisteredTool, ToolDefinition, ToolRegistry } from "./types.js";

// Anthropic tool-name constraint.
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Build the registry the agent loop dispatches against. The agent never
 * imports concrete tools: whatever is registered is allowed, and tools with
 * `destructive: true` go through the confirmation gate.
 *
 * `list()` is sorted by name so the rendered `tools` array — which sits at
 * the very front of the prompt-cache prefix — is byte-stable regardless of
 * registration order.
 */
export function createToolRegistry(tools: RegisteredTool[]): ToolRegistry {
  const byName = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    const { name } = tool.definition;
    if (!TOOL_NAME_RE.test(name)) {
      throw new Error(`Invalid tool name "${name}": must match ${TOOL_NAME_RE.source}`);
    }
    if (byName.has(name)) {
      throw new Error(`Duplicate tool name "${name}"`);
    }
    if (typeof tool.execute !== "function") {
      throw new Error(`Tool "${name}" has no execute function`);
    }
    const schemaType = (tool.definition.input_schema as { type?: unknown }).type;
    if (schemaType !== "object") {
      throw new Error(`Tool "${name}" input_schema must have type "object"`);
    }
    byName.set(name, tool);
  }
  const sorted: ToolDefinition[] = [...byName.values()]
    .map((t) => t.definition)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    list: () => [...sorted],
    get: (name: string) => byName.get(name),
  };
}
