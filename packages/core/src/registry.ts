/**
 * Agent Registry — In-memory store with optional persistence adapter
 *
 * Holds all agent records with trust scores, tier info, and history.
 * Users can provide a StorageAdapter for persistent storage (file, DB, etc.)
 */

import type {
  AgentRecord, AegisAgent, Tier, TrustScore, StorageAdapter,
  OnboardingPhase, ShadowMetrics,
} from "./types.js";
import { createTrustScore } from "./trust-score.js";

export class AgentRegistry {
  private agents: Map<string, AgentRecord> = new Map();
  private storage: StorageAdapter | null;

  constructor(storage?: StorageAdapter) {
    this.storage = storage ?? null;
  }

  /**
   * Register a new agent. Always starts at Tier 0.
   */
  async register(agent: AegisAgent, buddyId?: string): Promise<AgentRecord> {
    const record: AgentRecord = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      tier: 0,
      enabled: false,
      trust: createTrustScore(),
      totalTasks: 0,
      totalErrors: 0,
      totalCost: 0,
      streak: 0,
      lastTaskAt: 0,
      registeredAt: Date.now(),
      lastTierChangeAt: Date.now(),
      tierHistory: [],
      onboardingPhase: "registered",
      buddyAgentId: buddyId,
      peerApprovals: [],
      shadowMetrics: {
        difficultyAvoidance: 0,
        outputDiversity: 0,
        refusalRate: 0,
        attemptRate: 1.0,
        canaryScoreGap: 0,
      },
    };

    this.agents.set(agent.id, record);
    if (this.storage) await this.storage.saveAgent(record);

    return record;
  }

  /**
   * Get an agent record by ID.
   */
  async get(id: string): Promise<AgentRecord | null> {
    if (this.agents.has(id)) return this.agents.get(id)!;
    if (this.storage) {
      const stored = await this.storage.getAgent(id);
      if (stored) this.agents.set(id, stored);
      return stored;
    }
    return null;
  }

  /**
   * Update an agent record.
   */
  async save(record: AgentRecord): Promise<void> {
    this.agents.set(record.id, record);
    if (this.storage) await this.storage.saveAgent(record);
  }

  /**
   * Get all registered agents.
   */
  async getAll(): Promise<AgentRecord[]> {
    if (this.storage) {
      const all = await this.storage.getAllAgents();
      for (const a of all) this.agents.set(a.id, a);
      return all;
    }
    return Array.from(this.agents.values());
  }

  /**
   * Get agents by tier.
   */
  async getByTier(tier: Tier): Promise<AgentRecord[]> {
    const all = await this.getAll();
    return all.filter(a => a.tier === tier);
  }

  /**
   * Get agents by type.
   */
  async getByType(type: string): Promise<AgentRecord[]> {
    const all = await this.getAll();
    return all.filter(a => a.type === type);
  }

  /**
   * Get enabled agents only.
   */
  async getEnabled(): Promise<AgentRecord[]> {
    const all = await this.getAll();
    return all.filter(a => a.enabled);
  }

  /**
   * Record a task completion and update trust/stats.
   */
  async recordTask(
    agentId: string,
    success: boolean,
    cost: number = 0,
    isCriticalFailure: boolean = false,
    isHonestFailure: boolean = false,
  ): Promise<AgentRecord | null> {
    const agent = await this.get(agentId);
    if (!agent) return null;

    agent.totalTasks++;
    agent.totalCost += cost;
    agent.lastTaskAt = Date.now();

    if (success) {
      agent.streak++;
    } else {
      agent.totalErrors++;
      agent.streak = 0;
    }

    await this.save(agent);
    return agent;
  }

  /**
   * Get summary statistics for all agents.
   */
  async getSummary(): Promise<{
    total: number;
    byTier: Record<number, number>;
    byType: Record<string, number>;
    enabled: number;
    avgTrustScore: number;
  }> {
    const all = await this.getAll();
    const byTier: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const byType: Record<string, number> = {};
    let trustSum = 0;
    let enabled = 0;

    for (const a of all) {
      byTier[a.tier] = (byTier[a.tier] ?? 0) + 1;
      byType[a.type] = (byType[a.type] ?? 0) + 1;
      trustSum += a.trust.score;
      if (a.enabled) enabled++;
    }

    return {
      total: all.length,
      byTier,
      byType,
      enabled,
      avgTrustScore: all.length > 0 ? trustSum / all.length : 0,
    };
  }
}
