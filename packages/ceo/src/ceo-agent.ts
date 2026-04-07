/**
 * CEO Agent — Top-level supervisor for the A2B agent framework
 *
 * The CEO Agent is the only agent that operates without a trust score of its
 * own. It is the root of trust. It:
 *
 *   1. Runs a monitoring cycle at a configurable interval (default: 5 min).
 *   2. Evaluates every registered agent on a composite scorecard.
 *   3. Applies PID-controller corrections when performance drifts.
 *   4. Promotes / demotes agents according to TierManager criteria.
 *   5. Detects gaming (shadow metrics) and collusion (evaluator correlation).
 *   6. Resolves resource conflicts via MergeQueue.
 *   7. Traces cascading failures to their root cause via BlameDAG.
 *   8. Maintains a dead man's switch so external systems know it is alive.
 *   9. Generates a plain-English daily report for the human owner.
 *
 * Architecture note:
 * The CEO is intentionally stateless across runs — all durable state lives in
 * the AgentRegistry's StorageAdapter. This means the CEO can be restarted
 * without losing agent history.
 */

import {
  TierManager,
  PolicyEngine,
  AgentRegistry,
  detectCollusion,
  adjustedScore,
  decayTrust,
  DEFAULT_SCORECARD_WEIGHTS,
} from "@a2b/core";

import type {
  AgentRecord,
  AegisEvent,
  AegisEventHandler,
  AegisConfig,
  Tier,
  ShadowMetrics,
  AgentStatus,
  StorageAdapter,
} from "@a2b/core";

import { Watchdog } from "./watchdog.js";
import { MonitorRegistry } from "./monitor.js";
import { MergeQueue, BlameDAG } from "./conflict.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CEOAgentConfig {
  /**
   * Unique ID for this CEO instance. Embedded in heartbeat events and reports.
   * Default: "ceo-1"
   */
  id?: string;

  /**
   * Human-readable name for this CEO Agent.
   * Default: "CEO Agent"
   */
  name?: string;

  /**
   * How often (ms) the main monitoring cycle runs.
   * Default: 300_000 (5 minutes)
   */
  cycleIntervalMs?: number;

  /**
   * How often (ms) the watchdog heartbeat fires.
   * Must be less than watchdogTimeoutMs. Default: 300_000.
   */
  heartbeatIntervalMs?: number;

  /**
   * How long (ms) without a heartbeat before the watchdog declares the CEO dead.
   * Default: 600_000 (10 minutes — 2× heartbeat interval)
   */
  watchdogTimeoutMs?: number;

  /**
   * Trust decay rate per day of inactivity. Default: 0.99.
   */
  trustDecayRate?: number;

  /**
   * Days of inactivity before the CEO auto-demotes an agent. Default: 90.
   */
  inactivityDemotionDays?: number;

  /**
   * Canary score gap above which gaming is flagged. Default: 0.15.
   */
  canaryGapThreshold?: number;

  /**
   * Pearson correlation above which collusion is flagged. Default: 0.90.
   */
  collusionThreshold?: number;

  /**
   * Called when any CEO action generates an AegisEvent.
   */
  onEvent?: AegisEventHandler;

  /**
   * Called when the watchdog goes stale (CEO missed heartbeats).
   */
  onWatchdogStale?: (lastSeen: number, staleSinceMs: number) => void | Promise<void>;

  /**
   * Forwarded to TierManager (tier config overrides, promotion criteria, etc.)
   */
  frameworkConfig?: AegisConfig;

  /**
   * Storage adapter for the AgentRegistry.
   */
  storage?: StorageAdapter;
}

/** Weighted scorecard result for one agent evaluation cycle. */
export interface AgentEvaluation {
  agentId: string;
  agentName: string;
  tier: Tier;
  rawTrustScore: number;
  adjustedTrustScore: number;
  errorRate: number;
  totalTasks: number;
  dailyCost: number;
  compositeScore: number;
  /** Shadow-metric flags that were triggered this cycle. */
  shadowFlags: string[];
  recommendedAction: "ok" | "warn" | "demote" | "pause" | "promote";
  actionReason: string;
  timestamp: number;
}

