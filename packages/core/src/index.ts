/**
 * @a2b/core — Agent-to-Business Core Framework
 *
 * Trust scoring, tier management, policy enforcement, and agent registry.
 */

// Types
export type {
  AegisAgent,
  AgentType,
  Tier,
  TierConfig,
  Task,
  TaskResult,
  TrustScore,
  ScorecardWeights,
  PromotionCriteria,
  PromotionConfig,
  DemotionTrigger,
  BudgetLimit,
  AgentRecord,
  TierChange,
  OnboardingPhase,
  CanaryProgress,
  ShadowMetrics,
  AuditEntry,
  AgentStatus,
  AegisEvent,
  AegisEventHandler,
  AegisConfig,
  StorageAdapter,
} from "./types.js";

// Constants
export {
  DEFAULT_TIER_CONFIGS,
  DEFAULT_SCORECARD_WEIGHTS,
  DEFAULT_PROMOTION_CRITERIA,
  DEFAULT_DEMOTION_TRIGGERS,
} from "./types.js";

// Trust Score Engine
export {
  createTrustScore,
  updateTrust,
  decayTrust,
  adjustedScore,
  detectCollusion,
  OUTCOME_SCORES,
} from "./trust-score.js";

// Tier Manager
export { TierManager } from "./tier-manager.js";
export type { TierManagerConfig } from "./tier-manager.js";

// Policy Engine
export { PolicyEngine } from "./policy-engine.js";
export type { PolicyDecision, PolicyEngineConfig } from "./policy-engine.js";

// Registry
export { AgentRegistry } from "./registry.js";

// Storage Adapters
export { MemoryStorage } from "./storage/memory.js";
export { FileStorage } from "./storage/file.js";
