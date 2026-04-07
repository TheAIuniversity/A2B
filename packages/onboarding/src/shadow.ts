/**
 * Shadow Mode — Phase 3 of the onboarding pipeline.
 *
 * The new agent runs alongside a trusted "buddy" agent for 24-48 hours.
 * Both receive the exact same task. The new agent's output is DISCARDED —
 * only the buddy's output is used operationally. The outputs are silently
 * compared to measure quality, cost, and tool compliance.
 *
 * Four gates (all must pass to advance to canary):
 *   quality    ≥ 6.0 / 10   weighted average quality score
 *   costRatio  ≤ 2.0         new agent costs ≤ 2× buddy
 *   compliance = 100%        zero tool-policy violations
 *   errorRate  < 10%         task error rate
 *
 * @module @a2b/onboarding/shadow
 */

import type { AegisAgent, Task, TaskResult, AegisEventHandler } from "@a2b/core";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The result of comparing shadow and buddy outputs for one task. */
export interface ShadowResult {
  taskId:          string;
  timestamp:       number;
  shadowResult:    TaskResult;
  buddyResult:     TaskResult;
  /** Quality score 0-10 assigned to the shadow agent's output. */
  qualityScore:    number;
  /**
   * Shadow cost / buddy cost.
   * Falls back to 1.0 when the buddy has zero cost (avoids division by zero).
   */
  costRatio:       number;
  /** True if the shadow agent violated a tool-use policy during this task. */
  policyViolation: boolean;
  /** True if the shadow agent errored (not a success and not an honest failure). */
  isError:         boolean;
}

/** Aggregated metrics across all comparisons in a shadow session. */
export interface ShadowMetricsAggregate {
  agentId:             string;
  buddyId:             string;
  startedAt:           number;
  elapsedHours:        number;
  tasksCompleted:      number;
  avgQuality:          number;   // 0-10
  costRatio:           number;
  toolCompliance:      number;   // 1.0 = 100% compliant
  errorRate:           number;   // 0.0-1.0
}

/** Gate evaluation result. */
export interface ShadowGateStatus {
  passed:        boolean;
  qualityOk:     boolean;
  costOk:        boolean;
  complianceOk:  boolean;
  errorRateOk:   boolean;
  reason:        string;
}

// ─── Gate Thresholds ─────────────────────────────────────────────────────────

const GATE = {
  minQualityScore:    6.0,
  maxCostRatio:       2.0,
  requiredCompliance: 1.0,
  maxErrorRate:       0.10,
} as const;

// ─── Quality Scoring ─────────────────────────────────────────────────────────

/**
 * Compute a quality score (0-10) by comparing shadow and buddy results.
 *
 * Scoring table (base):
 *   Both succeeded                → 8.0
 *   Shadow succeeded, buddy failed → 9.0  (shadow exceeded reference)
 *   Shadow honest-failed          → 5.0  (honest — not penalised)
 *   Shadow errored                → 2.0
 *
 * Bonuses / penalties:
 *   Shadow confidence ≥ buddy confidence → +1.0
 *   Shadow cost > 1.5× buddy cost        → -1.0
 */
function scoreComparison(shadow: TaskResult, buddy: TaskResult): number {
  let base: number;

  if (shadow.success && buddy.success)          base = 8.0;
  else if (shadow.success && !buddy.success)    base = 9.0;
  else if (shadow.honestFailure)                base = 5.0;
  else                                          base = 2.0;

  if ((shadow.confidence ?? 0) >= (buddy.confidence ?? 0) && shadow.success) base += 1.0;

  const sc = shadow.cost ?? 0;
  const bc = buddy.cost  ?? 0;
  if (bc > 0 && sc > bc * 1.5) base -= 1.0;

  return Math.max(0, Math.min(10, base));
}

/** Cost ratio, avoiding division by zero. */
function costRatio(shadow: TaskResult, buddy: TaskResult): number {
  const sc = shadow.cost ?? 0;
  const bc = buddy.cost  ?? 0;
  if (bc === 0) return sc > 0 ? 1.5 : 1.0;
  return sc / bc;
}

// ─── ShadowMode ──────────────────────────────────────────────────────────────

/**
 * ShadowMode manages one shadow session for a new agent paired with a buddy.
 *
 * Lifecycle:
 * 1. Construct: `new ShadowMode(shadowAgent, buddyAgent, onEvent)`
 * 2. Run tasks: `await session.runTask(task)` — call over 24-48 h
 * 3. Summarise: `session.aggregateResults(session.getResults())`
 * 4. Evaluate:  `session.evaluate()`
 *
 * @example
 * ```ts
 * const session = new ShadowMode(newAgent, buddyAgent, onEvent);
 * for (const task of incomingTasks) {
 *   const buddyOutput = await session.runTask(task);
 *   // Use buddyOutput operationally — shadow output is silently discarded
 * }
 * const gate = session.evaluate();
 * if (gate.passed) await pipeline.startCanary(newAgent.id);
 * ```
 */
export class ShadowMode {
  private readonly agentId:  string;
  private readonly buddyId:  string;
  private readonly startedAt: number;
  private results: ShadowResult[] = [];
  private readonly onEvent: AegisEventHandler;

