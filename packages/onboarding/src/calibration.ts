/**
 * Auto-Harness Calibration — 3-step gated quality bar for agents.
 *
 * Inspired by NeoSigmaAI's calibration loop. Ensures the quality threshold
 * ONLY ever rises — the "ratchet effect". Once the bar is set, it never
 * drops back down, no matter how well the agent performed historically.
 *
 * The three gates (run in sequence):
 *
 *   Step 1 — Regression Gate:
 *     Run the agent against its current regression suite.
 *     Must pass ≥ 80% of tasks. Prevents regressions before benchmarking.
 *
 *   Step 2 — Benchmark Gate:
 *     Score the agent on the new benchmark tasks.
 *     The aggregate val_score must be ≥ the agent's best-ever val_score.
 *     If it's lower, calibration fails here — no promotion.
 *
 *   Step 3 — Suite Promotion:
 *     Tasks that the agent newly-fixed (previously failing, now passing)
 *     are added to the regression suite. The suite only grows.
 *     The best-ever score is updated (ratchet: only goes up).
 *
 * Per-agent learnings are written to a `learnings.md` entry stored via the
 * StorageAdapter. In production this maps to a file on disk; in tests it's
 * held in MemoryStorage.
 *
 * @module @a2b/onboarding/calibration
 */

import type { StorageAdapter, AegisEventHandler, Task, TaskResult, AegisAgent } from "@a2b/core";

// ─── Types ────────────────────────────────────────────────────────────────────

/** One benchmark task paired with the agent's result. */
export interface BenchmarkResult {
  task: Task;
  result: TaskResult;
  /** Quality score 0-1 assigned by an evaluator or heuristic. */
  valScore: number;
}

/** Outcome of a full calibration cycle. */
export interface CalibrationReport {
  agentId: string;
  runAt: number;

  /** Step 1 results */
  regressionPassRate: number;       // 0.0-1.0
  regressionPassed:   boolean;

  /** Step 2 results */
  benchmarkValScore:  number;       // 0.0-1.0
  previousBestScore:  number;
  benchmarkPassed:    boolean;

  /** Step 3 results */
  newTasksPromoted:   number;       // Count of newly fixed tasks added to suite
  suiteSize:          number;       // Total suite size after promotion
  newBestScore:       number;       // Updated best-ever val_score after ratchet

  /** Overall pass/fail and human-readable summary */
  passed:  boolean;
  summary: string;

  /** Markdown entry appended to this agent's learnings.md */
  learningsEntry: string;
}

/** Result of the regression gate step. */
interface RegressionGateResult {
  passRate: number;
  passed:   boolean;
  passedIds: string[];
  failedIds: string[];
}

/** Result of the benchmark gate step. */
interface BenchmarkGateResult {
  valScore:   number;
  bestScore:  number;
  passed:     boolean;
}

