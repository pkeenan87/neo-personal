/**
 * Model catalog and routing tables (Phase 2, `_specs/model-routing.md`).
 *
 * Pure data and functions: no I/O, no SDK. A chat turn is classified into a
 * tier (small / medium / large); a member's preference and model family turn
 * the tier into a concrete model and effort. Compression, triage and playbook
 * turns use fixed ("pinned") routes.
 *
 * Model ids are AI Gateway slugs (`creator/model`). Anthropic models also carry
 * the direct API id used when the gateway is off (`NEO_MODEL_GATEWAY` unset).
 * Non-Anthropic families exist only through the gateway.
 */
import { enabledFamilies, gatewayEnabled, type EnvSource } from "./config.js";
import type { Effort } from "./types.js";

export type Tier = "small" | "medium" | "large";
export type RoutingPreference = "cost" | "balanced" | "intelligence";
export type ModelFamily = "anthropic" | "openai" | "kimi" | "grok";
export type RouterKind = "jev" | "rule" | "pinned";

export const TIERS: readonly Tier[] = ["small", "medium", "large"];
export const ROUTING_PREFERENCES: readonly RoutingPreference[] = ["cost", "balanced", "intelligence"];
export const MODEL_FAMILIES: readonly ModelFamily[] = ["anthropic", "openai", "kimi", "grok"];

export interface CatalogModel {
  /** AI Gateway id, e.g. `anthropic/claude-sonnet-5`. */
  id: string;
  /** Anthropic API id when the gateway is off; undefined for non-Anthropic models. */
  directId?: string;
  displayName: string;
  family: ModelFamily;
  tier: Tier;
  /**
   * `output_config.effort` levels the model accepts (from the gateway catalog's
   * `reasoning_options`). Empty means the model takes no effort parameter.
   */
  efforts: readonly Effort[];
  /** `adaptive`: send `thinking: { type: "adaptive" }`; `none`: send no thinking block (no `budget_tokens`, ever). */
  thinking: "adaptive" | "none";
  /** Gateway provider order (`providerOptions.gateway.order`). */
  order: readonly string[];
  /** Providers exempt from the US region pin (Grok: the gateway reports no regions for them). */
  regionOverrides?: Readonly<Record<string, null>>;
  /** USD per million tokens at the global rate. */
  pricing: { input: number; output: number };
}

export interface RouteSignals {
  complexity?: number;
  stakes?: number;
  needsTools?: boolean;
  confidence?: number;
  reason?: string;
}

export interface Route {
  tier: Tier;
  /** Family of the model actually used (may differ from the requested one after a fallback). */
  family: ModelFamily;
  /** Model id in the form the current mode sends (gateway slug, or direct id when the gateway is off). */
  model: string;
  displayName: string;
  effort: Effort;
  preference: RoutingPreference;
  router: RouterKind;
  signals?: RouteSignals;
}

// ─────────────────────────────────────────────────────────────
//  Catalog
// ─────────────────────────────────────────────────────────────

const ANTHROPIC_ORDER = ["anthropic", "bedrock", "vertexAnthropic", "claudeaws"] as const;
const ALL_EFFORTS: readonly Effort[] = ["low", "medium", "high"];

const HAIKU: CatalogModel = {
  id: "anthropic/claude-haiku-4.5",
  directId: "claude-haiku-4-5",
  displayName: "Haiku 4.5",
  family: "anthropic",
  tier: "small",
  // Haiku 4.5 predates adaptive thinking and the effort parameter.
  efforts: [],
  thinking: "none",
  order: ANTHROPIC_ORDER,
  pricing: { input: 1, output: 5 },
};
const SONNET: CatalogModel = {
  id: "anthropic/claude-sonnet-5",
  directId: "claude-sonnet-5",
  displayName: "Sonnet 5",
  family: "anthropic",
  tier: "medium",
  efforts: ALL_EFFORTS,
  thinking: "adaptive",
  order: ANTHROPIC_ORDER,
  pricing: { input: 2, output: 10 },
};
const OPUS: CatalogModel = {
  id: "anthropic/claude-opus-5",
  directId: "claude-opus-5",
  displayName: "Opus 5",
  family: "anthropic",
  tier: "large",
  efforts: ALL_EFFORTS,
  thinking: "adaptive",
  order: ANTHROPIC_ORDER,
  pricing: { input: 5, output: 25 },
};

const GROK_REGION_OVERRIDES: Readonly<Record<string, null>> = { xai: null, vertex: null };

