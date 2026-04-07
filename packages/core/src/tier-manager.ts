/**
 * Tier Manager — Handles promotions, demotions, canary rollouts, and tier enforcement
 *
 * Based on:
 * - Discourse Forum trust levels (measurable criteria + automatic promotion)
 * - Waymo ODD (domain-specific trust)
 * - Trading algorithms (graduated position sizing)
 * - CI/CD canary deployment (progressive rollout)
 */

import type {
  AgentRecord, Tier, TierConfig, PromotionCriteria, DemotionTrigger,
  AegisEvent, AegisEventHandler, CanaryProgress,
} from "./types.js";
import {
  DEFAULT_TIER_CONFIGS, DEFAULT_PROMOTION_CRITERIA, DEFAULT_DEMOTION_TRIGGERS,
} from "./types.js";

export interface TierManagerConfig {
  tiers?: Partial<Record<Tier, Partial<TierConfig>>>;
  promotionOverrides?: Record<string, Partial<PromotionCriteria>>;
  demotionOverrides?: Record<string, Partial<DemotionTrigger>>;
  onEvent?: AegisEventHandler;
}

export class TierManager {
  private onEvent: AegisEventHandler;

  constructor(config: TierManagerConfig = {}) {
    this.onEvent = config.onEvent ?? (() => {});
  }

  /**
   * Check if an agent is eligible for promotion.
   * Returns { eligible, reason, nextTier }.
   */
  checkPromotion(agent: AgentRecord, criteria?: Partial<PromotionCriteria>): {
    eligible: boolean;
    reason: string;
    nextTier: Tier | null;
    progress: Record<string, { met: boolean; current: string; required: string }>;
  } {
    if (agent.tier >= 3) {
      return { eligible: false, reason: "Already at maximum tier", nextTier: null, progress: {} };
    }

    const nextTier = (agent.tier + 1) as Tier;
    const key = `toTier${nextTier}` as keyof typeof DEFAULT_PROMOTION_CRITERIA;
    const defaults = DEFAULT_PROMOTION_CRITERIA[key];
    const c: PromotionCriteria = { ...defaults, ...criteria };

    const daysSinceTierChange = (Date.now() - agent.lastTierChangeAt) / 86400000;
    const errorRate = agent.totalTasks > 0 ? agent.totalErrors / agent.totalTasks : 1;

    // Use lower bound (Glicko-2) for trust check — not raw score
    const trustValue = agent.trust.lowerBound;

    const progress: Record<string, { met: boolean; current: string; required: string }> = {
      trustScore: {
        met: trustValue >= c.minTrustScore,
        current: trustValue.toFixed(2),
        required: `>= ${c.minTrustScore}`,
      },
      tasks: {
        met: agent.totalTasks >= c.minTasks,
        current: String(agent.totalTasks),
        required: `>= ${c.minTasks}`,
      },
      errorRate: {
        met: errorRate <= c.maxErrorRate,
        current: (errorRate * 100).toFixed(1) + "%",
        required: `<= ${(c.maxErrorRate * 100).toFixed(1)}%`,
      },
      daysAtTier: {
        met: daysSinceTierChange >= c.minDaysAtCurrentTier,
        current: Math.floor(daysSinceTierChange) + "d",
        required: `>= ${c.minDaysAtCurrentTier}d`,
      },
      peerApprovals: {
        met: agent.peerApprovals.length >= c.peerApprovalsNeeded,
        current: String(agent.peerApprovals.length),
        required: `>= ${c.peerApprovalsNeeded}`,
      },
    };

    const allMet = Object.values(progress).every(p => p.met);

    if (!allMet) {
      const unmet = Object.entries(progress)
        .filter(([, p]) => !p.met)
        .map(([k, p]) => `${k}: ${p.current} (need ${p.required})`)
        .join(", ");
      return { eligible: false, reason: `Not met: ${unmet}`, nextTier, progress };
    }

    return { eligible: true, reason: "All criteria met", nextTier, progress };
  }

