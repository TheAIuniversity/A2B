/**
 * Onboarding Pipeline — 7-phase lifecycle for new agents.
 *
 * Phase 0 — Definition     Human authors the agent blueprint (outside A2B)
 * Phase 1 — Registration   System registers agent at Tier 0, disabled
 * Phase 2 — Validation     6 automated tests (must all pass)
 * Phase 3 — Shadow Mode    24-48 h alongside buddy; shadow output discarded
 * Phase 4 — Canary         20% → 50% → 80% real traffic; buddy covers the rest
 * Phase 5 — Active Tier 0  Full workload, 100% human review
 * Phase 6-7 — Tier progression  Handled by TierManager after activation
 *
 * Each phase transition requires the prior phase to have completed cleanly.
 * Failures surface a clear reason so the operator can intervene.
 *
 * @module @a2b/onboarding/pipeline
 */

import type {
  AegisAgent,
  AgentRecord,
  AegisEventHandler,
  Task,
  TaskResult,
  Tier,
} from "@a2b/core";
import {
  AgentRegistry,
  TierManager,
  PolicyEngine,
  updateTrust,
} from "@a2b/core";
import { ShadowMode, type ShadowResult } from "./shadow.js";
import { AutoHarness } from "./calibration.js";
import { GamingDetector } from "./gaming-detection.js";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface OnboardingConfig {
  /** Minimum required shadow-mode tasks before evaluation (default: 10) */
  shadowMinTasks?: number;
  /** Canary traffic stages as integer percentages (default: [20, 50, 80, 100]) */
  canaryStages?: number[];
  /** Min quality score (0-10) to pass shadow mode (default: 6) */
  shadowQualityThreshold?: number;
  /** Min success rate (0-1) to pass each canary step (default: 0.85) */
  canaryMinSuccessRate?: number;
  /** Max error rate (0-1) allowed at each canary step (default: 0.08) */
  canaryMaxErrorRate?: number;
  /** Max average cost (EUR) per task during canary (default: 0.05) */
  canaryMaxAvgCost?: number;
  /** How often to run calibration: every N tasks (default: 10) */
  calibrationInterval?: number;
  /** Event handler for pipeline events */
  onEvent?: AegisEventHandler;
}

// ─── Phase 2 Validation ───────────────────────────────────────────────────────

/** The 6 tests in Phase 2. */
export type ValidationTestName =
  | "interface_compliance"
  | "valid_agent_type"
  | "scorecard_weights"
  | "budget_check"
  | "dry_run"
  | "sandbox_isolation";

/** Result of one validation test. */
export interface ValidationTestResult {
  name:       ValidationTestName;
  passed:     boolean;
  durationMs: number;
  error?:     string;
}

/** Aggregate result of Phase 2 validation. */
export interface ValidationResult {
  passed:          boolean;
  tests:           ValidationTestResult[];
  totalDurationMs: number;
  /** Null if all passed. Human-readable list of failures otherwise. */
  failureReason:   string | null;
}

// ─── Phase 4 Canary ───────────────────────────────────────────────────────────

/** Metrics for one canary step, passed to progressCanary(). */
export interface CanaryStepMetrics {
  tasksRun:    number;
  successRate: number;   // 0.0-1.0
  errorRate:   number;   // 0.0-1.0
  avgCost:     number;   // EUR per task
}

/** The current state of a canary rollout. */
export interface CanaryState {
  agentId:           string;
  startedAt:         number;
  stages:            number[];
  currentStageIndex: number;
  currentPercentage: number;
  stepsCompleted:    number;
}

// ─── OnboardingPipeline ───────────────────────────────────────────────────────