/** Catalog by family and tier. Kimi has one qualifying model; its small tier borrows Haiku. */
export const MODEL_CATALOG: Record<ModelFamily, Record<Tier, CatalogModel>> = {
  anthropic: { small: HAIKU, medium: SONNET, large: OPUS },
  openai: {
    small: { id: "openai/gpt-6-luna", displayName: "GPT-6 Luna", family: "openai", tier: "small", efforts: ALL_EFFORTS, thinking: "adaptive", order: ["openai"], pricing: { input: 0.1, output: 0.5 } },
    medium: { id: "openai/gpt-6-sol", displayName: "GPT-6 Sol", family: "openai", tier: "medium", efforts: ALL_EFFORTS, thinking: "adaptive", order: ["openai"], pricing: { input: 2, output: 10 } },
    large: { id: "openai/gpt-6-astra", displayName: "GPT-6 Astra", family: "openai", tier: "large", efforts: ALL_EFFORTS, thinking: "adaptive", order: ["openai"], pricing: { input: 10, output: 50 } },
  },
  kimi: {
    small: HAIKU,
    // Kimi K3 lists none/low/high/max: no `medium`.
    medium: { id: "moonshotai/kimi-k3", displayName: "Kimi K3", family: "kimi", tier: "medium", efforts: ["low", "high"], thinking: "adaptive", order: ["baseten", "fireworks", "bedrock"], pricing: { input: 3, output: 15 } },
    large: { id: "moonshotai/kimi-k3", displayName: "Kimi K3", family: "kimi", tier: "large", efforts: ["low", "high"], thinking: "adaptive", order: ["baseten", "fireworks", "bedrock"], pricing: { input: 3, output: 15 } },
  },
  grok: {
    small: { id: "spacexai/grok-4.1-fast-reasoning", displayName: "Grok 4.1 Fast", family: "grok", tier: "small", efforts: ALL_EFFORTS, thinking: "adaptive", order: ["xai", "vertex"], regionOverrides: GROK_REGION_OVERRIDES, pricing: { input: 0.2, output: 0.5 } },
    medium: { id: "spacexai/grok-4.7", displayName: "Grok 4.7", family: "grok", tier: "medium", efforts: ALL_EFFORTS, thinking: "adaptive", order: ["xai", "vertex"], regionOverrides: GROK_REGION_OVERRIDES, pricing: { input: 1.2, output: 3.6 } },
    large: { id: "spacexai/grok-4.6", displayName: "Grok 4.6", family: "grok", tier: "large", efforts: ALL_EFFORTS, thinking: "adaptive", order: ["xai", "vertex"], regionOverrides: GROK_REGION_OVERRIDES, pricing: { input: 2, output: 6 } },
  },
};

/** Tier → rung on the family ladder and effort, per preference. */
export const PREFERENCE_TABLE: Record<RoutingPreference, Record<Tier, { rung: Tier; effort: Effort }>> = {
  cost: {
    small: { rung: "small", effort: "low" },
    medium: { rung: "medium", effort: "low" },
    large: { rung: "medium", effort: "medium" },
  },
  balanced: {
    small: { rung: "small", effort: "low" },
    medium: { rung: "medium", effort: "medium" },
    large: { rung: "large", effort: "medium" },
  },
  intelligence: {
    small: { rung: "medium", effort: "low" },
    medium: { rung: "large", effort: "medium" },
    large: { rung: "large", effort: "high" },
  },
};

// ─────────────────────────────────────────────────────────────
//  Id mapping (direct Anthropic id ⇄ gateway slug)
// ─────────────────────────────────────────────────────────────

const DIRECT_TO_GATEWAY: Readonly<Record<string, string>> = {
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-opus-5-5": "anthropic/claude-opus-5.5",
};
const GATEWAY_TO_DIRECT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(DIRECT_TO_GATEWAY).map(([d, g]) => [g, d]),
);

/** Gateway slug for a model id given in either form. Unknown bare ids are assumed to be Anthropic. */
export function gatewayModelId(id: string): string {
  if (id.includes("/")) return id;
  return DIRECT_TO_GATEWAY[id] ?? `anthropic/${id}`;
}

/** Direct Anthropic id for a model id given in either form; undefined for non-Anthropic slugs. */
export function directModelId(id: string): string | undefined {
  if (!id.includes("/")) return id;
  if (GATEWAY_TO_DIRECT[id]) return GATEWAY_TO_DIRECT[id];
  return id.startsWith("anthropic/") ? id.slice("anthropic/".length) : undefined;
}

// ─────────────────────────────────────────────────────────────
//  Resolution
// ─────────────────────────────────────────────────────────────

const TIER_ENV: Record<Tier, readonly string[]> = {
  small: ["NEO_MODEL_SMALL", "NEO_COMPRESSION_MODEL"],
  medium: ["NEO_MODEL_MEDIUM", "NEO_TRIAGE_MODEL"],
  large: ["NEO_MODEL_LARGE", "NEO_AGENT_MODEL"],
};

/**
 * The Anthropic ladder entry for a tier, honoring `NEO_MODEL_<TIER>` (or the
 * legacy per-function variable) in either id form. Overrides keep the tier's
 * effort and thinking capabilities.
 */
