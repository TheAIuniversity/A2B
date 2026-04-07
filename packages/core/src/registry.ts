/**
 * Agent Registry — In-memory store with optional persistence adapter
 *
 * SECURITY:
 * - Agent IDs are validated against /^[a-zA-Z0-9_-]{1,64}$/ (prevents path traversal)
 * - get() returns DEEP COPIES (prevents privilege escalation via reference mutation)
 * - save() validates tier transitions (can only change by +/-1)
 * - All writes go through validated methods
 */

import type {
  AgentRecord, AegisAgent, Tier, StorageAdapter,
} from "./types.js";
import { createTrustScore } from "./trust-score.js";
import { validateAgentId } from "./policy-engine.js";

/**
 * Deep-clone an AgentRecord. Prevents callers from mutating
 * the registry's internal state via shared references.
 * (Audit fix C-2)
 */
function deepClone(record: AgentRecord): AgentRecord {
  return JSON.parse(JSON.stringify(record));
}

export class AgentRegistry {
  private agents: Map<string, AgentRecord> = new Map();
  private storage: StorageAdapter | null;

  constructor(storage?: StorageAdapter) {
    this.storage = storage ?? null;
  }

  /**
   * Register a new agent. Always starts at Tier 0.
   * Validates agent ID to prevent path traversal attacks.
   * (Audit fix C-3)
   */
  async register(agent: AegisAgent, buddyId?: string): Promise<AgentRecord> {
    // Validate agent ID — prevents path traversal in FileStorage
    validateAgentId(agent.id);
    if (buddyId) validateAgentId(buddyId);

    // Check for duplicate
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent "${agent.id}" is already registered.`);
    }

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

    // Return a deep copy — caller cannot mutate internal state
    return deepClone(record);
  }

  /**
   * Get an agent record by ID.
   * Returns a DEEP COPY — callers cannot mutate the registry's state.
   * (Audit fix C-2: prevents privilege escalation via reference mutation)
   */
  async get(id: string): Promise<AgentRecord | null> {
    if (this.agents.has(id)) return deepClone(this.agents.get(id)!);
    if (this.storage) {
      const stored = await this.storage.getAgent(id);
      if (stored) {
        this.agents.set(id, stored);
        return deepClone(stored);
      }
    }
    return null;
  }

  /**
   * Update an agent record.
   * Validates the update before persisting:
   * - Tier can only change by +/-1 (prevents jumps from Tier 0 to Tier 3)
   * - Trust scores must be within valid range
   */
  async save(record: AgentRecord): Promise<void> {
    const existing = this.agents.get(record.id);

    // Validate tier transition
    if (existing) {
      const tierDiff = Math.abs(record.tier - existing.tier);
      if (tierDiff > 1) {
        throw new Error(
          `Invalid tier transition: ${existing.tier} → ${record.tier}. ` +
          `Tier can only change by +/- 1.`
        );
      }
    }

    // Validate trust score range
    if (record.trust.score < 0 || record.trust.score > 1) {
      throw new Error(`Invalid trust score: ${record.trust.score}. Must be 0-1.`);
    }

    // Store a deep copy — prevents future mutations via the passed reference
    this.agents.set(record.id, deepClone(record));
    if (this.storage) await this.storage.saveAgent(deepClone(record));
  }

  /**
   * Get all registered agents (deep copies).
   */
  async getAll(): Promise<AgentRecord[]> {
    if (this.storage) {
      const all = await this.storage.getAllAgents();
      for (const a of all) this.agents.set(a.id, a);
      return all.map(deepClone);
    }
    return Array.from(this.agents.values()).map(deepClone);
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
   * Returns a deep copy of the updated record.
   */
  async recordTask(
    agentId: string,
    success: boolean,
    cost: number = 0,
  ): Promise<AgentRecord | null> {
    const internal = this.agents.get(agentId);
    if (!internal) return null;

    internal.totalTasks++;
    internal.totalCost += cost;
    internal.lastTaskAt = Date.now();

    if (success) {
      internal.streak++;
    } else {
      internal.totalErrors++;
      internal.streak = 0;
    }

    if (this.storage) await this.storage.saveAgent(deepClone(internal));
    return deepClone(internal);
  }

  /**
   * Check if an agent exists.
   */
  async exists(id: string): Promise<boolean> {
    return this.agents.has(id) || (await this.storage?.getAgent(id)) !== null;
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
