/**
 * Auto-Harness Calibration — 3-step gated quality bar for agents.
 *
 * Inspired by NeoSigmaAI's calibration loop. The quality threshold ONLY ever
 * rises — the "ratchet effect". Once the bar is raised, it never drops back
 * down, no matter how the agent performed in previous runs.
 *
 * The three gates run in sequence:
 *
 *   Step 1 — Regression Gate
 *     Run the agent against its current regression suite (list of task IDs).
 *     Must pass ≥ 80% of tasks. Prevents regression before benchmarking.
 *     An empty suite trivially passes (new agent, no prior history).
 *
 *   Step 2 — Benchmark Gate
 *     Score the agent on the new benchmark tasks using a weighted val_score.
 *     Hard tasks count 1.3×, medium 1.0×, easy 0.8×.
 *     The aggregate val_score must be ≥ the agent's best-ever val_score.
 *     If it's lower, calibration fails here — the ratchet holds.
 *
 *   Step 3 — Suite Promotion
 *     Tasks newly fixed (not in suite + now passing) are added to the suite.
 *     The suite only grows. Best-ever score is updated (ratchet goes up only).
 *
 * Learnings are written to the agent's audit log under action "learnings-entry"
 * so the StorageAdapter can persist them as a learnings.md file.
 *
 * @module @a2b/onboarding/calibration
 */

import type {
  StorageAdapter, AegisEventHandler, Task, TaskResult, AegisAgent,
} from "@a2b/core";

// ─── Types ────────────────────────────────────────────────────────────────────

/** One benchmark task and the agent's result on it. */
export interface BenchmarkResult {
  task:     Task;
  result:   TaskResult;
  /** Quality score 0-1 assigned by an evaluator or heuristic function. */
  valScore: number;
}

/** Full report produced by a calibration run. */
export interface CalibrationReport {
  agentId:  string;
  runAt:    number;

  // Step 1
  regressionPassRate: number;    // 0.0-1.0
  regressionPassed:   boolean;

  // Step 2
  benchmarkValScore:  number;    // 0.0-1.0 (weighted)
  previousBestScore:  number;
  benchmarkPassed:    boolean;

  // Step 3
  newTasksPromoted:   number;    // Count of task IDs added to suite
  suiteSize:          number;    // Total suite size after promotion
  newBestScore:       number;    // Best-ever val_score after this run

  passed:         boolean;
  summary:        string;
  /** Markdown text appended to this agent's learnings log. */
  learningsEntry: string;
}

// ─── Internal step results ────────────────────────────────────────────────────

interface RegressionResult {
  passRate:  number;
  passed:    boolean;
  passedIds: string[];
  failedIds: string[];
}

interface BenchmarkGateResult {
  valScore:  number;
  bestScore: number;
  passed:    boolean;
}

