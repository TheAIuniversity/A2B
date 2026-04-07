/**
 * Onboarding Pipeline — 7-phase process for new agents
 *
 * Phase 0: Definition (human creates blueprint)
 * Phase 1: Registration (system registers, assigns buddy)
 * Phase 2: Validation (6 automated tests)
 * Phase 3: Shadow Mode (24-48h alongside buddy, output discarded)
 * Phase 4: Canary (20% → 50% → 80% real tasks)
 * Phase 5: Active Tier 0 (full workload, 100% review)
 * Phase 6-7: Normal tier progression via TierManager
 */

import type {
  AegisAgent, AgentRecord, AegisEvent, AegisEventHandler,
  Task, TaskResult, Tier,
} from "@a2b/core";
import { AgentRegistry, TierManager, PolicyEngine, updateTrust } from "@a2b/core";
import { ShadowMode, type ShadowResult } from "./shadow.js";
import { AutoHarness } from "./calibration.js";
import { GamingDetector } from "./gaming-detection.js";

export interface OnboardingConfig {
  /** Shadow mode duration in hours (default: 48) */
  shadowDurationHours?: number;
  /** Canary stages as percentages (default: [20, 50, 80, 100]) */
  canaryStages?: number[];
  /** Min quality score to pass shadow mode (default: 6) */
  shadowQualityThreshold?: number;
  /** Min quality score to pass canary (default: 7) */
  canaryQualityThreshold?: number;
  /** Max shadow mode extensions (default: 3) */
  maxShadowExtensions?: number;
  /** Calibration interval: run benchmark every N tasks (default: 10) */
  calibrationInterval?: number;
  /** Event handler */
  onEvent?: AegisEventHandler;
}

export interface ValidationResult {
  passed: boolean;
  tests: { name: string; passed: boolean; error?: string }[];
}

export class OnboardingPipeline {
  private registry: AgentRegistry;
  private tierManager: TierManager;
  private policyEngine: PolicyEngine;
  private shadowMode: ShadowMode;
  private harness: AutoHarness;
  private gamingDetector: GamingDetector;
  private config: Required<OnboardingConfig>;
  private onEvent: AegisEventHandler;

  constructor(
    registry: AgentRegistry,
    tierManager: TierManager,
    policyEngine: PolicyEngine,
    config: OnboardingConfig = {},
  ) {
    this.registry = registry;
    this.tierManager = tierManager;
    this.policyEngine = policyEngine;
    this.config = {
      shadowDurationHours: config.shadowDurationHours ?? 48,
      canaryStages: config.canaryStages ?? [20, 50, 80, 100],
      shadowQualityThreshold: config.shadowQualityThreshold ?? 6,
      canaryQualityThreshold: config.canaryQualityThreshold ?? 7,
      maxShadowExtensions: config.maxShadowExtensions ?? 3,
      calibrationInterval: config.calibrationInterval ?? 10,
      onEvent: config.onEvent ?? (() => {}),
    };
    this.onEvent = this.config.onEvent;
    this.shadowMode = new ShadowMode();
    this.harness = new AutoHarness();
    this.gamingDetector = new GamingDetector();
  }

  /**
   * Phase 1: Register a new agent into the system.
   * Always starts at Tier 0 (onboarding).
   */
  async register(agent: AegisAgent, buddyId?: string): Promise<AgentRecord> {
    const record = await this.registry.register(agent, buddyId);

    this.onEvent({
      type: "agent-registered",
      agentId: agent.id,
      timestamp: Date.now(),
    });

    return record;
  }

  /**
   * Phase 2: Run 6 validation tests.
   * Agent must pass all 6 before proceeding.
   */
  async validate(agent: AegisAgent, record: AgentRecord): Promise<ValidationResult> {
    record.onboardingPhase = "validating";
    await this.registry.save(record);

    const tests: { name: string; passed: boolean; error?: string }[] = [];

    // Test 1: Agent has required interface methods
    tests.push({
      name: "interface_compliance",
      passed: typeof agent.execute === "function" && typeof agent.id === "string" && typeof agent.name === "string",
      error: typeof agent.execute !== "function" ? "Missing execute() method" : undefined,
    });

    // Test 2: Agent type is valid
    const validTypes = ["contact", "intel", "prospector", "strategy", "content", "infra", "simulation", "custom"];
    tests.push({
      name: "valid_agent_type",
      passed: validTypes.includes(agent.type),
      error: !validTypes.includes(agent.type) ? `Invalid type: ${agent.type}` : undefined,
    });

    // Test 3: Scorecard weights sum to ~1.0
    if (agent.scorecardWeights) {
      const sum = Object.values(agent.scorecardWeights).reduce((s, v) => s + (v ?? 0), 0);
      tests.push({
        name: "scorecard_weights",
        passed: Math.abs(sum - 1.0) < 0.05,
        error: Math.abs(sum - 1.0) >= 0.05 ? `Weights sum to ${sum.toFixed(2)}, need ~1.0` : undefined,
      });
    } else {
      tests.push({ name: "scorecard_weights", passed: true }); // Uses defaults
    }

    // Test 4: Budget is reasonable
    const budget = agent.budgetByTier;
    if (budget) {
      const t0Budget = budget[0 as Tier];
      tests.push({
        name: "budget_check",
        passed: t0Budget ? t0Budget.perTask >= 0.01 && t0Budget.perDay >= 0.10 : true,
        error: t0Budget && t0Budget.perTask < 0.01 ? "Tier 0 budget too low" : undefined,
      });
    } else {
      tests.push({ name: "budget_check", passed: true });
    }

    // Test 5: Dry run — can agent execute a simple task?
    try {
      const dryTask: Task = {
        id: "validation-dry-run",
        description: "Validation test: return a simple greeting",
        difficulty: "easy",
        createdAt: Date.now(),
      };
      const result = await Promise.race([
        agent.execute(dryTask),
        new Promise<TaskResult>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout after 30s")), 30000),
        ),
      ]);
      tests.push({
        name: "dry_run",
        passed: result.success || result.honestFailure === true,
        error: !result.success && !result.honestFailure ? result.error : undefined,
      });
    } catch (err) {
      tests.push({
        name: "dry_run",
        passed: false,
        error: `Dry run failed: ${(err as Error).message}`,
      });
    }