/**
 * OnboardingPipeline orchestrates the 7-phase lifecycle.
 *
 * Constructor requires the same three core sub-systems that the rest of A2B
 * already uses (AgentRegistry, TierManager, PolicyEngine) so it composes
 * cleanly into the existing framework without introducing a separate
 * internal registry.
 *
 * @example
 * ```ts
 * const registry    = new AgentRegistry(storage);
 * const tierManager = new TierManager({ onEvent });
 * const policy      = new PolicyEngine();
 *
 * const pipeline = new OnboardingPipeline(registry, tierManager, policy, {
 *   onEvent,
 * });
 *
 * // Phases 1+2
 * const record     = await pipeline.startOnboarding(newAgent, buddyAgent.id);
 * const validation = await pipeline.runValidation(newAgent, record);
 *
 * // Phase 3
 * const shadowSession = pipeline.startShadow(newAgent, buddyAgent);
 * // ... 24-48 h of live traffic routed through shadowSession.runTask() ...
 * const shadowMetrics = shadowSession.getMetrics();
 * const gateOk = await pipeline.evaluateShadow(newAgent.id, shadowSession.getResults());
 *
 * // Phase 4
 * await pipeline.startCanary(newAgent.id);
 * await pipeline.progressCanary(newAgent.id, weekMetrics);  // repeat per step
 *
 * // Phase 5
 * await pipeline.activateAgent(newAgent.id);
 * ```
 */
export class OnboardingPipeline {
  private readonly registry:       AgentRegistry;
  private readonly tierManager:    TierManager;
  private readonly policyEngine:   PolicyEngine;
  private readonly harness:        AutoHarness | null;
  private readonly gamingDetector: GamingDetector;
  private readonly config:         Required<Omit<OnboardingConfig, "onEvent">>;
  private readonly onEvent:        AegisEventHandler;

  /** Active shadow sessions, keyed by agentId. */
  private shadowSessions: Map<string, ShadowMode> = new Map();
  /** Active canary states, keyed by agentId. */
  private canaryStates:   Map<string, CanaryState> = new Map();

  constructor(
    registry:    AgentRegistry,
    tierManager: TierManager,
    policyEngine: PolicyEngine,
    config:      OnboardingConfig = {},
  ) {
    this.registry    = registry;
    this.tierManager = tierManager;
    this.policyEngine = policyEngine;

    this.config = {
      shadowMinTasks:         config.shadowMinTasks        ?? 10,
      canaryStages:           config.canaryStages          ?? [20, 50, 80, 100],
      shadowQualityThreshold: config.shadowQualityThreshold ?? 6,
      canaryMinSuccessRate:   config.canaryMinSuccessRate  ?? 0.85,
      canaryMaxErrorRate:     config.canaryMaxErrorRate    ?? 0.08,
      canaryMaxAvgCost:       config.canaryMaxAvgCost      ?? 0.05,
      calibrationInterval:    config.calibrationInterval   ?? 10,
    };

    this.onEvent       = config.onEvent ?? (() => {});
    this.gamingDetector = new GamingDetector(this.onEvent);
    // AutoHarness requires a StorageAdapter — wired in separately when needed
    // via runCalibration(). Set to null here; callers can supply one.
    this.harness = null;
  }

  // ─── Phase 1: Registration ─────────────────────────────────────────────────

  /**
   * Phase 1 — Register a new agent.
   *
   * Creates the AgentRecord at Tier 0 (disabled, awaiting validation).
   * The `buddyId` should point to a Tier ≥ 2 agent already in the registry.
   *
   * @param agent   - The new agent to onboard
   * @param buddyId - Optional: ID of the buddy agent for shadow mode
   */
  async startOnboarding(agent: AegisAgent, buddyId?: string): Promise<AgentRecord> {
    const record = await this.registry.register(agent, buddyId);

    this.onEvent({ type: "agent-registered", agentId: agent.id, timestamp: Date.now() });

    return record;
  }

  // ─── Phase 2: Validation ───────────────────────────────────────────────────