/** Result of suite promotion step. */
interface SuitePromotionResult {
  addedIds:  string[];
  suiteSize: number;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const REGRESSION_PASS_RATE = 0.80;   // Must pass 80% of regression suite

// ─── AutoHarness ─────────────────────────────────────────────────────────────

/**
 * AutoHarness runs the 3-step gated calibration cycle for an agent.
 *
 * It relies on a StorageAdapter for persistence of:
 *  - The per-agent regression suite (list of task IDs)
 *  - The per-agent best-ever val_score
 *
 * @example
 * ```ts
 * const harness = new AutoHarness(storage, onEvent);
 *
 * const benchmarkTasks: BenchmarkResult[] = await evaluateBatch(agent, tasks);
 * const report = await harness.runCalibration(agent, benchmarkTasks);
 *
 * if (report.passed) {
 *   console.log(`New quality bar: ${report.newBestScore}`);
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
   * Steps run sequentially. If any step fails, the cycle stops and returns a
   * CalibrationReport with `passed: false`.
   *
   * @param agent          - The agent being calibrated
   * @param benchmarkTasks - Results of running the agent on the benchmark set
   * @returns CalibrationReport with full details and a learnings.md entry
   */
  async runCalibration(
    agent: AegisAgent,
    benchmarkTasks: BenchmarkResult[],
  ): Promise<CalibrationReport> {
    const agentId = agent.id;
    const runAt   = Date.now();

    // ── Step 1: Regression Gate ─────────────────────────────────────────────
    const regression = await this.regressionGate(agent);

    if (!regression.passed) {
      const entry = this.buildLearningsEntry(
        runAt, regression, null, null, "FAILED at Step 1 (regression)",
      );
      const report: CalibrationReport = {
        agentId,
        runAt,
        regressionPassRate: regression.passRate,
        regressionPassed:   false,
        benchmarkValScore:  0,
        previousBestScore:  await this.storage.getBestScore(agentId),
        benchmarkPassed:    false,
        newTasksPromoted:   0,
        suiteSize:          (await this.storage.getRegressionSuite(agentId)).length,
        newBestScore:       await this.storage.getBestScore(agentId),
        passed:             false,
        summary:            `Regression gate failed: pass rate ${(regression.passRate * 100).toFixed(1)}% < ${REGRESSION_PASS_RATE * 100}%`,
        learningsEntry:     entry,
      };
      await this.appendLearnings(agentId, entry);
      return report;
    }

    // ── Step 2: Benchmark Gate ──────────────────────────────────────────────
    const benchmark = await this.benchmarkGate(agentId, benchmarkTasks);

    if (!benchmark.passed) {
      const entry = this.buildLearningsEntry(
        runAt, regression, benchmark, null, "FAILED at Step 2 (benchmark)",
      );
      const report: CalibrationReport = {
        agentId,
        runAt,
        regressionPassRate: regression.passRate,
        regressionPassed:   true,
        benchmarkValScore:  benchmark.valScore,
        previousBestScore:  benchmark.bestScore,
        benchmarkPassed:    false,
        newTasksPromoted:   0,
        suiteSize:          (await this.storage.getRegressionSuite(agentId)).length,
        newBestScore:       benchmark.bestScore,  // Ratchet stays where it was
        passed:             false,
        summary:            `Benchmark gate failed: val_score ${benchmark.valScore.toFixed(3)} < best ${benchmark.bestScore.toFixed(3)}`,
        learningsEntry:     entry,
      };
      await this.appendLearnings(agentId, entry);
      return report;
    }

    // ── Step 3: Suite Promotion ─────────────────────────────────────────────
    //
    // Any task that was previously FAILING (not in the passing suite) but NOW
    // passed gets promoted into the regression suite.
    const promotion = await this.suitePromotion(agentId, benchmarkTasks);

    // Apply ratchet: update best score only if this run beat it
    const newBestScore = Math.max(benchmark.bestScore, benchmark.valScore);
    await this.storage.saveBestScore(agentId, newBestScore);

    const entry = this.buildLearningsEntry(
      runAt, regression, benchmark, promotion, "PASSED",
    );
    await this.appendLearnings(agentId, entry);

    const report: CalibrationReport = {
      agentId,
      runAt,
      regressionPassRate: regression.passRate,
      regressionPassed:   true,
      benchmarkValScore:  benchmark.valScore,
      previousBestScore:  benchmark.bestScore,
      benchmarkPassed:    true,
      newTasksPromoted:   promotion.addedIds.length,
      suiteSize:          promotion.suiteSize,
      newBestScore,
      passed:             true,
      summary:            [
        `Passed all 3 gates.`,
        `Regression: ${(regression.passRate * 100).toFixed(1)}%.`,
        `Val score: ${benchmark.valScore.toFixed(3)} (best: ${newBestScore.toFixed(3)}).`,
        `Suite grew by ${promotion.addedIds.length} task(s) to ${promotion.suiteSize}.`,
      ].join(" "),
      learningsEntry: entry,
    };

    return report;
  }

  /**
   * Return the agent's current regression suite (list of task IDs).
   *
   * @param agentId - The agent whose suite to fetch
   */
  async getRegressionSuite(agentId: string): Promise<string[]> {
    return this.storage.getRegressionSuite(agentId);
  }

  // ─── Step Implementations ─────────────────────────────────────────────────

  /**
   * Step 1 — Regression Gate.
   *
   * Runs the agent against its stored regression suite. The suite is a list
   * of task IDs. For each task ID in the suite, we check whether the agent's
   * benchmark results include a passing result for that task.
   *
   * This gate is designed to be called BEFORE the benchmarkGate so we don't
   * promote an agent that has regressed on previously-passing tasks.
   *
   * Note: The regression suite starts empty for brand-new agents, in which
   * case the gate passes trivially (no regressions possible).
   *
   * @param agent - The agent to check
   */
  async regressionGate(agent: AegisAgent): Promise<RegressionGateResult> {
    const suiteIds = await this.storage.getRegressionSuite(agent.id);

    if (suiteIds.length === 0) {
      // Empty suite — new agent, trivially passes
      return { passRate: 1.0, passed: true, passedIds: [], failedIds: [] };
    }

    // Run the agent against each task in the suite sequentially.
    // In production you'd parallelise this; sequential keeps the logic clear.
    const passedIds: string[] = [];
    const failedIds: string[] = [];

    for (const taskId of suiteIds) {
      // We represent each regression task as a minimal Task object.
      // The real payload would come from a task store in production.
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
        result = {
          success: false,
          error:   err instanceof Error ? err.message : String(err),
        };
      }

      if (result.success) {
        passedIds.push(taskId);
      } else {
        failedIds.push(taskId);
      }
    }

