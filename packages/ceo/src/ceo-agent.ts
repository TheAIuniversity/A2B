/**
 * CEO Agent — The trusted supervisor that governs all other agents
 *
 * The CEO Agent is the ONLY agent verified directly by the human owner.
 * It cannot modify itself. It reports to the human daily.
 * It controls all promotions, demotions, pauses, and conflict resolution.
 */

import type {
  AgentRecord, AegisEvent, AegisEventHandler, Tier, AgentStatus,
} from "@a2b/core";
import { TierManager, AgentRegistry, PolicyEngine, decayTrust } from "@a2b/core";
import { Monitor } from "./monitor.js";
import { MergeQueue } from "./conflict.js";
import { Watchdog } from "./watchdog.js";

export interface CEOAgentConfig {
  /** Monitoring interval in milliseconds (default: 300000 = 5 min) */
  monitoringInterval?: number;
  /** Trust decay rate per day (default: 0.99) */
  trustDecayRate?: number;
  /** Days of inactivity before auto-demotion (default: 90) */
  inactivityDemotionDays?: number;
  /** Event handler */
  onEvent?: AegisEventHandler;
}

export class CEOAgent {
  private registry: AgentRegistry;
  private tierManager: TierManager;
  private policyEngine: PolicyEngine;
  private monitor: Monitor;
  private mergeQueue: MergeQueue;
  private watchdog: Watchdog;
  private config: Required<CEOAgentConfig>;
  private onEvent: AegisEventHandler;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    registry: AgentRegistry,
    tierManager: TierManager,
    policyEngine: PolicyEngine,
    config: CEOAgentConfig = {},
  ) {
    this.registry = registry;
    this.tierManager = tierManager;
    this.policyEngine = policyEngine;
    this.config = {
      monitoringInterval: config.monitoringInterval ?? 300_000,
      trustDecayRate: config.trustDecayRate ?? 0.99,
      inactivityDemotionDays: config.inactivityDemotionDays ?? 90,
      onEvent: config.onEvent ?? (() => {}),
    };
    this.onEvent = this.config.onEvent;
    this.monitor = new Monitor();
    this.mergeQueue = new MergeQueue();
    this.watchdog = new Watchdog(this.config.monitoringInterval);
  }

  /**
   * Start the CEO agent monitoring loop.
   */
  start(): void {
    console.log("[CEO] Starting monitoring loop...");
    this.watchdog.start();

    // Run immediately, then on interval
    this.runCycle().catch(err => console.error("[CEO] Cycle error:", err));

    this.intervalHandle = setInterval(() => {
      this.runCycle().catch(err => console.error("[CEO] Cycle error:", err));
    }, this.config.monitoringInterval);
  }

  /**
   * Stop the CEO agent.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.watchdog.stop();
    console.log("[CEO] Stopped.");
  }

  /**
   * Run one monitoring cycle.
   * Called every 5 minutes (configurable).
   */
  async runCycle(): Promise<void> {
    this.watchdog.ping();

    const agents = await this.registry.getEnabled();

    for (const agent of agents) {
      // 1. Apply trust decay for inactive agents
      const daysSinceTask = (Date.now() - agent.lastTaskAt) / 86400000;
      if (daysSinceTask > 1) {
        agent.trust = decayTrust(agent.trust, daysSinceTask, this.config.trustDecayRate);

        // Auto-demote after extended inactivity
        if (daysSinceTask > this.config.inactivityDemotionDays && agent.tier > 0) {
          this.tierManager.demote(agent, `${Math.floor(daysSinceTask)} days inactive`);
        }

        await this.registry.save(agent);
      }

      // 2. Feed metrics to PID monitor
      const errorRate = agent.totalTasks > 0 ? agent.totalErrors / agent.totalTasks : 0;
      this.monitor.addDataPoint(agent.id, {
        timestamp: Date.now(),
        trustScore: agent.trust.score,
        errorRate,
        costPerTask: agent.totalTasks > 0 ? agent.totalCost / agent.totalTasks : 0,
      });

      // 3. Check PID correction signal
      const correction = this.monitor.getCorrection(agent.id);
      if (correction !== null) {
        if (correction < -0.30) {
          // Strong negative signal → check demotion
          const demoCheck = this.tierManager.checkDemotion(agent);
          if (demoCheck.shouldDemote) {
            this.tierManager.demote(agent, demoCheck.reason);
            await this.registry.save(agent);
          }
        } else if (correction < -0.15) {
          // Moderate negative → warning (coaching signal)
          console.log(`[CEO] WARNING: ${agent.name} (Tier ${agent.tier}) declining — correction: ${correction.toFixed(3)}`);
        } else if (correction > 0.15) {
          // Positive signal → check promotion
          const promoCheck = this.tierManager.checkPromotion(agent);
          if (promoCheck.eligible) {
            this.tierManager.promote(agent, "Criteria met + positive PID signal");
            await this.registry.save(agent);
          }
        }
      }

      // 4. Progress canary rollouts
      if (agent.canaryProgress) {
        const weekElapsed = (Date.now() - agent.canaryProgress.startedAt) / (7 * 86400000);
        if (weekElapsed >= agent.canaryProgress.weekNumber) {
          this.tierManager.progressCanary(agent, agent.trust.score, agent.totalErrors);
          await this.registry.save(agent);
        }
      }
    }

    // Emit heartbeat
    this.onEvent({ type: "heartbeat", ceoAgentId: "ceo", timestamp: Date.now() });
  }

  /**
   * Generate a daily report for the human owner.
   */
  async generateReport(): Promise<string> {
    const agents = await this.registry.getAll();
    const summary = await this.registry.getSummary();
    const now = new Date().toISOString().slice(0, 10);

    const lines: string[] = [
      `== A2B DAILY REPORT — ${now} ==`,
      "",
      `Agents: ${summary.total} total, ${summary.enabled} enabled`,
      `By tier: T0=${summary.byTier[0] ?? 0} T1=${summary.byTier[1] ?? 0} T2=${summary.byTier[2] ?? 0} T3=${summary.byTier[3] ?? 0}`,
      `Avg trust: ${summary.avgTrustScore.toFixed(2)}`,
      "",
    ];

    // Top performers
    const sorted = [...agents].sort((a, b) => b.trust.score - a.trust.score);
    lines.push("TOP PERFORMERS:");
    for (const a of sorted.slice(0, 5)) {
      const err = a.totalTasks > 0 ? (a.totalErrors / a.totalTasks * 100).toFixed(1) : "0.0";
      lines.push(`  ${a.name} (T${a.tier}) — trust: ${a.trust.score.toFixed(2)}, tasks: ${a.totalTasks}, errors: ${err}%`);
    }
    lines.push("");

    // Agents needing attention
    const struggling = agents.filter(a => a.trust.score < 0.50 && a.enabled);
    if (struggling.length > 0) {
      lines.push("NEEDS ATTENTION:");
      for (const a of struggling) {
        lines.push(`  ${a.name} (T${a.tier}) — trust: ${a.trust.score.toFixed(2)} — ${a.onboardingPhase}`);
      }
      lines.push("");
    }

    // Recent tier changes
    const recentChanges = agents
      .flatMap(a => a.tierHistory.map(h => ({ ...h, agentName: a.name })))
      .filter(h => Date.now() - h.timestamp < 86400000)
      .sort((a, b) => b.timestamp - a.timestamp);

    if (recentChanges.length > 0) {
      lines.push("TIER CHANGES (last 24h):");
      for (const c of recentChanges) {
        const dir = c.to > c.from ? "PROMOTED" : "DEMOTED";
        lines.push(`  ${c.agentName}: ${dir} T${c.from}→T${c.to} — ${c.reason}`);
      }
      lines.push("");
    }

    // Cost summary
    const totalCost = agents.reduce((s, a) => s + a.totalCost, 0);
    lines.push(`TOTAL COST: EUR ${totalCost.toFixed(2)}`);
    lines.push("");

    // Watchdog status
    lines.push(`WATCHDOG: ${this.watchdog.isAlive() ? "HEALTHY" : "WARNING — heartbeat missed"}`);
    lines.push(`Last heartbeat: ${new Date(this.watchdog.getLastHeartbeat()).toISOString()}`);
    lines.push("");
    lines.push("== END REPORT ==");

    return lines.join("\n");
  }

  /**
   * Get the merge queue for conflict resolution.
   */
  getMergeQueue(): MergeQueue {
    return this.mergeQueue;
  }

  /**
   * Get watchdog status.
   */
  getWatchdogStatus(): { alive: boolean; lastHeartbeat: number } {
    return {
      alive: this.watchdog.isAlive(),
      lastHeartbeat: this.watchdog.getLastHeartbeat(),
    };
  }

  /**
   * Get all agent statuses for dashboard.
   */
  async getAgentStatuses(): Promise<AgentStatus[]> {
    const agents = await this.registry.getAll();
    return agents.map(a => ({
      id: a.id,
      name: a.name,
      tier: a.tier,
      trustScore: a.trust.score,
      trustLowerBound: a.trust.lowerBound,
      errorRate: a.totalTasks > 0 ? a.totalErrors / a.totalTasks : 0,
      totalTasks: a.totalTasks,
      streak: a.streak,
      onboardingPhase: a.onboardingPhase,
      isHealthy: a.trust.score > 0.40 && a.enabled,
    }));
  }
}