  /**
   * Phase 2 — Run the 6 automated validation tests.
   *
   * Tests run concurrently where safe. Any single failure is enough to stop
   * onboarding. All 6 must pass before shadow mode can start.
   *
   * The 6 tests:
   *   1. interface_compliance  — agent implements AegisAgent (id, name, type, execute)
   *   2. valid_agent_type      — agent.type is one of the 8 known types
   *   3. scorecard_weights     — if custom weights provided, they sum to ~1.0
   *   4. budget_check          — Tier 0 budget is ≥ minimum viable amounts
   *   5. dry_run               — agent produces output (or honest failure) for a task
   *   6. sandbox_isolation     — Tier 0 tool list does not include restricted tools
   *
   * @param agent  - The agent object to validate
   * @param record - The AgentRecord created during startOnboarding()
   */
  async runValidation(agent: AegisAgent, record: AgentRecord): Promise<ValidationResult> {
    record.onboardingPhase = "validating";
    await this.registry.save(record);

    const startAll = Date.now();

    const [t1, t2, t3, t4, t5, t6] = await Promise.all([
      this.test_interfaceCompliance(agent),
      this.test_validAgentType(agent),
      this.test_scorecardWeights(agent),
      this.test_budgetCheck(agent),
      this.test_dryRun(agent),
      this.test_sandboxIsolation(agent),
    ]);

    const tests = [t1, t2, t3, t4, t5, t6];
    const passed = tests.every(t => t.passed);
    const totalDurationMs = Date.now() - startAll;

    const failureReason = passed
      ? null
      : tests
          .filter(t => !t.passed)
          .map(t => `${t.name}: ${t.error ?? "failed"}`)
          .join("; ");

    if (passed) {
      record.onboardingPhase = "shadow";
      await this.registry.save(record);
    }

    return { passed, tests, totalDurationMs, failureReason };
  }

  // ─── Phase 3: Shadow Mode ──────────────────────────────────────────────────

  /**
   * Phase 3 — Create and start a shadow session.
   *
   * Returns a ShadowMode instance. Route all incoming tasks through
   * `session.runTask()` for the 24-48 h window. The buddy's output is the
   * operationally-used result. The shadow's output is silently compared.
   *
   * @param shadowAgent - The new agent
   * @param buddyAgent  - The trusted reference agent
   */
  startShadow(shadowAgent: AegisAgent, buddyAgent: AegisAgent): ShadowMode {
    const session = new ShadowMode(shadowAgent, buddyAgent, this.onEvent);
    this.shadowSessions.set(shadowAgent.id, session);
    return session;
  }

  /**
   * Phase 3 — Evaluate shadow session results.
   *
   * Called after the shadow window closes. Pass the array of ShadowResult
   * objects from `session.getResults()`.
   *
   * On success, advances the agent's onboarding phase to "canary".
   *
   * @param agentId - The shadow agent's ID
   * @param results - ShadowResult array from the completed session
   * @returns Evaluation outcome with metrics and gate status
   */
  async evaluateShadow(
    agentId: string,
    results: ShadowResult[],
  ): Promise<{ passed: boolean; metrics: ReturnType<ShadowMode["aggregateResults"]>; reason: string }> {
    const record = await this.registry.get(agentId);
    if (!record) throw new Error(`Agent "${agentId}" not found in registry.`);

    // Use a stats-only ShadowMode instance for aggregation
    const statsMode = new ShadowMode();
    const metrics   = statsMode.aggregateResults(results);

    const passed =
      metrics.avgQuality   >= this.config.shadowQualityThreshold &&
      metrics.costRatio    <= 2.0 &&
      metrics.toolCompliance === 1.0 &&
      metrics.errorRate    <  0.10 &&
      metrics.tasksCompleted >= this.config.shadowMinTasks;

    if (passed) {
      record.onboardingPhase = "canary";
      // Store aggregated shadow metrics on the record
      record.shadowMetrics = {
        difficultyAvoidance: this.gamingDetector.toShadowMetrics(agentId).difficultyAvoidance,
        outputDiversity:     metrics.avgQuality / 10,
        refusalRate:         1 - metrics.toolCompliance,
        attemptRate:         1 - metrics.errorRate,
        canaryScoreGap:      0,
      };
      await this.registry.save(record);
    }

    this.shadowSessions.delete(agentId);

    const reason = passed
      ? "Shadow mode passed — proceeding to canary"
      : [
          metrics.avgQuality   < this.config.shadowQualityThreshold
            ? `quality ${metrics.avgQuality.toFixed(1)}/10 < ${this.config.shadowQualityThreshold}`
            : null,
          metrics.costRatio    > 2.0
            ? `costRatio ${metrics.costRatio.toFixed(2)} > 2.0`
            : null,
          metrics.toolCompliance < 1.0
            ? `compliance ${(metrics.toolCompliance * 100).toFixed(1)}% < 100%`
            : null,
          metrics.errorRate >= 0.10
            ? `errorRate ${(metrics.errorRate * 100).toFixed(1)}% >= 10%`
            : null,
          metrics.tasksCompleted < this.config.shadowMinTasks
            ? `only ${metrics.tasksCompleted} tasks (need ${this.config.shadowMinTasks})`
            : null,
        ].filter(Boolean).join(", ");

    return { passed, metrics, reason };
  }