  /**
   * Construct a ShadowMode session.
   * Pass agents when you have them (typical production use).
   * Passing no agents creates a stats-only instance that accepts pre-computed
   * ShadowResult objects via aggregateResults() — useful for testing.
   */
  constructor(
    private readonly shadowAgent?: AegisAgent,
    private readonly buddyAgent?:  AegisAgent,
    onEvent?: AegisEventHandler,
  ) {
    this.agentId   = shadowAgent?.id ?? "unknown";
    this.buddyId   = buddyAgent?.id  ?? "unknown";
    this.startedAt = Date.now();
    this.onEvent   = onEvent ?? (() => {});
  }

  // ─── Core Execution ────────────────────────────────────────────────────────

  /**
   * Execute a task on BOTH agents concurrently.
   * The buddy's result is returned (the operationally valid output).
   * The shadow's result is stored for comparison and then discarded from the
   * operational path.
   *
   * @param task              - The task to run on both agents
   * @param hasPolicyViolation - True if the policy engine denied any shadow tool call
   * @returns The buddy's TaskResult — the output that is actually used
   * @throws If no agents were provided at construction time
   */
  async runTask(task: Task, hasPolicyViolation: boolean = false): Promise<TaskResult> {
    if (!this.shadowAgent || !this.buddyAgent) {
      throw new Error(
        "ShadowMode.runTask() requires shadowAgent and buddyAgent to be provided at construction.",
      );
    }

    const [shadowResult, buddyResult] = await Promise.all([
      safeExecute(this.shadowAgent, task),
      safeExecute(this.buddyAgent,  task),
    ]);

    this.results.push({
      taskId:          task.id,
      timestamp:       Date.now(),
      shadowResult,
      buddyResult,
      qualityScore:    scoreComparison(shadowResult, buddyResult),
      costRatio:       costRatio(shadowResult, buddyResult),
      policyViolation: hasPolicyViolation,
      isError:         !shadowResult.success && !shadowResult.honestFailure,
    });

    return buddyResult;
  }

  // ─── Aggregation (can be called with external results for testing) ──────────

  /**
   * Aggregate an array of ShadowResult objects into summary metrics.
   * Useful when results come from an external store rather than runTask().
   *
   * @param results - ShadowResult array to aggregate
   */
  aggregateResults(results: ShadowResult[]): ShadowMetricsAggregate {
    const n           = results.length;
    const elapsedMs   = Date.now() - this.startedAt;
    const elapsedHours = elapsedMs / 3_600_000;

    if (n === 0) {
      return {
        agentId:        this.agentId,
        buddyId:        this.buddyId,
        startedAt:      this.startedAt,
        elapsedHours,
        tasksCompleted: 0,
        avgQuality:     0,
        costRatio:      1,
        toolCompliance: 1,
        errorRate:      0,
      };
    }

    const avgQuality   = avg(results.map(r => r.qualityScore));
    const avgCostRatio = avg(results.map(r => r.costRatio));
    const violations   = results.filter(r => r.policyViolation).length;
    const errors       = results.filter(r => r.isError).length;

    return {
      agentId:        this.agentId,
      buddyId:        this.buddyId,
      startedAt:      this.startedAt,
      elapsedHours,
      tasksCompleted: n,
      avgQuality,
      costRatio:      avgCostRatio,
      toolCompliance: 1 - violations / n,
      errorRate:      errors / n,
    };
  }

  /**
   * Get aggregated metrics for the current in-memory results.
   */
  getMetrics(): ShadowMetricsAggregate {
    return this.aggregateResults(this.results);
  }

  /**
   * Evaluate whether all four gates are met.
   */
  evaluate(): ShadowGateStatus {
    return this.evaluateMetrics(this.getMetrics());
  }

  /**
   * Evaluate a pre-computed ShadowMetricsAggregate against the four gates.
   * Useful when the pipeline calls evaluateShadow() with metrics from a stored session.
   */
  evaluateMetrics(metrics: ShadowMetricsAggregate): ShadowGateStatus {
    const qualityOk    = metrics.avgQuality    >= GATE.minQualityScore;
    const costOk       = metrics.costRatio     <= GATE.maxCostRatio;
    const complianceOk = metrics.toolCompliance >= GATE.requiredCompliance;
    const errorRateOk  = metrics.errorRate      < GATE.maxErrorRate;
    const passed       = qualityOk && costOk && complianceOk && errorRateOk;

    const failures: string[] = [];
    if (!qualityOk)    failures.push(`quality ${metrics.avgQuality.toFixed(2)} < ${GATE.minQualityScore}`);
    if (!costOk)       failures.push(`costRatio ${metrics.costRatio.toFixed(2)} > ${GATE.maxCostRatio}`);
    if (!complianceOk) failures.push(`compliance ${(metrics.toolCompliance * 100).toFixed(1)}% < 100%`);
    if (!errorRateOk)  failures.push(`errorRate ${(metrics.errorRate * 100).toFixed(1)}% >= ${GATE.maxErrorRate * 100}%`);

    return {
      passed,
      qualityOk,
      costOk,
      complianceOk,
      errorRateOk,
      reason: passed ? "All shadow gates passed" : `Failed: ${failures.join(", ")}`,
    };
  }

  /** Full list of individual task comparisons (for audit / debugging). */
  getResults(): ReadonlyArray<ShadowResult> {
    return this.results;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function safeExecute(agent: AegisAgent, task: Task): Promise<TaskResult> {
  try {
    return await agent.execute(task);
  } catch (err) {
    return {
      success:       false,
      honestFailure: false,
      error:         err instanceof Error ? err.message : String(err),
    };
  }
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
