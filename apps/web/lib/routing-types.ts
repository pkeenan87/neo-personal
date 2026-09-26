/** Wire types for GET|POST /api/settings/routing (shared by the route and the settings page). */
import type { Effort, ModelFamily, RoutingPreference, Tier } from "@neo/core";

export interface RoutingLadderRung {
  tier: Tier;
  /** Model id as sent in the current mode (gateway slug, or the direct Anthropic id when the gateway is off). */
  model: string;
  displayName: string;
  /** USD per million tokens. */
  pricing: { input: number; output: number };
}

export interface RoutingFamilyOption {
  id: ModelFamily;
  label: string;
  /** Members may choose it (`NEO_MODEL_FAMILIES`). */
  enabled: boolean;
  caveat?: string;
  ladder: RoutingLadderRung[];
}

export interface RoutingSettings {
  preference: RoutingPreference;
  family: ModelFamily;
  families: RoutingFamilyOption[];
}

/** POST /api/settings/routing body. */
export interface RoutingSettingsUpdate {
  preference?: RoutingPreference;
  family?: ModelFamily;
}

/** The model a routed tier lands on for one family and preference (derived from the preference table). */
export interface PreferenceModel {
  tier: Tier;
  displayName: string;
  effort: Effort;
}

/** family → preference → one entry per routed tier (small, medium, large). */
export type PreferenceModels = Record<ModelFamily, Record<RoutingPreference, PreferenceModel[]>>;