  // ─── Phase 4: Canary ──────────────────────────────────────────────────────

  /**
   * Phase 4 — Start canary rollout.
   *
   * The agent begins receiving the first stage percentage of real traffic.
   * The buddy continues to handle the remainder.
   *
   * @param agentId - The agent to move into canary
   * @returns Initial CanaryState (currently at the first stage percentage)
   * @throws If the agent is not in the "canary" onboarding phase
   */
  async startCanary(agentId: string): Promise<CanaryState> {
    const record = await this.registry.get(agentId);
    if (!record) throw new Error(`Agent "${agentId}" not found.`);

    if (record.onboardingPhase !== "canary") {
      throw new Error(
        `Agent "${agentId}" is in phase "${record.onboardingPhase}", expected "canary".`,
      );
    }

    const stages = [...this.config.canaryStages];
    const state: CanaryState = {
      agentId,
      startedAt:         Date.now(),
      stages,
      currentStageIndex: 0,
      currentPercentage: stages[0],
      stepsCompleted:    0,
    };

    this.canaryStates.set(agentId, state);

    record.canaryProgress = {
      startedAt:         state.startedAt,
      currentPercentage: state.currentPercentage,
      weekNumber:        1,
      metrics:           [],
    };
    await this.registry.save(record);

    this.onEvent({ type: "canary-started", agentId, targetTier: 0, timestamp: Date.now() });

    return state;
  }

  /**
   * Phase 4 — Evaluate one canary step and advance traffic if gates pass.
   *
   * Call after each traffic step has accumulated enough data (typically a week
   * of production tasks). If all steps at 100% pass, canary is complete.
   *
   * Gate per step:
   *   successRate ≥ canaryMinSuccessRate (default 85%)
   *   errorRate   ≤ canaryMaxErrorRate   (default 8%)
   *   avgCost     ≤ canaryMaxAvgCost     (default EUR 0.05)
   *
   * @param agentId - The agent in canary rollout
   * @param metrics - Aggregated metrics for the completed step
   * @returns Updated state, plus flags for `complete` (all steps done) and `passed`
   */
  async progressCanary(
    agentId: string,
    metrics: CanaryStepMetrics,
  ): Promise<{ state: CanaryState; complete: boolean; passed: boolean; reason: string }> {
    const record = await this.registry.get(agentId);
    if (!record) throw new Error(`Agent "${agentId}" not found.`);

    const state = this.canaryStates.get(agentId);
    if (!state) throw new Error(`No canary state for "${agentId}". Call startCanary() first.`);

    // Evaluate this step's gate
    const stepPassed =
      metrics.successRate >= this.config.canaryMinSuccessRate &&
      metrics.errorRate   <= this.config.canaryMaxErrorRate   &&
      metrics.avgCost     <= this.config.canaryMaxAvgCost;

    const failures: string[] = [];
    if (metrics.successRate < this.config.canaryMinSuccessRate)
      failures.push(`successRate ${(metrics.successRate * 100).toFixed(1)}% < ${this.config.canaryMinSuccessRate * 100}%`);
    if (metrics.errorRate > this.config.canaryMaxErrorRate)
      failures.push(`errorRate ${(metrics.errorRate * 100).toFixed(1)}% > ${this.config.canaryMaxErrorRate * 100}%`);
    if (metrics.avgCost > this.config.canaryMaxAvgCost)
      failures.push(`avgCost EUR ${metrics.avgCost.toFixed(3)} > EUR ${this.config.canaryMaxAvgCost}`);

    if (record.canaryProgress) {
      record.canaryProgress.metrics.push({
        week:   state.stepsCompleted + 1,
        score:  metrics.successRate,
        errors: Math.round(metrics.errorRate * metrics.tasksRun),
      });
    }

    if (!stepPassed) {
      const reason = `Canary step ${state.currentPercentage}% failed: ${failures.join(", ")}`;
      this.onEvent({ type: "canary-failed", agentId, reason, timestamp: Date.now() });
      await this.registry.save(record);
      return { state, complete: false, passed: false, reason };
    }

    state.stepsCompleted++;
    const nextIndex = state.currentStageIndex + 1;

    if (nextIndex >= state.stages.length) {
      // All canary steps passed — agent is ready for activation
      state.currentStageIndex  = state.stages.length - 1;
      state.currentPercentage  = 100;
      record.onboardingPhase   = "active";
      record.canaryProgress    = undefined;
      await this.registry.save(record);
      this.onEvent({ type: "canary-passed", agentId, newTier: 0, timestamp: Date.now() });
      return {
        state,
        complete: true,
        passed:   true,
        reason:   `All ${state.stages.length} canary stages passed — agent ready for activation`,
      };
    }

    // Advance to next stage
    state.currentStageIndex  = nextIndex;
    state.currentPercentage  = state.stages[nextIndex];

    if (record.canaryProgress) {
      record.canaryProgress.currentPercentage = state.currentPercentage;
      record.canaryProgress.weekNumber++;
    }

    await this.registry.save(record);
    return {
      state,
      complete: false,
      passed:   true,
      reason:   `Step ${state.stages[nextIndex - 1]}% passed — advancing to ${state.currentPercentage}%`,
    };
  }