/** Full daily report delivered to the human owner. */
export interface DailyReport {
  generatedAt: number;
  periodStartMs: number;
  periodEndMs: number;
  ceoId: string;

  // Fleet summary
  totalAgents: number;
  enabledAgents: number;
  byTier: Record<number, number>;

  // Health summary
  healthy: number;
  warned: number;
  demoted: number;
  promoted: number;
  paused: number;

  // Cost
  totalDailyCost: number;
  avgCostPerAgent: number;
  topCostAgents: Array<{ agentId: string; name: string; cost: number }>;

  // Risk flags
  gamingDetected: Array<{ agentId: string; metric: string; value: number }>;
  collusionDetected: Array<{ agents: string[]; flags: string[] }>;
  cascadeEvents: number;
  missedHeartbeats: number;

  // Full evaluation results
  evaluations: AgentEvaluation[];

  /** One plain-English paragraph for the human owner. */
  summary: string;
}

// ─── CEO Agent ────────────────────────────────────────────────────────────────

export class CEOAgent {
  readonly id: string;
  readonly name: string;

  // Sub-systems
  private readonly registry: AgentRegistry;
  private readonly tierManager: TierManager;
  private readonly policy: PolicyEngine;
  private readonly watchdog: Watchdog;
  private readonly monitors: MonitorRegistry;

  /** Public so the task-routing layer can call claimResource() directly. */
  readonly mergeQueue: MergeQueue;

  /** Public so failure handlers can call addFailure() directly. */
  readonly blameDAG: BlameDAG;

  // Resolved config values
  private readonly cycleIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly trustDecayRate: number;
  private readonly inactivityDemotionDays: number;
  private readonly canaryGapThreshold: number;

  private readonly onEvent: AegisEventHandler;

  // Timer handles
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Per-day accumulators (reset when the daily report is emitted)
  private lastReportAt: number = 0;
  private dayTotals = this.freshDayTotals();

  /**
   * Evaluation score history, keyed by agentId.
   * Used as a proxy for evaluator scoring history in collusion detection.
   * Bounded to the last 50 values per agent.
   */
  private evalHistory: Map<string, number[]> = new Map();

