// TEMPORARY mirror of @neo/core types; integration replaces this with import type from "@neo/core"

export interface ToolDefinition { name: string; description: string; input_schema: Record<string, unknown>; destructive?: boolean; strict?: boolean }
export type ToolContext = { tenantId: string; userId: string; conversationId: string; signal?: AbortSignal };
export type ToolExecutor = (input: unknown, ctx: ToolContext) => Promise<unknown>;