interface PromotionResult {
  addedIds:  string[];
  suiteSize: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REGRESSION_PASS_RATE = 0.80;

/** Difficulty weights for computing the aggregate benchmark score. */
const DIFFICULTY_WEIGHTS: Record<Task["difficulty"], number> = {
  hard:   1.3,
  medium: 1.0,
  easy:   0.8,
};

// ─── AutoHarness ─────────────────────────────────────────────────────────────

/**
 * AutoHarness runs the 3-step gated calibration cycle for an agent.
 *
 * It relies on a StorageAdapter for:
 *   - Regression suite: list of task IDs that must pass every run
 *   - Best-ever val_score: the ratchet floor
 *
 * @example
 * ```ts
 * const harness = new AutoHarness(storage, onEvent);
 *
 * // Evaluate the agent on a fresh batch of benchmark tasks:
 * const benchmarkResults = await evaluateBatch(agent, tasks);
 * const report = await harness.runCalibration(agent, benchmarkResults);
 *
 * if (report.passed) {
 *   console.log(`New quality bar: ${report.newBestScore}`);
 * } else {
 *   console.warn(report.summary);
 * }
 * ```
 */
export class AutoHarness {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly onEvent: AegisEventHandler = () => {},
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Run a full calibration cycle for an agent.
   *
   * Steps execute sequentially. Failure at any step stops the cycle and
   * returns a CalibrationReport with `passed: false`.
   *
   * @param agent          - The agent being calibrated
   * @param benchmarkTasks - Results from running the agent on the benchmark set
   */
  async runCalibration(
    agent:          AegisAgent,
    benchmarkTasks: BenchmarkResult[],
  ): Promise<CalibrationReport> {
    const agentId = agent.id;
    const runAt   = Date.now();

    // ── Step 1: Regression Gate ─────────────────────────────────────────────
    const regression = await this.regressionGate(agent);

    if (!regression.passed) {
      const previousBestScore = await this.storage.getBestScore(agentId);
      const suiteSize         = (await this.storage.getRegressionSuite(agentId)).length;
      const entry             = this.buildLearningsEntry(runAt, regression, null, null, "FAILED (Step 1: regression)");
      await this.appendLearnings(agentId, entry);

      return {
        agentId, runAt,
        regressionPassRate: regression.passRate,
        regressionPassed:   false,
        benchmarkValScore:  0,
        previousBestScore,
        benchmarkPassed:    false,
        newTasksPromoted:   0,
        suiteSize,
        newBestScore:       previousBestScore,
        passed:   false,
        summary:  `Regression gate failed: ${(regression.passRate * 100).toFixed(1)}% passed (need ≥ ${REGRESSION_PASS_RATE * 100}%). Failed tasks: ${regression.failedIds.join(", ") || "none"}.`,
        learningsEntry: entry,
      };
    }

    // ── Step 2: Benchmark Gate ──────────────────────────────────────────────
    const benchmark = await this.benchmarkGate(agentId, benchmarkTasks);

    if (!benchmark.passed) {
      const suiteSize = (await this.storage.getRegressionSuite(agentId)).length;
      const entry     = this.buildLearningsEntry(runAt, regression, benchmark, null, "FAILED (Step 2: benchmark)");
      await this.appendLearnings(agentId, entry);

      return {
        agentId, runAt,
        regressionPassRate: regression.passRate,
        regressionPassed:   true,
        benchmarkValScore:  benchmark.valScore,
        previousBestScore:  benchmark.bestScore,
        benchmarkPassed:    false,
        newTasksPromoted:   0,
        suiteSize,
        newBestScore:       benchmark.bestScore,   // Ratchet unchanged
        passed:   false,
        summary:  `Benchmark gate failed: val_score ${benchmark.valScore.toFixed(4)} < best ${benchmark.bestScore.toFixed(4)}.`,
        learningsEntry: entry,
      };
    }

    // ── Step 3: Suite Promotion ─────────────────────────────────────────────
    const promotion = await this.suitePromotion(agentId, benchmarkTasks);

    // Ratchet: new best score is the max of old and new
    const newBestScore = Math.max(benchmark.bestScore, benchmark.valScore);
    await this.storage.saveBestScore(agentId, newBestScore);

    const entry = this.buildLearningsEntry(runAt, regression, benchmark, promotion, "PASSED");
    await this.appendLearnings(agentId, entry);

    return {
      agentId, runAt,
      regressionPassRate: regression.passRate,
      regressionPassed:   true,
      benchmarkValScore:  benchmark.valScore,
      previousBestScore:  benchmark.bestScore,
      benchmarkPassed:    true,
      newTasksPromoted:   promotion.addedIds.length,
      suiteSize:          promotion.suiteSize,
      newBestScore,
      passed:  true,
      summary: [
        "All 3 gates passed.",
        `Regression: ${(regression.passRate * 100).toFixed(1)}%.`,
        `Val score: ${benchmark.valScore.toFixed(4)} (best now: ${newBestScore.toFixed(4)}).`,
        `Suite grew by ${promotion.addedIds.length} task(s) to ${promotion.suiteSize} total.`,
      ].join(" "),
      learningsEntry: entry,
    };
  }

  /**
   * Get the current regression suite for an agent.
   */
  async getRegressionSuite(agentId: string): Promise<string[]> {
    return this.storage.getRegressionSuite(agentId);
  }

  /**
   * Get the best-ever val_score for an agent (the ratchet floor).
   */
  async getBestScore(agentId: string): Promise<number> {
    return this.storage.getBestScore(agentId);
  }

  // ─── Step Implementations ─────────────────────────────────────────────────

