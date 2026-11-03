export { AGE_BANDS, DEFAULT_AGE_BAND, MODE_DEFAULTS, ageBand, ageBandInfo, childDefaults, effectivePolicy, type AgeBand, type AgeBandInfo, type PolicyLayers } from "./defaults.js";
export { canonicalJson, compileBundle, computePolicyVersion, type CompileBundleInput } from "./bundle.js";
export { alertKindForDetector, evaluateSignal } from "./engine.js";
export { CORRELATION_WINDOW_MS, SEVERITY_RANK, bumpSeverity, findScamInProgress, thirtyMinuteBucket, type ScamInProgress } from "./severity.js";
export type {
  Correlation,
  CorrelationKind,
  CorrelationMember,
  Decision,
  DecisionAction,
  EngineAlertKind,
  EngineCatalog,
  Enrichment,
  EvaluationContext,
  EvaluationInput,
  ExpectedToolRef,
  RecentSignal,
  StoredOutcome,
  VerdictLabel as DecisionVerdictLabel,
} from "./types.js";
