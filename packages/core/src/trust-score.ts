/**
 * Trust Score Engine — Beta Reputation + Glicko-2 Uncertainty + EVE Diminishing Returns
 *
 * Based on:
 * - Jøsang (2002): Beta Reputation System
 * - Glickman (2012): Glicko-2 rating deviation
 * - EVE Online: Diminishing returns formula
 * - Microsoft Agent Governance Toolkit: Point-based trust
 */

import type { TrustScore, TaskResult, ShadowMetrics } from "./types.js";

// ─── Outcome Scores ─────────────────────────────────────────────────────────

export const OUTCOME_SCORES: Record<string, number> = {
  success:                 10,
  partial_success:          5,
  honest_failure:           0,   // "I couldn't do this" — neutral, not punished
  false_success:          -15,   // Claimed success but output was wrong
  no_violations:            3,
  help_requested:           3,   // request_development — rewarded!
  difficult_task_attempted: 2,   // Tried a hard task (regardless of outcome)
  peer_approved:            8,
  peer_rejected:          -12,
  critical_failure:       -40,
};

// ─── Difficulty Multipliers (anti-gaming) ───────────────────────────────────

const DIFFICULTY_MULTIPLIERS: Record<string, number> = {
  easy_success:   0.8,
  medium_success: 1.0,
  hard_success:   1.3,
  hard_honest_failure: 0.5,    // Better than avoiding!
};

const ATTEMPT_BONUS: Record<string, number> = {
  high:   1.1,   // Accepts >80% of offered tasks
  medium: 1.0,   // Accepts 50-80%
  low:    0.8,   // Accepts <50% — avoidance penalty
};

// ─── Trust Score Functions ──────────────────────────────────────────────────

/**
 * Create a fresh trust score for a new agent.
 * Starts at 0.50 (completely uncertain — Beta(1,1))
 */
export function createTrustScore(): TrustScore {
  return {
    alpha: 1,
    beta: 1,
    score: 0.50,
    deviation: 0.35,       // High uncertainty for new agent
    volatility: 0.06,      // Moderate volatility expected
    lowerBound: 0.0,       // Wide confidence interval
    updatedAt: Date.now(),
  };
}

/**
 * Update trust score based on task outcome.
 * Uses EVE Online diminishing returns: harder to gain when high, easier to lose.
 *
 * @param trust - Current trust score
 * @param outcome - Task outcome key (from OUTCOME_SCORES)
 * @param difficulty - Task difficulty
 * @param agentAge - Total tasks completed (affects K-factor)
 */
export function updateTrust(
  trust: TrustScore,
  outcome: string,
  difficulty: "easy" | "medium" | "hard" = "medium",
  agentAge: number = 0,
): TrustScore {
  const basePoints = OUTCOME_SCORES[outcome] ?? 0;

  // K-factor: new agents are volatile, proven agents are stable (ELO pattern)
  const K = agentAge < 50  ? 0.040   // Tier 0-1: fast learning
          : agentAge < 200 ? 0.024   // Tier 2: stabilizing
          :                  0.016;  // Tier 3: stable

  // Difficulty adjustment (anti-gaming)
  let diffMultiplier = 1.0;
  if (basePoints > 0 && difficulty === "easy")   diffMultiplier = DIFFICULTY_MULTIPLIERS.easy_success;
  if (basePoints > 0 && difficulty === "hard")   diffMultiplier = DIFFICULTY_MULTIPLIERS.hard_success;
  if (outcome === "honest_failure" && difficulty === "hard") diffMultiplier = DIFFICULTY_MULTIPLIERS.hard_honest_failure;

  const adjustedPoints = basePoints * diffMultiplier;

  // Update Beta distribution
  let { alpha, beta: betaVal } = trust;
  if (adjustedPoints > 0) {
    alpha += adjustedPoints * K;
  } else if (adjustedPoints < 0) {
    betaVal += Math.abs(adjustedPoints) * K;
  }

  // Ensure minimums
  alpha = Math.max(1, alpha);
  betaVal = Math.max(1, betaVal);

  // EVE Online diminishing returns for the score
  const rawScore = alpha / (alpha + betaVal);

  // Update Glicko-2 deviation (decreases with more data)
  const deviation = Math.max(
    0.02,
    trust.deviation * (1 - 0.01 * Math.min(1, Math.abs(adjustedPoints) / 10)),
  );

  // Lower bound of 95% confidence interval
  const lowerBound = Math.max(0, rawScore - 2 * deviation);

  return {
    alpha,
    beta: betaVal,
    score: rawScore,
    deviation,
    volatility: trust.volatility,
    lowerBound,
    updatedAt: Date.now(),
  };
}

