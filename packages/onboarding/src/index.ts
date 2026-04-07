/**
 * @a2b/onboarding — 7-phase agent onboarding pipeline with auto-calibration.
 *
 * Main components:
 *   OnboardingPipeline  — orchestrates all 7 phases
 *   AutoHarness         — 3-step gated calibration with ratchet effect
 *   ShadowMode          — 24-48 h shadow session alongside buddy agent
 *   GamingDetector      — hidden metrics that detect score-gaming
 */

// Pipeline
export { OnboardingPipeline } from "./pipeline.js";
export type {
  OnboardingConfig,
  ValidationTestName,
  ValidationTestResult,
  ValidationResult,
  CanaryStepMetrics,
  CanaryState,
} from "./pipeline.js";

// Calibration
export { AutoHarness } from "./calibration.js";
export type { BenchmarkResult, CalibrationReport } from "./calibration.js";

// Shadow Mode
export { ShadowMode } from "./shadow.js";
export type {
  ShadowResult,
  ShadowMetricsAggregate,
  ShadowGateStatus,
} from "./shadow.js";

// Gaming Detection
export { GamingDetector } from "./gaming-detection.js";
export type {
  TaskMetricSample,
  GamingState,
  GamingFlags,
} from "./gaming-detection.js";