  /**
   * Step 1 — Regression Gate.
   *
   * Retrieves the agent's stored suite and runs the agent against each task.
   * An empty suite trivially passes (new agent with no prior history).
   *
   * In production the task store would hydrate full task objects from IDs;
   * here we construct minimal Task objects so the logic is self-contained.
   */
  async regressionGate(agent: AegisAgent): Promise<RegressionResult> {
    const suiteIds = await this.storage.getRegressionSuite(agent.id);

    if (suiteIds.length === 0) {
      return { passRate: 1.0, passed: true, passedIds: [], failedIds: [] };
    }

    const passedIds: string[] = [];
    const failedIds: string[] = [];

    // Run sequentially to avoid overwhelming the agent / external APIs
    for (const taskId of suiteIds) {
      const task: Task = {
        id:          taskId,
        description: `[Regression] ${taskId}`,
        difficulty:  "medium",
        isCanary:    false,
        createdAt:   Date.now(),
      };

      let result: TaskResult;
      try {
        result = await agent.execute(task);
      } catch (err) {
        result = { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      if (result.success) passedIds.push(taskId);
      else                failedIds.push(taskId);
    }

    const passRate = passedIds.length / suiteIds.length;
    return { passRate, passed: passRate >= REGRESSION_PASS_RATE, passedIds, failedIds };
  }

  /**
   * Step 2 — Benchmark Gate.
   *
   * Computes the weighted aggregate val_score from benchmark results and
   * compares it to the agent's best-ever val_score (the ratchet floor).
   * The gate passes only if the new score is ≥ the best ever.
   */
  async benchmarkGate(
    agentId:        string,
    benchmarkTasks: BenchmarkResult[],
  ): Promise<BenchmarkGateResult> {
    const bestScore = await this.storage.getBestScore(agentId);

    if (benchmarkTasks.length === 0) {
      return { valScore: 0, bestScore, passed: false };
    }

    let weightedSum = 0;
    let totalWeight = 0;

    for (const { task, valScore } of benchmarkTasks) {
      const w = DIFFICULTY_WEIGHTS[task.difficulty] ?? 1.0;
      weightedSum += valScore * w;
      totalWeight += w;
    }

    const valScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return { valScore, bestScore, passed: valScore >= bestScore };
  }

  /**
   * Step 3 — Suite Promotion.
   *
   * Adds newly-fixed tasks to the regression suite. A task is "newly fixed" if:
   *   - It is NOT already in the suite (wasn't tracked before)
   *   - The agent succeeded on it this run (result.success === true)
   *
   * The suite only grows. Tasks are never removed.
   */
  async suitePromotion(
    agentId:        string,
    benchmarkTasks: BenchmarkResult[],
  ): Promise<PromotionResult> {
    const currentSuite = new Set(await this.storage.getRegressionSuite(agentId));
    const addedIds: string[] = [];

    for (const { task, result } of benchmarkTasks) {
      if (result.success && !currentSuite.has(task.id)) {
        currentSuite.add(task.id);
        addedIds.push(task.id);
      }
    }

    const updatedSuite = Array.from(currentSuite);
    await this.storage.saveRegressionSuite(agentId, updatedSuite);
    return { addedIds, suiteSize: updatedSuite.length };
  }

  // ─── Learnings ────────────────────────────────────────────────────────────

  /**
   * Build a Markdown entry summarising one calibration run.
   * This is appended to the agent's learnings log after every run.
   */
  private buildLearningsEntry(
    runAt:      number,
    regression: RegressionResult,
    benchmark:  BenchmarkGateResult | null,
    promotion:  PromotionResult     | null,
    outcome:    string,
  ): string {
    const date  = new Date(runAt).toISOString();
    const lines = [
      `## Calibration Run — ${date}`,
      `**Outcome:** ${outcome}`,
      ``,
      `### Step 1: Regression Gate`,
      `- Pass rate: ${(regression.passRate * 100).toFixed(1)}% (need ≥ ${REGRESSION_PASS_RATE * 100}%)`,
      `- Passed tasks: ${regression.passedIds.length}`,
      `- Failed tasks: ${regression.failedIds.length > 0 ? regression.failedIds.join(", ") : "none"}`,
    ];

    if (benchmark) {
      lines.push(
        ``,
        `### Step 2: Benchmark Gate`,
        `- Val score this run: ${benchmark.valScore.toFixed(4)}`,
        `- Best-ever val score: ${benchmark.bestScore.toFixed(4)}`,
        `- Passed: ${benchmark.passed ? "yes" : "no — score did not beat the ratchet"}`,
      );
    }

    if (promotion) {
      lines.push(
        ``,
        `### Step 3: Suite Promotion`,
        `- Newly promoted tasks: ${promotion.addedIds.length > 0 ? promotion.addedIds.join(", ") : "none"}`,
        `- Total suite size after promotion: ${promotion.suiteSize}`,
      );
    }

    lines.push(``, `---`, ``);
    return lines.join("\n");
  }

  /**
   * Append a learnings entry to the agent's persistent audit log.
   * In file-backed storage this maps to learnings.md on disk.
   */
  private async appendLearnings(agentId: string, entry: string): Promise<void> {
    await this.storage.appendAudit({
      id:        `cal-${Date.now()}-${agentId}`,
      timestamp: Date.now(),
      agentId,
      tier:      0,
      action:    "learnings-entry",
      allowed:   true,
      reason:    entry,
      outcome:   "success",
    });
  }
}