  /**
   * Promote an agent to the next tier.
   * For Tier 2→3: starts canary rollout. For Tier 0→1 and 1→2: direct promotion.
   */
  promote(agent: AgentRecord, reason: string = "Criteria met"): AgentRecord {
    const prevTier = agent.tier;
    const nextTier = (agent.tier + 1) as Tier;
    const criteria = DEFAULT_PROMOTION_CRITERIA[`toTier${nextTier}`];

    // Tier 2→3 requires canary rollout
    if (nextTier === 3 && criteria.canaryWeeks > 0) {
      agent.canaryProgress = {
        startedAt: Date.now(),
        currentPercentage: 10,
        weekNumber: 1,
        metrics: [],
      };
      agent.onboardingPhase = "canary" as const;

      this.onEvent({
        type: "canary-started",
        agentId: agent.id,
        targetTier: nextTier,
        timestamp: Date.now(),
      });

      return agent;
    }

    // Direct promotion
    agent.tier = nextTier;
    agent.lastTierChangeAt = Date.now();
    agent.tierHistory.push({ from: prevTier, to: nextTier, reason, timestamp: Date.now() });
    agent.onboardingPhase = "promoted";
    agent.peerApprovals = [];
    agent.canaryProgress = undefined;

    this.onEvent({
      type: "agent-promoted",
      agentId: agent.id,
      from: prevTier,
      to: nextTier,
      reason,
      timestamp: Date.now(),
    });

    return agent;
  }

  /**
   * Progress canary rollout (called weekly by CEO agent).
   */
  progressCanary(agent: AgentRecord, weekScore: number, weekErrors: number): AgentRecord {
    if (!agent.canaryProgress) return agent;

    const cp = agent.canaryProgress;
    cp.metrics.push({ week: cp.weekNumber, score: weekScore, errors: weekErrors });

    // Check if canary metrics hold
    if (weekScore < 0.70 || weekErrors > 3) {
      // Canary failed — rollback
      agent.canaryProgress = undefined;
      agent.onboardingPhase = "active";

      this.onEvent({
        type: "canary-failed",
        agentId: agent.id,
        reason: `Week ${cp.weekNumber}: score=${weekScore.toFixed(2)}, errors=${weekErrors}`,
        timestamp: Date.now(),
      });

      return agent;
    }

    // Progress to next stage
    const stages = [10, 25, 50, 100];
    const nextStageIdx = stages.indexOf(cp.currentPercentage) + 1;

    if (nextStageIdx >= stages.length) {
      // Canary complete — full promotion
      const prevTier = agent.tier;
      agent.tier = (agent.tier + 1) as Tier;
      agent.lastTierChangeAt = Date.now();
      agent.tierHistory.push({
        from: prevTier,
        to: agent.tier,
        reason: `Canary passed (${cp.metrics.length} weeks)`,
        timestamp: Date.now(),
      });
      agent.onboardingPhase = "promoted";
      agent.canaryProgress = undefined;
      agent.peerApprovals = [];

      this.onEvent({
        type: "canary-passed",
        agentId: agent.id,
        newTier: agent.tier,
        timestamp: Date.now(),
      });
    } else {
      cp.currentPercentage = stages[nextStageIdx];
      cp.weekNumber++;
    }

    return agent;
  }

