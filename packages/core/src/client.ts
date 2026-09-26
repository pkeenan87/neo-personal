/**
 * Model client and per-request gateway policy (Phase 2, `_specs/model-routing.md`).
 *
 * With `NEO_MODEL_GATEWAY` on (and `AI_GATEWAY_API_KEY` set) every call goes
 * through Vercel AI Gateway using the stock Anthropic SDK with a changed base
 * URL, and every request body carries `providerOptions.gateway` (zero data
 * retention, US inference region, provider order). With it off, Neo talks to
 * Anthropic directly exactly as in Phase 1.
 *
 * `providerOptions` is not declared by the SDK types; the SDK sends the params
 * object as the JSON body unchanged (only `user_profile_id` / `workspace_id`
 * are lifted into headers), so the extra top-level key reaches the gateway.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AI_GATEWAY_BASE_URL, gatewayEnabled, gatewayRegion, type EnvSource } from "./config.js";
import {
  MODEL_CATALOG,
  catalogEntryFor,
  clampEffort,
  directModelId,
  displayNameFor,
  gatewayModelId,
  type CatalogModel,
} from "./routing.js";
import type { Effort } from "./types.js";

// ─────────────────────────────────────────────────────────────
//  Client
// ─────────────────────────────────────────────────────────────

const clients = new Map<"gateway" | "direct", Anthropic>();

/**
 * The process-wide model client. Gateway mode: base URL
 * `https://ai-gateway.vercel.sh` with `AI_GATEWAY_API_KEY` (and never an
 * Anthropic credential from env). Direct mode: `new Anthropic()`, which reads
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`. One client per mode.
 */
export function createModelClient(source: EnvSource = process.env): Anthropic {
  const mode = gatewayEnabled(source) ? "gateway" : "direct";
  let client = clients.get(mode);
  if (!client) {
    client =
      mode === "gateway"
        ? new Anthropic({
            baseURL: AI_GATEWAY_BASE_URL,
            apiKey: source.AI_GATEWAY_API_KEY?.trim() ?? null,
            // Do not forward an ANTHROPIC_AUTH_TOKEN from env to the gateway.
            authToken: null,
          })
        : new Anthropic();
    clients.set(mode, client);
  }
  return client;
}

/** Drop the cached clients (tests that switch modes or keys). */
export function resetModelClientForTests(): void {
  clients.clear();
}

// ─────────────────────────────────────────────────────────────
//  Gateway provider options
// ─────────────────────────────────────────────────────────────

export interface GatewayInferenceRegion {
  scope: "zone";
  geoRegion: "us";
  /** Providers exempt from the pin (`null`), e.g. Grok's `xai` / `vertex`. */
  providers?: Readonly<Record<string, null>>;
}

export interface GatewayProviderOptions {
  gateway: {
    zeroDataRetention: true;
    inferenceRegion?: GatewayInferenceRegion;
    order?: readonly string[];
  };
}

/** `providerOptions` for one request: ZDR always, US pin unless `NEO_GATEWAY_REGION=global`, the family's provider order. */
export function gatewayProviderOptions(model: CatalogModel, source: EnvSource = process.env): GatewayProviderOptions {
  const inferenceRegion: GatewayInferenceRegion | undefined =
    gatewayRegion(source) === "us"
      ? { scope: "zone", geoRegion: "us", ...(model.regionOverrides ? { providers: model.regionOverrides } : {}) }
      : undefined;
  return {
    gateway: {
      zeroDataRetention: true,
      ...(inferenceRegion ? { inferenceRegion } : {}),
      ...(model.order.length > 0 ? { order: model.order } : {}),
    },
  };
}

/**
 * Add `providerOptions.gateway` to request params when the gateway is on;
 * returns `params` unchanged when it is off. The return type stays `T` so the
 * result is accepted by the SDK's `messages.create` / `messages.stream`.
 */
export function withGatewayOptions<T extends object>(params: T, model: CatalogModel, source: EnvSource = process.env): T {
  if (!gatewayEnabled(source)) return params;
  return { ...params, providerOptions: gatewayProviderOptions(model, source) } as T & {
    providerOptions: GatewayProviderOptions;
  };
}

// ─────────────────────────────────────────────────────────────
//  Request shape per model
// ─────────────────────────────────────────────────────────────

export interface RequestShape {
  thinking?: { type: "adaptive"; display?: "summarized" };
  output_config?: { effort: Effort };
}

/**
 * `thinking` and `output_config.effort` fragments for a model. Adaptive
 * thinking only for `thinking: "adaptive"` models (with `display: "summarized"`
 * when the caller streams thinking text); effort only for models that list
 * effort levels, clamped to them. Never `budget_tokens`. Haiku 4.5 gets neither.
 */
export function requestShape(
  model: CatalogModel,
  effort: Effort,
  opts: { summarizedThinking?: boolean } = {},
): RequestShape {
  return {
    ...(model.thinking === "adaptive"
      ? { thinking: { type: "adaptive" as const, ...(opts.summarizedThinking ? { display: "summarized" as const } : {}) } }
      : {}),
    ...(model.efforts.length > 0 ? { output_config: { effort: clampEffort(model, effort) } } : {}),
  };
}

const ANTHROPIC_ORDER = MODEL_CATALOG.anthropic.large.order;

/**
 * The catalog entry for a model id (either form), or a stand-in for ids
 * outside the catalog that keeps Phase 1 behaviour: adaptive thinking, every
 * effort level, and the Anthropic provider order for `anthropic/*` ids.
 */
export function modelEntryFor(modelId: string, source: EnvSource = process.env): CatalogModel {
  const known = catalogEntryFor(modelId, source);
  if (known) return known;
  const id = gatewayModelId(modelId);
  const directId = directModelId(id);
  const isAnthropic = id.startsWith("anthropic/");
  const base = MODEL_CATALOG.anthropic.large;
  const { directId: _drop, regionOverrides: _none, ...rest } = base;
  return {
    ...rest,
    id,
    ...(isAnthropic && directId ? { directId } : {}),
    displayName: displayNameFor(id),
    order: isAnthropic ? ANTHROPIC_ORDER : [],
  };
}