    // Test 6: Tier 0 tool restrictions enforced
    const allowedTools = this.policyEngine.getAllowedTools(agent.id, agent.type, 0, [
      "read_data", "search_web", "send_email", "request_development",
    ]);
    const hasRestrictedTools = allowedTools.includes("send_email");
    tests.push({
      name: "sandbox_isolation",
      passed: !hasRestrictedTools,
      error: hasRestrictedTools ? "Tier 0 should not have send_email access" : undefined,
    });

    const allPassed = tests.every(t => t.passed);

    if (allPassed) {
      record.onboardingPhase = "shadow";
      await this.registry.save(record);
    }

    return { passed: allPassed, tests };
  }

  /**
   * Phase 3: Evaluate shadow mode results.
   * Called after the shadow period ends.
   */
  async evaluateShadow(
    agentId: string,
    results: ShadowResult[],
  ): Promise<{ passed: boolean; metrics: Record<string, number>; reason: string }> {
    const record = await this.registry.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} not found`);

    const metrics = this.shadowMode.aggregateResults(results);

    const passed = metrics.avgQuality >= this.config.shadowQualityThreshold
      && metrics.costRatio <= 2.0
      && metrics.toolCompliance === 1.0
      && metrics.errorRate < 0.10
      && metrics.tasksCompleted >= 10;

    if (passed) {
      record.onboardingPhase = "canary";
      await this.registry.save(record);
      return { passed: true, metrics, reason: "Shadow mode passed — proceeding to canary" };
    }

    return {
      passed: false,
      metrics,
      reason: `Shadow mode not passed: quality=${metrics.avgQuality.toFixed(1)}, costRatio=${metrics.costRatio.toFixed(1)}, compliance=${metrics.toolCompliance}, errors=${(metrics.errorRate * 100).toFixed(0)}%`,
    };
  }

  /**
   * Phase 5: Activate agent at Tier 0 with full workload.
   */
  async activate(agentId: string): Promise<AgentRecord> {
    const record = await this.registry.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} not found`);

    record.enabled = true;
    record.onboardingPhase = "active";
    await this.registry.save(record);

    return record;
  }

  /**
   * Record a task result during onboarding.
   * Also checks if calibration should run.
   */
  async recordOnboardingTask(
    agentId: string,
    task: Task,
    result: TaskResult,
  ): Promise<void> {
    const record = await this.registry.get(agentId);
    if (!record) return;

    // Update trust score
    const outcome = result.success ? "success"
      : result.honestFailure ? "honest_failure"
      : "false_success";

    record.trust = updateTrust(record.trust, outcome, task.difficulty, record.totalTasks);
    record.totalTasks++;
    if (!result.success) record.totalErrors++;
    if (result.success) record.streak++;
    else record.streak = 0;
    record.lastTaskAt = Date.now();
    record.totalCost += result.cost ?? 0;

    // Update shadow metrics for gaming detection
    this.gamingDetector.trackTask(agentId, task, result);

    await this.registry.save(record);

    // Check if calibration should run
    if (record.totalTasks % this.config.calibrationInterval === 0) {
      console.log(`[Onboarding] Calibration due for ${record.name} (${record.totalTasks} tasks)`);
    }
  }

  /**
   * Get onboarding status for an agent.
   */
  async getStatus(agentId: string): Promise<{
    phase: string;
    tier: Tier;
    trustScore: number;
    tasksCompleted: number;
    promotionProgress: Record<string, { met: boolean; current: string; required: string }>;
  } | null> {
    const record = await this.registry.get(agentId);
    if (!record) return null;

    const promoCheck = this.tierManager.checkPromotion(record);

    return {
      phase: record.onboardingPhase,
      tier: record.tier,
      trustScore: record.trust.score,
      tasksCompleted: record.totalTasks,
      promotionProgress: promoCheck.progress,
    };
  }
}