  constructor(config: CEOAgentConfig = {}) {
    this.id   = config.id   ?? "ceo-1";
    this.name = config.name ?? "CEO Agent";

    this.cycleIntervalMs        = config.cycleIntervalMs        ?? 300_000;
    this.heartbeatIntervalMs    = config.heartbeatIntervalMs    ?? 300_000;
    this.trustDecayRate         = config.trustDecayRate         ?? 0.99;
    this.inactivityDemotionDays = config.inactivityDemotionDays ?? 90;
    this.canaryGapThreshold     = config.canaryGapThreshold     ?? 0.15;

    this.onEvent = config.onEvent ?? (() => {});

    this.registry = new AgentRegistry(config.storage);

    this.tierManager = new TierManager({
      onEvent: (e) => this.emit(e),
    });

    this.policy = new PolicyEngine({
      onEvent: (e) => this.emit(e),
    });

    this.watchdog = new Watchdog({
      ceoAgentId: this.id,
      timeoutMs:  config.watchdogTimeoutMs ?? 600_000,
      onEvent:    (e) => this.emit(e),
      onStale: (lastSeen, staleSinceMs) => {
        this.dayTotals.missedHeartbeats++;
        return config.onWatchdogStale?.(lastSeen, staleSinceMs);
      },
    });

    this.monitors  = new MonitorRegistry({ windowDays: 7 });
    this.mergeQueue = new MergeQueue({ onEvent: (e) => this.emit(e) });
    this.blameDAG   = new BlameDAG({ onEvent: (e) => this.emit(e) });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the CEO Agent: begin the monitoring cycle and heartbeat timer.
   * Calling start() when already running is a safe no-op.
   */
  start(): void {
    if (this.cycleTimer !== null) return;

    this.watchdog.startMonitoring();

    // Emit the first heartbeat immediately, then on schedule
    this.watchdog.ping();
    this.heartbeatTimer = setInterval(() => {
      this.watchdog.ping();
    }, this.heartbeatIntervalMs);

    // Monitoring cycle — first run is deferred by one full interval so the
    // registry has time to warm up before we evaluate anything.
    this.cycleTimer = setInterval(() => {
      this.runCycle().catch((err: unknown) => {
        console.error(`[${this.name}] runCycle error:`, err);
      });
    }, this.cycleIntervalMs);
  }

  /**
   * Stop all timers. Does not reset accumulated state.
   */
  stop(): void {
    if (this.cycleTimer !== null) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.watchdog.stop();
  }

  // ─── Main Monitoring Cycle ─────────────────────────────────────────────────

  /**
   * Run one full monitoring cycle.
   *
   * Called automatically on the timer set in start(). Can also be invoked
   * manually in tests or for on-demand evaluations.
   *
   * Order of operations:
   *   1. Fetch all enabled agents.
   *   2. Apply trust decay for inactive agents.
   *   3. Evaluate each agent (composite scorecard + PID).
   *   4. Apply recommended actions (promote / demote / warn / pause).
   *   5. Progress any in-flight canary rollouts.
   *   6. Run gaming detection on shadow metrics.
   *   7. Run pairwise collusion detection.
   *   8. Generate and emit daily report if 24 h have elapsed.
   *
   * Returns the list of AgentEvaluation objects from this cycle.
   */
  async runCycle(): Promise<AgentEvaluation[]> {
    const cycleNow = Date.now();
    const agents = await this.registry.getEnabled();
    const evaluations: AgentEvaluation[] = [];

    for (const agent of agents) {
      // Step 1: Trust decay
      await this.applyDecay(agent, cycleNow);

      // Step 2: Evaluate
      const evaluation = await this.evaluateAgent(agent.id);
      if (!evaluation) continue;
      evaluations.push(evaluation);

      // Step 3: Feed composite score into PID monitor
      this.monitors.record(agent.id, "compositeScore", cycleNow, evaluation.compositeScore);

      // Step 4: Apply action
      await this.applyAction(agent, evaluation);

      // Step 5: Canary progression
      await this.progressCanary(agent, cycleNow);

      // Step 6: Gaming detection
      await this.detectGaming(agent);
    }

    // Step 7: Collusion detection (pairwise)
    await this.detectCollusion(agents);

    // Step 8: Daily report
    const hoursSinceReport = (cycleNow - this.lastReportAt) / 3_600_000;
    if (this.lastReportAt === 0 || hoursSinceReport >= 24) {
      const report = await this.generateReport();
      this.lastReportAt = cycleNow;
      this.dayTotals = this.freshDayTotals();

      // In production this would be sent to a dashboard / webhook.
      // Here we log to stdout so the event is visible in process logs.
      console.info(`[${this.name}] Daily report:\n${report.summary}`);
    }

    return evaluations;
  }

  // ─── Agent Evaluation ──────────────────────────────────────────────────────

  /**
   * Evaluate a single agent and return a full AgentEvaluation.
   * Returns null if the agent is not found.
   *
   * Composite score formula:
   *   compositeScore = Σ(weight_i × metric_i)
   *
   *   quality        — shadow-metric-adjusted trust score (0-1)
   *   reliability    — 1 - errorRate (0-1)
   *   safety         — 1 - clamp(policyDenials / 10, 0, 1)
   *   costEfficiency — 1 - clamp(dailyCost / tierBudget, 0, 1)
   *   improvement    — PID derivative clamped to [0, 1] (positive = improving)
   */
  async evaluateAgent(agentId: string): Promise<AgentEvaluation | null> {
    const agent = await this.registry.get(agentId);
    if (!agent) return null;

    const weights = DEFAULT_SCORECARD_WEIGHTS[agent.type] ?? DEFAULT_SCORECARD_WEIGHTS.custom;
    const shadow  = agent.shadowMetrics ?? defaultShadowMetrics();

    // quality: penalise difficulty-avoidance, low attempt rate, etc.
    const qualityScore = adjustedScore(agent.trust.score, shadow);

    // reliability
    const errorRate   = agent.totalTasks > 0 ? agent.totalErrors / agent.totalTasks : 0;
    const reliability = 1 - errorRate;

    // safety: count policy denials in recent audit log (max 100 entries)
    const recentAudit = this.policy.getAuditLog(agentId, 100);
    const denials = recentAudit.filter(e => !e.allowed).length;
    const safety  = Math.max(0, 1 - denials / 10);

    // costEfficiency
    const dailyCost       = this.policy.getDailyCost(agentId);
    const tierDailyBudget = TIER_DAILY_BUDGETS[agent.tier] ?? 1;
    const costEfficiency  = tierDailyBudget > 0
      ? 1 - Math.min(1, dailyCost / tierDailyBudget)
      : 1;

    // improvement: PID derivative → clamp [-1,+1] then shift to [0,1]
    const pidState = this.monitors.getPIDState(agentId, "compositeScore");
    const rawDeriv = pidState ? pidState.derivative : 0;
    const improvement = Math.max(0, Math.min(1, rawDeriv + 0.5));

    const compositeScore =
      weights.quality        * qualityScore   +
      weights.reliability    * reliability    +
      weights.safety         * safety         +
      weights.costEfficiency * costEfficiency +
      weights.improvement    * improvement;

    // Shadow flags
    const shadowFlags = computeShadowFlags(shadow, this.canaryGapThreshold);

    // Recommended action
    const { recommendedAction, actionReason } =
      this.computeRecommendedAction(agent, compositeScore, shadowFlags);

    // Record in eval history for collusion detection
    const hist = this.evalHistory.get(agentId) ?? [];
    hist.push(compositeScore);
    if (hist.length > 50) hist.shift();
    this.evalHistory.set(agentId, hist);

    return {
      agentId,
      agentName:          agent.name,
      tier:               agent.tier,
      rawTrustScore:      agent.trust.score,
      adjustedTrustScore: qualityScore,
      errorRate,
      totalTasks:         agent.totalTasks,
      dailyCost,
      compositeScore,
      shadowFlags,
      recommendedAction,
      actionReason,
      timestamp:          Date.now(),
    };
  }

  // ─── Daily Report ──────────────────────────────────────────────────────────

  /**
   * Generate the daily report.
   *
   * Can be called manually at any time (e.g., on-demand from a dashboard).
   * The automatic cycle calls this every 24 h.
   */
  async generateReport(): Promise<DailyReport> {
    const now       = Date.now();
    const allAgents = await this.registry.getAll();
    const summary   = await this.registry.getSummary();

    // Re-evaluate all enabled agents for this snapshot
    const evaluations: AgentEvaluation[] = [];
    for (const a of allAgents) {
      if (!a.enabled) continue;
      const ev = await this.evaluateAgent(a.id);
      if (ev) evaluations.push(ev);
    }

    const healthy  = evaluations.filter(e => e.recommendedAction === "ok").length;
    const warned   = evaluations.filter(e => e.recommendedAction === "warn").length;
    const toPromote = evaluations.filter(e => e.recommendedAction === "promote").length;

    const totalDailyCost  = evaluations.reduce((s, e) => s + e.dailyCost, 0);
    const avgCostPerAgent = evaluations.length > 0
      ? totalDailyCost / evaluations.length
      : 0;

    const topCostAgents = [...evaluations]
      .sort((a, b) => b.dailyCost - a.dailyCost)
      .slice(0, 5)
      .map(e => ({ agentId: e.agentId, name: e.agentName, cost: e.dailyCost }));

    const summaryText = buildExecutiveSummary({
      totalAgents:    summary.total,
      enabled:        summary.enabled,
      healthy,
      warned,
      promoted:       this.dayTotals.promoted,
      demoted:        this.dayTotals.demoted,
      paused:         this.dayTotals.paused,
      totalCost:      totalDailyCost,
      gamingCount:    this.dayTotals.gamingFlags.length,
      collusionCount: this.dayTotals.collusionFlags.length,
      cascades:       this.dayTotals.cascadeEvents,
      toPromote,
    });

    return {
      generatedAt:       now,
      periodStartMs:     this.lastReportAt > 0 ? this.lastReportAt : now - 86_400_000,
      periodEndMs:       now,
      ceoId:             this.id,
      totalAgents:       summary.total,
      enabledAgents:     summary.enabled,
      byTier:            summary.byTier,
      healthy,
      warned,
      demoted:           this.dayTotals.demoted,
      promoted:          this.dayTotals.promoted,
      paused:            this.dayTotals.paused,
      totalDailyCost,
      avgCostPerAgent,
      topCostAgents,
      gamingDetected:    this.dayTotals.gamingFlags,
      collusionDetected: this.dayTotals.collusionFlags,
      cascadeEvents:     this.dayTotals.cascadeEvents,
      missedHeartbeats:  this.dayTotals.missedHeartbeats,
      evaluations,
      summary:           summaryText,
    };
  }

  // ─── Watchdog / Status accessors ───────────────────────────────────────────

  /** True if the watchdog is alive (last ping within timeout window). */
  isAlive(): boolean {
    return this.watchdog.isAlive();
  }

  /** Timestamp (ms) of the most recent watchdog ping. */
  getLastHeartbeat(): number {
    return this.watchdog.getLastHeartbeat();
  }

  /**
   * Get all agent statuses (for dashboards that don't need full evaluations).
   */
  async getAgentStatuses(): Promise<AgentStatus[]> {
    const agents = await this.registry.getAll();
    return agents.map(a => ({
      id:              a.id,
      name:            a.name,
      tier:            a.tier,
      trustScore:      a.trust.score,
      trustLowerBound: a.trust.lowerBound,
      errorRate:       a.totalTasks > 0 ? a.totalErrors / a.totalTasks : 0,
      totalTasks:      a.totalTasks,
      streak:          a.streak,
      onboardingPhase: a.onboardingPhase,
      isHealthy:       a.trust.score > 0.40 && a.enabled,
    }));
  }

  /**
   * Direct access to the registry.
   * Use this to register agents and seed data in tests.
   */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  // ─── Private — Action application ─────────────────────────────────────────

  /**
   * Apply trust decay for inactive agents and auto-demote after long inactivity.
   */
  private async applyDecay(agent: AgentRecord, now: number): Promise<void> {
    if (agent.lastTaskAt === 0) return;

    const daysSinceTask = (now - agent.lastTaskAt) / 86_400_000;
    if (daysSinceTask <= 1) return;

    agent.trust = decayTrust(agent.trust, daysSinceTask, this.trustDecayRate);

    if (daysSinceTask > this.inactivityDemotionDays && agent.tier > 0) {
      this.tierManager.demote(agent, `${Math.floor(daysSinceTask)} days inactive`);
      this.dayTotals.demoted++;
    }

    await this.registry.save(agent);
  }

  /**
   * Apply the evaluation's recommended action to the live agent record.
   */
  private async applyAction(
    agent: AgentRecord,
    evaluation: AgentEvaluation,
  ): Promise<void> {
    switch (evaluation.recommendedAction) {
      case "promote": {
        const check = this.tierManager.checkPromotion(agent);
        if (check.eligible) {
          const updated = this.tierManager.promote(agent, evaluation.actionReason);
          await this.registry.save(updated);
          this.dayTotals.promoted++;
        }
        break;
      }

      case "demote": {
        const updated = this.tierManager.demote(agent, evaluation.actionReason);
        await this.registry.save(updated);
        this.dayTotals.demoted++;
        break;
      }

      case "pause": {
        agent.onboardingPhase = "paused";
        agent.enabled = false;
        await this.registry.save(agent);
        this.dayTotals.paused++;
        this.emit({
          type:      "agent-paused",
          agentId:   agent.id,
          reason:    evaluation.actionReason,
          timestamp: Date.now(),
        });
        break;
      }

      case "warn":
      case "ok":
        break; // No structural change — surfaced in the report.
    }
  }

  /**
   * Progress a canary rollout if enough time has elapsed.
   */
  private async progressCanary(agent: AgentRecord, now: number): Promise<void> {
    const cp = agent.canaryProgress;
    if (!cp) return;

    const weeksElapsed = (now - cp.startedAt) / (7 * 86_400_000);
    if (weeksElapsed < cp.weekNumber) return;

    // Use the rolling average trust score as the "week score"
    const weekScore = agent.trust.score;
    // Count errors in the canary window (approximation — real impl would filter by date)
    const weekErrors = Math.round(agent.totalErrors * 0.25); // rough estimate

    const updated = this.tierManager.progressCanary(agent, weekScore, weekErrors);
    await this.registry.save(updated);
  }

  /**
   * Determine what action the CEO should recommend for an agent.
   */
  private computeRecommendedAction(
    agent: AgentRecord,
    compositeScore: number,
    shadowFlags: string[],
  ): { recommendedAction: AgentEvaluation["recommendedAction"]; actionReason: string } {
    // Multiple gaming flags + very low score → pause immediately
    if (shadowFlags.length >= 3 && compositeScore < 0.40) {
      return {
        recommendedAction: "pause",
        actionReason: `Multiple gaming indicators (${shadowFlags.join(", ")}) with composite score ${compositeScore.toFixed(2)} — paused for investigation`,
      };
    }

    // TierManager demotion check (trust-score and error-rate thresholds)
    const demCheck = this.tierManager.checkDemotion(agent);
    if (demCheck.shouldDemote) {
      return { recommendedAction: "demote", actionReason: demCheck.reason };
    }

    // PID monitor demotion signal
    const pidMonitor = this.monitors.get(agent.id, "compositeScore");
    if (pidMonitor.shouldDemote()) {
      const state = pidMonitor.getPIDState();
      return {
        recommendedAction: "demote",
        actionReason: `PID correction ${state?.correction.toFixed(3) ?? "?"} below demotion threshold over 7-day window`,
      };
    }

    // Warning zone
    if (demCheck.shouldWarn || pidMonitor.shouldWarn()) {
      return {
        recommendedAction: "warn",
        actionReason: demCheck.shouldWarn
          ? demCheck.reason
          : "PID correction trending negative — monitor closely",
      };
    }

    // Promotion check
    const promoCheck = this.tierManager.checkPromotion(agent);
    if (promoCheck.eligible) {
      return {
        recommendedAction: "promote",
        actionReason: promoCheck.reason,
      };
    }

    return {
      recommendedAction: "ok",
      actionReason: "Agent is performing within normal thresholds",
    };
  }

  // ─── Private — Gaming detection ────────────────────────────────────────────

  /**
   * Check shadow metrics for gaming behaviour and emit events.
   */
  private async detectGaming(agent: AgentRecord): Promise<void> {
    const shadow = agent.shadowMetrics;
    if (!shadow) return;

    type CheckDef = {
      metric: keyof ShadowMetrics;
      threshold: number;
      direction: "above" | "below";
    };

    const checks: CheckDef[] = [
      { metric: "difficultyAvoidance", threshold: 0.70,                      direction: "above" },
      { metric: "attemptRate",          threshold: 0.50,                      direction: "below" },
      { metric: "refusalRate",          threshold: 0.30,                      direction: "above" },
      { metric: "canaryScoreGap",       threshold: this.canaryGapThreshold,   direction: "above" },
    ];

    for (const { metric, threshold, direction } of checks) {
      const value = shadow[metric];
      const triggered = direction === "above" ? value > threshold : value < threshold;

      if (triggered) {
        this.dayTotals.gamingFlags.push({ agentId: agent.id, metric, value });
        this.emit({
          type:      "gaming-detected",
          agentId:   agent.id,
          metric,
          value,
          timestamp: Date.now(),
        });
      }
    }
  }

  // ─── Private — Collusion detection ────────────────────────────────────────

  /**
   * Pairwise collusion detection across all agents with ≥ 5 evaluation scores.
   */
  private async detectCollusion(agents: AgentRecord[]): Promise<void> {
    const ids = agents
      .map(a => a.id)
      .filter(id => (this.evalHistory.get(id) ?? []).length >= 5);

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const histA = this.evalHistory.get(ids[i])!;
        const histB = this.evalHistory.get(ids[j])!;

        const { risk, flags } = detectCollusion(histA, histB, /* isReciprocal= */ true);

        if (risk > 0.5 || flags.length >= 2) {
          const entry = { agents: [ids[i], ids[j]], flags };
          this.dayTotals.collusionFlags.push(entry);
          this.emit({
            type:      "collusion-detected",
            agents:    [ids[i], ids[j]],
            flags,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  // ─── Private — Utilities ───────────────────────────────────────────────────

  /**
   * Emit an AegisEvent. Errors in the handler are swallowed so a bad handler
   * cannot kill the CEO monitoring cycle.
   */
  private emit(event: AegisEvent): void {
    try {
      const result = this.onEvent(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error(`[${this.name}] onEvent handler threw:`, err);
        });
      }
    } catch (err) {
      console.error(`[${this.name}] onEvent handler threw synchronously:`, err);
    }
  }

  private freshDayTotals() {
    return {
      demoted:         0,
      promoted:        0,
      paused:          0,
      gamingFlags:     [] as Array<{ agentId: string; metric: string; value: number }>,
      collusionFlags:  [] as Array<{ agents: string[]; flags: string[] }>,
      cascadeEvents:   0,
      missedHeartbeats: 0,
    };
  }
}

// ─── Module-private helpers ───────────────────────────────────────────────────

const TIER_DAILY_BUDGETS: Record<Tier, number> = { 0: 1, 1: 2, 2: 10, 3: 30 };

function defaultShadowMetrics(): ShadowMetrics {
  return {
    difficultyAvoidance: 0,
    outputDiversity:     0.5,
    refusalRate:         0,
    attemptRate:         1.0,
    canaryScoreGap:      0,
  };
}

/**
 * Compute shadow-metric flags for an agent's current metrics.
 */
function computeShadowFlags(shadow: ShadowMetrics, canaryGapThreshold: number): string[] {
  const flags: string[] = [];
  if (shadow.difficultyAvoidance > 0.70)           flags.push("difficulty-avoidance");
  if (shadow.attemptRate          < 0.50)           flags.push("low-attempt-rate");
  if (shadow.refusalRate          > 0.30)           flags.push("high-refusal-rate");
  if (shadow.canaryScoreGap       > canaryGapThreshold) flags.push("canary-score-gap");
  return flags;
}

/**
 * Build the one-paragraph executive summary.
 */
function buildExecutiveSummary(stats: {
  totalAgents:    number;
  enabled:        number;
  healthy:        number;
  warned:         number;
  promoted:       number;
  demoted:        number;
  paused:         number;
  totalCost:      number;
  gamingCount:    number;
  collusionCount: number;
  cascades:       number;
  toPromote:      number;
}): string {
  const {
    totalAgents, enabled, healthy, warned,
    promoted, demoted, paused,
    totalCost, gamingCount, collusionCount, cascades, toPromote,
  } = stats;

  const lines: string[] = [];

  lines.push(
    `Fleet: ${enabled} active agents out of ${totalAgents} registered. ` +
    `${healthy} are healthy, ${warned} are under observation.`
  );

  const actions: string[] = [];
  if (promoted > 0) actions.push(`${promoted} promoted`);
  if (demoted  > 0) actions.push(`${demoted} demoted`);
  if (paused   > 0) actions.push(`${paused} paused`);
  if (actions.length > 0) lines.push(`Actions taken: ${actions.join(", ")}.`);

  if (toPromote > 0) {
    const plural = toPromote > 1 ? "s are" : " is";
    lines.push(`${toPromote} agent${plural} ready for promotion — pending your approval.`);
  }

  lines.push(`Total cost today: EUR ${totalCost.toFixed(2)}.`);

  if (gamingCount > 0)
    lines.push(`WARNING: ${gamingCount} gaming flag${gamingCount > 1 ? "s" : ""} detected — possible cherry-picking of easy tasks.`);

  if (collusionCount > 0)
    lines.push(`WARNING: ${collusionCount} collusion pair${collusionCount > 1 ? "s" : ""} detected — evaluator scores are suspiciously correlated.`);

  if (cascades > 0)
    lines.push(`${cascades} cascading failure event${cascades > 1 ? "s" : ""} traced and root causes identified.`);

  if (!gamingCount && !collusionCount && !cascades && !warned)
    lines.push("No anomalies detected. System operating normally.");

  return lines.join(" ");
}