export function anthropicModelFor(tier: Tier, source: EnvSource = process.env): CatalogModel {
  const base = MODEL_CATALOG.anthropic[tier];
  for (const key of TIER_ENV[tier]) {
    const raw = source[key]?.trim();
    if (!raw) continue;
    const id = gatewayModelId(raw);
    if (id === base.id) return base;
    const directId = directModelId(id);
    return { ...base, id, ...(directId ? { directId } : {}), displayName: displayNameFor(id) };
  }
  return base;
}

/** Catalog entry for a family and tier, with Anthropic env overrides applied. */
export function catalogModel(family: ModelFamily, tier: Tier, source: EnvSource = process.env): CatalogModel {
  const m = MODEL_CATALOG[family][tier];
  return m.family === "anthropic" ? anthropicModelFor(m.tier, source) : m;
}

/** Nearest listed effort level; on a tie the higher one wins. Models without an effort parameter return the input unchanged. */
export function clampEffort(model: CatalogModel, effort: Effort): Effort {
  if (model.efforts.length === 0 || model.efforts.includes(effort)) return effort;
  const rank = (e: Effort) => ALL_EFFORTS.indexOf(e);
  const want = rank(effort);
  let best = model.efforts[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const e of model.efforts) {
    const dist = Math.abs(rank(e) - want);
    if (dist < bestDist || (dist === bestDist && rank(e) > rank(best))) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    MODEL_FAMILIES.flatMap((f) => TIERS.map((t) => [MODEL_CATALOG[f][t].id, MODEL_CATALOG[f][t].displayName] as const)),
  ),
  "anthropic/claude-opus-5.5": "Opus 5.5",
  "neo-mock-model": "Mock model",
};

/** Human name for a model id in either form; falls back to the id itself. */
export function displayNameFor(modelId: string): string {
  return DISPLAY_NAMES[modelId] ?? DISPLAY_NAMES[gatewayModelId(modelId)] ?? modelId;
}

/** Model id in the form the current mode sends. Throws for a non-Anthropic model when the gateway is off. */
export function modelIdFor(model: CatalogModel, source: EnvSource = process.env): string {
  if (gatewayEnabled(source)) return model.id;
  if (!model.directId) throw new Error(`Model ${model.id} is only available through AI Gateway (set NEO_MODEL_GATEWAY=true)`);
  return model.directId;
}

export interface ResolveRouteInput {
  tier: Tier;
  preference: RoutingPreference;
  family: ModelFamily;
  router: RouterKind;
  signals?: RouteSignals;
  source?: EnvSource;
}

/**
 * Turn a tier into a concrete route. Falls back to the Anthropic family when
 * the requested family is not enabled (`NEO_MODEL_FAMILIES`) or the gateway is
 * off; `Route.family` reports the family actually used.
 */
export function resolveRoute(input: ResolveRouteInput): Route {
  const source = input.source ?? process.env;
  const family = familyAvailable(input.family, source) ? input.family : "anthropic";
  const cell = PREFERENCE_TABLE[input.preference][input.tier];
  const model = catalogModel(family, cell.rung, source);
  return {
    tier: input.tier,
    family: model.family,
    model: modelIdFor(model, source),
    displayName: model.displayName,
    effort: clampEffort(model, cell.effort),
    preference: input.preference,
    router: input.router,
    ...(input.signals ? { signals: input.signals } : {}),
  };
}

function familyAvailable(family: ModelFamily, source: EnvSource): boolean {
  if (family === "anthropic") return true;
  return gatewayEnabled(source) && enabledFamilies(source).includes(family);
}

const PINNED: Record<"compression" | "triage" | "playbook", { tier: Tier; effort: Effort }> = {
  compression: { tier: "small", effort: "low" },
  triage: { tier: "medium", effort: "low" },
  playbook: { tier: "large", effort: "high" },
};

/** Fixed Anthropic routes: compression → Haiku 4.5, triage → Sonnet 5 (low; the caller retries at medium), playbook → Opus 5 high. */
export function pinnedRoute(kind: keyof typeof PINNED, source: EnvSource = process.env): Route {
  const { tier, effort } = PINNED[kind];
  const model = anthropicModelFor(tier, source);
  return {
    tier,
    family: "anthropic",
    model: modelIdFor(model, source),
    displayName: model.displayName,
    effort: clampEffort(model, effort),
    preference: "balanced",
    router: "pinned",
    signals: { reason: kind },
  };
}

/** The catalog entry behind a route's model id (either form), if it is a catalog model. */
export function catalogEntryFor(modelId: string, source: EnvSource = process.env): CatalogModel | undefined {
  const id = gatewayModelId(modelId);
  for (const f of MODEL_FAMILIES) {
    for (const t of TIERS) {
      const m = catalogModel(f, t, source);
      if (m.id === id) return m;
    }
  }
  return undefined;
}
