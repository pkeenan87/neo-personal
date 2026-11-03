/**
 * One non-streaming model call through the Vercel AI SDK (`ai`), routed the
 * same way as the rest of Neo: a gateway slug string when `NEO_MODEL_GATEWAY`
 * is on, and `@ai-sdk/anthropic` with the direct id when it is off.
 *
 * Thinking and effort are Anthropic provider options, and only when the caller
 * sets them. Haiku 4.5 callers omit both. Never `budget_tokens`, never a
 * top-level `reasoning` value (that mapping can attach a token budget).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, jsonSchema, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import type { GatewayProviderOptions } from "./client.js";
import { gatewayEnabled, type EnvSource } from "./config.js";
import { directModelId, gatewayModelId } from "./routing.js";
import type { Effort } from "./types.js";

export interface ModelTextUsage {
  /** Uncached input tokens (Anthropic `usage.input_tokens`). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Unified finish reasons triage and compression branch on. */
export type ModelFinishReason = "stop" | "length" | "content-filter" | "other";

export interface ModelTextCall {
  /** Model id in the form the current mode sends (gateway slug, or direct id when the gateway is off). */
  model: string;
  system: string;
  /** Ephemeral prompt-cache breakpoint on the system text. */
  cacheSystem?: boolean;
  prompt: string;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
  /** Present only when the gateway is on. `providerOptions.gateway`. */
  gateway?: GatewayProviderOptions["gateway"];
  /**
   * Anthropic provider options. Omit the whole object for models that take
   * neither thinking nor effort (Haiku 4.5), unless a hashed `userId` is set.
   * `thinking` is adaptive only — no `budgetTokens`.
   */
  anthropic?: {
    thinking?: { type: "adaptive" };
    effort?: Effort;
    /** Opaque end-user id. Already hashed; never raw PII. Sent as Anthropic `metadata.user_id`. */
    userId?: string;
  };
  /**
   * Loose JSON schema for `Output.object`. Absent for plain text.
   * Callers still validate the parsed value with their own stricter schema.
   */
  jsonSchema?: Record<string, unknown>;
}

export interface ModelTextResponse {
  text: string;
  /** Parsed structured output when `jsonSchema` was set and parsing succeeded. */
  output?: unknown;
  finishReason: ModelFinishReason;
  usage: ModelTextUsage;
  /** Model id the provider reported for this response. */
  modelId: string;
  /** The model text was not valid JSON, or it failed the loose output schema. */
  invalidObject?: boolean;
}

export type ModelTextClient = (call: ModelTextCall) => Promise<ModelTextResponse>;

interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/** The `generateText` argument for one call. Exported for tests; no network. */
export function buildModelTextArgs(call: ModelTextCall, source: EnvSource = process.env) {
  const anthropic: Record<string, unknown> = {};
  if (call.anthropic?.thinking) anthropic.thinking = call.anthropic.thinking;
  if (call.anthropic?.effort) anthropic.effort = call.anthropic.effort;
  if (call.anthropic?.userId) anthropic.metadata = { userId: call.anthropic.userId };
  if (call.jsonSchema) anthropic.structuredOutputMode = "outputFormat";

  const providerOptions: Record<string, Record<string, unknown>> = {};
  if (call.gateway) providerOptions.gateway = { ...call.gateway };
  if (Object.keys(anthropic).length > 0) providerOptions.anthropic = anthropic;

  return {
    model: languageModel(call.model, source),
    system: call.cacheSystem
      ? {
          role: "system" as const,
          content: call.system,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
        }
      : call.system,
    prompt: call.prompt,
    maxOutputTokens: call.maxOutputTokens,
    ...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions: providerOptions as never } : {}),
    ...(call.jsonSchema
      ? { output: Output.object({ schema: jsonSchema(call.jsonSchema as never) }) }
      : {}),
  };
}

/** Default `ModelTextClient`: `generateText` through AI Gateway, or direct Anthropic when the gateway is off. */
export async function generateModelText(call: ModelTextCall, source: EnvSource = process.env): Promise<ModelTextResponse> {
  const args = buildModelTextArgs(call, source);
  try {
    const result = await generateText(args);
    const finishReason = normalizeFinish(result.finishReason);
    return {
      text: result.text,
      ...(call.jsonSchema && finishReason === "stop" ? { output: result.output } : {}),
      finishReason,
      usage: usageOf(result.usage),
      modelId: result.response.modelId,
    };
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      return {
        text: err.text ?? "",
        finishReason: normalizeFinish(err.finishReason),
        usage: usageOf(err.usage),
        modelId: err.response?.modelId ?? call.model,
        invalidObject: true,
      };
    }
    throw err;
  }
}

function languageModel(modelId: string, source: EnvSource): LanguageModel {
  if (gatewayEnabled(source)) return modelId.includes("/") ? modelId : gatewayModelId(modelId);
  return createAnthropic()(directModelId(modelId) ?? modelId);
}

function normalizeFinish(reason: string | undefined): ModelFinishReason {
  if (reason === "stop" || reason === "length" || reason === "content-filter") return reason;
  return "other";
}

function usageOf(usage: UsageLike | undefined): ModelTextUsage {
  const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
  const noCache = usage?.inputTokenDetails?.noCacheTokens;
  const totalIn = usage?.inputTokens ?? 0;
  return {
    inputTokens: noCache ?? Math.max(0, totalIn - cacheRead - cacheWrite),
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}