    const passRate = passedIds.length / suiteIds.length;
    const passed   = passRate >= REGRESSION_PASS_RATE;

    return { passRate, passed, passedIds, failedIds };
  }

  /**
   * Step 2 — Benchmark Gate.
   *
   * Computes the aggregate val_score for the provided benchmark results and
   * compares it against the agent's best-ever val_score.
   *
   * The ratchet: the new score must be ≥ the best-ever score. If it isn't,
   * the gate fails and the best-ever score is NOT updated.
   *
   * @param agentId        - The agent being benchmarked
   * @param benchmarkTasks - Benchmark results from this calibration run
   */
  async benchmarkGate(
    agentId: string,
    benchmarkTasks: BenchmarkResult[],
  ): Promise<BenchmarkGateResult> {
    const bestScore = await this.storage.getBestScore(agentId);

    if (benchmarkTasks.length === 0) {
      // No benchmark tasks — cannot improve, fail the gate
      return { valScore: 0, bestScore, passed: false };
    }

    // Weighted aggregate: hard tasks count 1.3×, medium 1.0×, easy 0.8×
    const WEIGHTS: Record<Task["difficulty"], number> = {
      hard:   1.3,
      medium: 1.0,
      easy:   0.8,
    };

    let weightedSum  = 0;
    let totalWeight  = 0;
    for (const { task, valScore } of benchmarkTasks) {
      const w = WEIGHTS[task.difficulty] ?? 1.0;
      weightedSum += valScore * w;
      totalWeight += w;
    }

    const valScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const passed   = valScore >= bestScore;

    return { valScore, bestScore, passed };
  }

  /**
   * Step 3 — Suite Promotion.
   *
   * Adds newly-fixed tasks to the regression suite so they will be checked
   * in every future calibration run. "Newly fixed" means:
   *   - The task is NOT already in the suite (it wasn't previously tracked)
   *   - The agent succeeded on it this run (result.success === true)
   *
   * The suite ONLY grows — tasks are never removed.
   *
   * @param agentId        - The agent whose suite to update
   * @param benchmarkTasks - Benchmark results from this calibration run
   */
  async suitePromotion(
    agentId: string,
    benchmarkTasks: BenchmarkResult[],
  ): Promise<SuitePromotionResult> {
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
   * This is appended to the agent's `learnings.md` after every run.
   */
  private buildLearningsEntry(
    runAt:      number,
    regression: RegressionGateResult,
    benchmark:  BenchmarkGateResult | null,
    promotion:  SuitePromotionResult | null,
    outcome:    string,
  ): string {
    const date = new Date(runAt).toISOString();
    const lines: string[] = [
      `## Calibration Run — ${date}`,
      `**Outcome:** ${outcome}`,
      ``,
      `### Step 1: Regression Gate`,
      `- Pass rate: ${(regression.passRate * 100).toFixed(1)}% (need ≥ ${REGRESSION_PASS_RATE * 100}%)`,
      `- Passed: ${regression.passedIds.length} task(s)`,
      `- Failed: ${regression.failedIds.length > 0 ? regression.failedIds.join(", ") : "none"}`,
    ];

    if (benchmark) {
      lines.push(
        ``,
        `### Step 2: Benchmark Gate`,
        `- Val score this run: ${benchmark.valScore.toFixed(4)}`,
        `- Best-ever val score: ${benchmark.bestScore.toFixed(4)}`,
        `- Passed: ${benchmark.passed ? "yes" : "no"}`,
      );
    }

    if (promotion) {
      lines.push(
        ``,
        `### Step 3: Suite Promotion`,
        `- Newly promoted tasks: ${promotion.addedIds.length > 0 ? promotion.addedIds.join(", ") : "none"}`,
        `- Total suite size: ${promotion.suiteSize} task(s)`,
      );
    }

    lines.push(``, `---`, ``);
    return lines.join("\n");
  }

  /**
   * Append a learnings entry to the agent's persistent learnings log.
   *
   * The StorageAdapter doesn't have a dedicated learnings API, so we store
   * it in the audit log under the action name "learnings-entry".
   *
   * In file-backed production setups this would write to `learnings.md`
   * on disk; in MemoryStorage it accumulates in the audit log.
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
