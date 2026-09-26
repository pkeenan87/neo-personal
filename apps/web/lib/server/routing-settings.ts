/**
 * Member model-routing settings (_specs/model-routing.md): data for
 * /settings/routing and GET|POST /api/settings/routing, plus the preference
 * lookup the agent run uses. Postgres via `tenantScoped().memberships` when
 * DATABASE_URL is set; otherwise an in-memory fallback (MOCK_MODE / tests).
 */
import {
  MODEL_FAMILIES,
  PREFERENCE_TABLE,
  ROUTING_PREFERENCES,
  TIERS,
  catalogModel,
  clampEffort,
  enabledFamilies,
  gatewayEnabled,
  type ModelFamily,
  type RoutingPreference,
} from "@neo/core";
import { DEFAULT_MEMBER_PREFERENCES, tenantScoped, type MemberPreferences } from "@neo/db";
import type { PreferenceModels, RoutingFamilyOption, RoutingSettings } from "@/lib/routing-types";
import { getDb } from "./db";

export type { MemberPreferences };

export const FAMILY_LABELS: Record<ModelFamily, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  kimi: "Kimi",
  grok: "Grok",
};

export const FAMILY_CAVEATS: Partial<Record<ModelFamily, string>> = {
  grok: "US hosting is not verifiable by the gateway",
};

// ─── Preferences store ─────────────────────────────────────────────

const g = globalThis as typeof globalThis & { __neoMemoryRoutingPrefs?: Map<string, MemberPreferences> };

function memoryPrefs(): Map<string, MemberPreferences> {
  g.__neoMemoryRoutingPrefs ??= new Map();
  return g.__neoMemoryRoutingPrefs;
}

/** Test helper: clear the no-database preferences fallback. */
export function resetMemoryRoutingPreferences(): void {
  g.__neoMemoryRoutingPrefs = new Map();
}

/** The member's routing preference and model family (defaults when unset). */
export async function getMemberPreferences(tenantId: string, userId: string): Promise<MemberPreferences> {
  const db = getDb();
  if (db) return tenantScoped(db, tenantId).memberships.getPreferences(userId);
  return { ...DEFAULT_MEMBER_PREFERENCES, ...memoryPrefs().get(`${tenantId}:${userId}`) };
}

/** Update the member's own preferences; values must already be validated. */
export async function setMemberPreferences(
  tenantId: string,
  userId: string,
  patch: Partial<MemberPreferences>,
): Promise<MemberPreferences> {
  const db = getDb();
  if (db) return tenantScoped(db, tenantId).memberships.setPreferences(userId, patch);
  const next = { ...(await getMemberPreferences(tenantId, userId)), ...patch };
  memoryPrefs().set(`${tenantId}:${userId}`, next);
  return next;
}

// ─── Validation ────────────────────────────────────────────────────

export function isRoutingPreference(v: unknown): v is RoutingPreference {
  return typeof v === "string" && (ROUTING_PREFERENCES as readonly string[]).includes(v);
}

/** A known family that members may choose on this deployment (`NEO_MODEL_FAMILIES`). */
export function isSelectableFamily(v: unknown): v is ModelFamily {
  return typeof v === "string" && (MODEL_FAMILIES as readonly string[]).includes(v) && enabledFamilies().includes(v as ModelFamily);
}

// ─── Wire shapes ───────────────────────────────────────────────────

/** Every family with its ladder, enabled flag and caveat. */
export function routingFamilies(): RoutingFamilyOption[] {
  const enabled = enabledFamilies();
  const gateway = gatewayEnabled();
  return MODEL_FAMILIES.map((id) => {
    const caveat = FAMILY_CAVEATS[id];
    return {
      id,
      label: FAMILY_LABELS[id],
      enabled: enabled.includes(id),
      ...(caveat ? { caveat } : {}),
      ladder: TIERS.map((tier) => {
        const m = catalogModel(id, tier);
        return {
          tier,
          model: gateway ? m.id : (m.directId ?? m.id),
          displayName: m.displayName,
          pricing: { input: m.pricing.input, output: m.pricing.output },
        };
      }),
    };
  });
}

/** For each family and preference, the model and effort each routed tier lands on. */
export function preferenceModels(): PreferenceModels {
  const out = {} as PreferenceModels;
  for (const family of MODEL_FAMILIES) {
    out[family] = {} as PreferenceModels[ModelFamily];
    for (const preference of ROUTING_PREFERENCES) {
      out[family][preference] = TIERS.map((tier) => {
        const cell = PREFERENCE_TABLE[preference][tier];
        const m = catalogModel(family, cell.rung);
        return { tier, displayName: m.displayName, effort: clampEffort(m, cell.effort) };
      });
    }
  }
  return out;
}

export async function loadRoutingSettings(session: { tenantId: string; userId: string }): Promise<RoutingSettings> {
  const prefs = await getMemberPreferences(session.tenantId, session.userId);
  return { preference: prefs.routingPreference, family: prefs.modelFamily, families: routingFamilies() };
}