  // ─── Phase 5: Activation ──────────────────────────────────────────────────

  /**
   * Phase 5 — Enable the agent at Tier 0 with 100% review.
   *
   * The agent is now live and receiving all tasks. Every output is reviewed.
   * TierManager handles promotion to Tier 1+ once criteria are met.
   *
   * @param agentId - The agent to activate
   * @returns The updated AgentRecord
   * @throws If the agent is not in the "active" onboarding phase
   */
  async activateAgent(agentId: string): Promise<AgentRecord> {
    const record = await this.registry.get(agentId);
    if (!record) throw new Error(`Agent "${agentId}" not found.`);

    if (record.onboardingPhase !== "active") {
      throw new Error(
        `Agent "${agentId}" is in phase "${record.onboardingPhase}", expected "active". ` +
        `Complete all prior phases first.`,
      );
    }

    record.enabled          = true;
    record.tier             = 0;
    record.lastTierChangeAt = Date.now();
    record.tierHistory.push({
      from:      0,
      to:        0,
      reason:    "Onboarding complete — activated at Tier 0 (100% review)",
      timestamp: Date.now(),
    });

    await this.registry.save(record);
    return record;
  }

  // ─── Task Recording ───────────────────────────────────────────────────────

  /**
   * Record a task result during any onboarding phase.
   *
   * Updates the agent's trust score, task counters, and gaming detector.
   * Also triggers calibration logging if the calibration interval is reached.
   *
   * @param agentId      - The agent that executed the task
   * @param task         - The task that was run
   * @param result       - The agent's result
   * @param qualityScore - Optional 0-10 quality score from shadow comparison
   */
  async recordOnboardingTask(
    agentId:      string,
    task:         Task,
    result:       TaskResult,
    qualityScore: number = 0,
  ): Promise<void> {
    const record = await this.registry.get(agentId);
    if (!record) return;

    const outcome = result.success      ? "success"
                  : result.honestFailure ? "honest_failure"
                  :                        "false_success";

    record.trust = updateTrust(record.trust, outcome, task.difficulty, record.totalTasks);
    record.totalTasks++;
    if (!result.success && !result.honestFailure) record.totalErrors++;
    if (result.success) record.streak++; else record.streak = 0;
    record.lastTaskAt  = Date.now();
    record.totalCost  += result.cost ?? 0;

    // Track gaming signals (hidden from agent)
    this.gamingDetector.trackTask(agentId, task, result, qualityScore);

    await this.registry.save(record);

    if (record.totalTasks % this.config.calibrationInterval === 0) {
      // Emit a loggable marker; actual calibration is triggered by the caller
      // using harness.runCalibration() with a fresh benchmark set.
      this.onEvent({
        type:      "heartbeat",
        ceoAgentId: agentId,
        timestamp: Date.now(),
      });
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  /**
   * Get a summary of an agent's current onboarding status.
   */
  async getStatus(agentId: string): Promise<{
    phase:              string;
    tier:               Tier;
    trustScore:         number;
    tasksCompleted:     number;
    canaryPercentage:   number | null;
    gamingFlags:        ReturnType<GamingDetector["isGaming"]>;
    promotionProgress:  Record<string, { met: boolean; current: string; required: string }>;
  } | null> {
    const record = await this.registry.get(agentId);
    if (!record) return null;

    const promoCheck = this.tierManager.checkPromotion(record);
    const gaming     = this.gamingDetector.isGaming(agentId);
    const canaryState = this.canaryStates.get(agentId);

    return {
      phase:            record.onboardingPhase,
      tier:             record.tier,
      trustScore:       record.trust.score,
      tasksCompleted:   record.totalTasks,
      canaryPercentage: canaryState?.currentPercentage ?? null,
      gamingFlags:      gaming,
      promotionProgress: promoCheck.progress,
    };
  }

  // ─── Convenience Accessors ────────────────────────────────────────────────

  /** Get the active ShadowMode session for an agent (if any). */
  getShadowSession(agentId: string): ShadowMode | undefined {
    return this.shadowSessions.get(agentId);
  }

  /** Get the active CanaryState for an agent (if any). */
  getCanaryState(agentId: string): CanaryState | undefined {
    return this.canaryStates.get(agentId);
  }

  /** Expose the GamingDetector so callers can track perturbation runs. */
  getGamingDetector(): GamingDetector {
    return this.gamingDetector;
  }

  // ─── Validation Tests (private) ───────────────────────────────────────────

  /**
   * Test 1: Interface Compliance
   * The agent must have id, name, type, and a callable execute() method.
   */
  private async test_interfaceCompliance(agent: AegisAgent): Promise<ValidationTestResult> {
    const name: ValidationTestName = "interface_compliance";
    const start = Date.now();

    const missing: string[] = [];
    if (!agent.id || typeof agent.id !== "string")       missing.push("id (string)");
    if (!agent.name || typeof agent.name !== "string")   missing.push("name (string)");
    if (!agent.type || typeof agent.type !== "string")   missing.push("type (string)");
    if (typeof agent.execute !== "function")             missing.push("execute() (function)");

    if (missing.length > 0) {
      return { name, passed: false, durationMs: Date.now() - start, error: `Missing: ${missing.join(", ")}` };
    }
    return { name, passed: true, durationMs: Date.now() - start };
  }

  /**
   * Test 2: Valid Agent Type
   * agent.type must be one of the 8 defined AgentType values.
   */
  private async test_validAgentType(agent: AegisAgent): Promise<ValidationTestResult> {
    const name: ValidationTestName = "valid_agent_type";
    const start = Date.now();
    const valid = ["contact", "intel", "prospector", "strategy", "content", "infra", "simulation", "custom"];

    if (!valid.includes(agent.type)) {
      return {
        name, passed: false, durationMs: Date.now() - start,
        error: `"${agent.type}" is not a valid AgentType. Allowed: ${valid.join(", ")}`,
      };
    }
    return { name, passed: true, durationMs: Date.now() - start };
  }

  /**
   * Test 3: Scorecard Weights
   * If custom weights are provided, they must sum to 1.0 ± 0.05.
   */
  private async test_scorecardWeights(agent: AegisAgent): Promise<ValidationTestResult> {
    const name: ValidationTestName = "scorecard_weights";
    const start = Date.now();

    if (!agent.scorecardWeights) {
      return { name, passed: true, durationMs: Date.now() - start };  // Uses type defaults
    }

    const sum: number = Object.values(agent.scorecardWeights)
      .reduce((s: number, v: number | undefined) => s + (v ?? 0), 0);
    if (Math.abs(sum - 1.0) > 0.05) {
      return {
        name, passed: false, durationMs: Date.now() - start,
        error: `Scorecard weights sum to ${sum.toFixed(3)}, must be 1.0 ± 0.05`,
      };
    }
    return { name, passed: true, durationMs: Date.now() - start };
  }

  /**
   * Test 4: Budget Check
   * Tier 0 budget (if declared) must be at least the minimum viable amounts:
   * perTask ≥ EUR 0.01, perDay ≥ EUR 0.10.
   */
  private async test_budgetCheck(agent: AegisAgent): Promise<ValidationTestResult> {
    const name: ValidationTestName = "budget_check";
    const start = Date.now();

    const t0Budget = agent.budgetByTier?.[0 as Tier];
    if (!t0Budget) {
      return { name, passed: true, durationMs: Date.now() - start };  // Uses tier defaults
    }

    if (t0Budget.perTask < 0.01) {
      return {
        name, passed: false, durationMs: Date.now() - start,
        error: `Tier 0 perTask budget EUR ${t0Budget.perTask} is below minimum EUR 0.01`,
      };
    }
    if (t0Budget.perDay < 0.10) {
      return {
        name, passed: false, durationMs: Date.now() - start,
        error: `Tier 0 perDay budget EUR ${t0Budget.perDay} is below minimum EUR 0.10`,
      };
    }

    return { name, passed: true, durationMs: Date.now() - start };
  }

  /**
   * Test 5: Dry Run
   * The agent must complete a medium task without throwing an unhandled exception.
   * A success or honest failure both pass; a hard crash fails.
   */
  private async test_dryRun(agent: AegisAgent): Promise<ValidationTestResult> {
    const name: ValidationTestName = "dry_run";
    const start = Date.now();

    const task: Task = {
      id:          "validation-dry-run",
      description: "Validation test: return a simple greeting",
      difficulty:  "easy",
      isCanary:    false,
      createdAt:   Date.now(),
    };

    try {
      const result = await Promise.race<TaskResult>([
        agent.execute(task),
        new Promise<TaskResult>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out after 30 s")), 30_000),
        ),
      ]);

      if (!result.success && !result.honestFailure) {
        return {
          name, passed: false, durationMs: Date.now() - start,
          error: `Dry run returned unexpected failure: ${result.error ?? "(no message)"}`,
        };
      }

      return { name, passed: true, durationMs: Date.now() - start };
    } catch (err) {
      return {
        name, passed: false, durationMs: Date.now() - start,
        error: `execute() threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Test 6: Sandbox Isolation
   * The tool list the agent declares for Tier 0 must not include restricted tools.
   * PolicyEngine will enforce this at runtime, but catching it early gives a
   * cleaner error before the agent ever processes a real task.
   */
  private async test_sandboxIsolation(agent: AegisAgent): Promise<ValidationTestResult> {
    const name: ValidationTestName = "sandbox_isolation";
    const start = Date.now();

    // Tools that are never allowed at Tier 0
    const TIER0_BLOCKED = [
      "file_write", "shell_exec", "network_fetch",
      "database_write", "send_email", "send_message",
    ];

    const tier0Tools: string[] = agent.toolsByTier?.[0 as Tier] ?? [];
    const violations = tier0Tools.filter(t => TIER0_BLOCKED.includes(t));

    if (violations.length > 0) {
      return {
        name, passed: false, durationMs: Date.now() - start,
        error: `Blueprint declares Tier 0 access to restricted tools: ${violations.join(", ")}`,
      };
    }

    // PolicyEngine check: verify these tools are not granted by the whitelist
    const testTools = [...tier0Tools, ...TIER0_BLOCKED];
    const allowed   = this.policyEngine.getAllowedTools(agent.id, agent.type, 0, testTools);
    const policyViolations = TIER0_BLOCKED.filter(t => allowed.includes(t));

    if (policyViolations.length > 0) {
      return {
        name, passed: false, durationMs: Date.now() - start,
        error: `PolicyEngine would grant Tier 0 access to: ${policyViolations.join(", ")}`,
      };
    }

    return { name, passed: true, durationMs: Date.now() - start };
  }
}