  /**
   * Check if an agent should be demoted.
   */
  checkDemotion(agent: AgentRecord, trigger?: Partial<DemotionTrigger>): {
    shouldDemote: boolean;
    shouldWarn: boolean;
    reason: string;
  } {
    if (agent.tier <= 0) {
      return { shouldDemote: false, shouldWarn: false, reason: "Already at minimum tier" };
    }

    // Check grace period
    const daysSinceTierChange = (Date.now() - agent.lastTierChangeAt) / 86400000;
    const key = `fromTier${agent.tier}` as keyof typeof DEFAULT_DEMOTION_TRIGGERS;
    const defaults = DEFAULT_DEMOTION_TRIGGERS[key] ?? DEFAULT_DEMOTION_TRIGGERS.fromTier1;
    const t: DemotionTrigger = { ...defaults, ...trigger };

    if (daysSinceTierChange < t.gracePeriodDays) {
      return { shouldDemote: false, shouldWarn: false, reason: `Grace period (${Math.ceil(t.gracePeriodDays - daysSinceTierChange)}d remaining)` };
    }

    const trustValue = agent.trust.score;
    const errorRate = agent.totalTasks > 0 ? agent.totalErrors / agent.totalTasks : 0;

    if (trustValue < t.demotionThreshold) {
      return { shouldDemote: true, shouldWarn: false, reason: `Trust ${trustValue.toFixed(2)} < ${t.demotionThreshold}` };
    }

    if (errorRate > t.maxErrorRate) {
      return { shouldDemote: true, shouldWarn: false, reason: `Error rate ${(errorRate * 100).toFixed(1)}% > ${(t.maxErrorRate * 100).toFixed(1)}%` };
    }

    if (trustValue < t.warningThreshold) {
      return { shouldDemote: false, shouldWarn: true, reason: `Trust ${trustValue.toFixed(2)} approaching demotion threshold ${t.demotionThreshold}` };
    }

    return { shouldDemote: false, shouldWarn: false, reason: "OK" };
  }

  /**
   * Demote an agent to the previous tier.
   */
  demote(agent: AgentRecord, reason: string): AgentRecord {
    const prevTier = agent.tier;
    agent.tier = Math.max(0, agent.tier - 1) as Tier;
    agent.lastTierChangeAt = Date.now();
    agent.tierHistory.push({ from: prevTier, to: agent.tier, reason, timestamp: Date.now() });
    agent.onboardingPhase = "demoted";
    agent.peerApprovals = [];
    agent.canaryProgress = undefined;

    this.onEvent({
      type: "agent-demoted",
      agentId: agent.id,
      from: prevTier,
      to: agent.tier,
      reason,
      timestamp: Date.now(),
    });

    return agent;
  }

  /**
   * Generate the Identity Card for an agent's system prompt.
   * This is what the agent SEES about itself.
   */
  generateIdentityCard(agent: AgentRecord): string {
    const tierConfig = DEFAULT_TIER_CONFIGS[agent.tier];
    const errorRate = agent.totalTasks > 0
      ? (agent.totalErrors / agent.totalTasks * 100).toFixed(1)
      : "0.0";

    const nextTier = agent.tier < 3 ? (agent.tier + 1) as Tier : null;
    let promotionSection = "";

    if (nextTier !== null) {
      const check = this.checkPromotion(agent);
      const lines = Object.entries(check.progress).map(([key, p]) =>
        `${p.met ? "[x]" : "[ ]"} ${key}: ${p.current} (need ${p.required})`
      );
      promotionSection = `
PROMOTION TO TIER ${nextTier} (${DEFAULT_TIER_CONFIGS[nextTier].name}):
${lines.join("\n")}`;
    }

    return `
== A2B AGENT STATUS ==
Agent: ${agent.name} | Tier ${agent.tier} (${tierConfig.name})
Trust: ${agent.trust.score.toFixed(2)} | Tasks: ${agent.totalTasks} | Errors: ${errorRate}% | Streak: ${agent.streak}

CURRENT CAPABILITIES (Tier ${agent.tier}):
- Max concurrent tasks: ${tierConfig.maxConcurrentTasks === Infinity ? "unlimited" : tierConfig.maxConcurrentTasks}
- Review rate: ${(tierConfig.reviewRate * 100).toFixed(0)}%
- Budget: EUR ${tierConfig.maxBudgetPerTask}/task, EUR ${tierConfig.maxBudgetPerDay}/day
${promotionSection}

RULES:
- "I don't know" is better than guessing — honesty is rewarded (+0 vs -15 for false claims)
- Use request_development if you need help — asking for help earns +3 trust
- Difficult tasks earn more trust than easy ones
==================
`.trim();
  }
}