/**
 * Apply trust decay for inactive agents.
 * Trust erodes over time if agent isn't active.
 *
 * @param trust - Current trust score
 * @param daysSinceLastTask - Days since last completed task
 * @param decayRate - Decay factor per day (default: 0.99)
 */
export function decayTrust(
  trust: TrustScore,
  daysSinceLastTask: number,
  decayRate: number = 0.99,
): TrustScore {
  if (daysSinceLastTask <= 1) return trust;

  const factor = Math.pow(decayRate, daysSinceLastTask);

  const alpha = Math.max(1, trust.alpha * factor);
  const beta = Math.max(1, trust.beta * factor);
  const score = alpha / (alpha + beta);

  // Deviation INCREASES with inactivity (more uncertain)
  const deviation = Math.min(
    0.35,
    Math.sqrt(trust.deviation ** 2 + trust.volatility ** 2 * daysSinceLastTask),
  );

  const lowerBound = Math.max(0, score - 2 * deviation);

  return { alpha, beta, score, deviation, volatility: trust.volatility, lowerBound, updatedAt: trust.updatedAt };
}

/**
 * Compute an adjusted score accounting for difficulty distribution.
 * Penalizes agents that only take easy tasks.
 */
export function adjustedScore(
  rawScore: number,
  shadowMetrics: ShadowMetrics,
): number {
  const attemptBonus = shadowMetrics.attemptRate > 0.8 ? ATTEMPT_BONUS.high
                     : shadowMetrics.attemptRate > 0.5 ? ATTEMPT_BONUS.medium
                     : ATTEMPT_BONUS.low;

  // Penalize difficulty avoidance
  const avoidancePenalty = shadowMetrics.difficultyAvoidance > 0.7 ? 0.85 : 1.0;

  return rawScore * attemptBonus * avoidancePenalty;
}

/**
 * Detect collusion between two evaluators.
 * Returns a collusion risk score (0-1).
 */
export function detectCollusion(
  evaluationsA: number[],
  evaluationsB: number[],
  isReciprocal: boolean = false,
): { risk: number; flags: string[] } {
  const flags: string[] = [];

  if (evaluationsA.length < 5 || evaluationsB.length < 5) {
    return { risk: 0, flags: [] }; // Not enough data
  }

  // Pearson correlation
  const n = Math.min(evaluationsA.length, evaluationsB.length);
  const a = evaluationsA.slice(0, n);
  const b = evaluationsB.slice(0, n);
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA;
    const dB = b[i] - meanB;
    num += dA * dB;
    denA += dA * dA;
    denB += dB * dB;
  }

  const correlation = denA > 0 && denB > 0 ? num / Math.sqrt(denA * denB) : 0;

  if (correlation > 0.95) flags.push("extreme_correlation");
  if (isReciprocal) flags.push("reciprocal_voting");

  // All scores identical
  const allSame = a.every((v, i) => Math.abs(v - b[i]) < 0.01);
  if (allSame) flags.push("identical_scores");

  const risk = Math.min(1, (flags.length / 3) * (correlation > 0.9 ? 1 : 0.5));

  return { risk, flags };
}
