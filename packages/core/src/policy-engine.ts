/**
 * Policy Engine — 3-Gate enforcement for agent actions
 *
 * Gate 1: Tool Registry — PolicyEngine OWNS the tool whitelist and computes
 *         allowed tools internally. Callers cannot inject arbitrary tool lists.
 * Gate 2: Runtime Policy — Every tool call is checked BEFORE execution.
 *         Code-level enforcement, not prompt-based.
 * Gate 3: Audit Log — Immutable, frozen entries with crypto-random IDs.
 *
 * SECURITY MODEL:
 * The PolicyEngine is the SINGLE SOURCE OF TRUTH for what an agent can do.
 * It does NOT accept tool lists from callers. It computes them from the
 * agent's tier and type. This prevents privilege escalation via misconfigured
 * callers.
 */

import { randomUUID } from "crypto";
import type { AgentRecord, Tier, AuditEntry, AegisEvent, AegisEventHandler, StorageAdapter } from "./types.js";
import { DEFAULT_TIER_CONFIGS } from "./types.js";

// ─── Agent ID validation ────────────────────────────────────────────────────

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate an agent ID. Throws if invalid.
 * Prevents path traversal (../../etc/passwd) and injection attacks.
 */
export function validateAgentId(id: string): void {
  if (!AGENT_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid agent ID "${id}". Must match /^[a-zA-Z0-9_-]{1,64}$/. ` +
      `No dots, slashes, or special characters allowed.`
    );
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  suggestion?: string;
}

export interface PolicyEngineConfig {
  /** Global blocked patterns (apply to ALL agents regardless of tier) */
  blockedPatterns?: string[];
  /**
   * Tool whitelist per agent type + tier.
   * This is the CANONICAL source of truth for tool access.
   * If a tool is not in the whitelist for an agent's type+tier, it is BLOCKED.
   */
  toolWhitelist: Record<string, Partial<Record<Tier, string[]>>>;
  /** Optional storage adapter for persistent audit log */
  storage?: StorageAdapter;
  onEvent?: AegisEventHandler;
}

export class PolicyEngine {
  private blockedPatterns: string[];
  private toolWhitelist: Record<string, Partial<Record<Tier, string[]>>>;
  private activeTasks: Map<string, number> = new Map();
  private dailyCosts: Map<string, number> = new Map();
  private lastResetDate: string = new Date().toISOString().slice(0, 10);
  private onEvent: AegisEventHandler;
  private storage: StorageAdapter | null;

  constructor(config: PolicyEngineConfig) {
    this.blockedPatterns = config.blockedPatterns ?? [
      "rm -rf", "DROP TABLE", "DELETE FROM", "FORMAT",
    ];
    this.toolWhitelist = config.toolWhitelist;
    this.onEvent = config.onEvent ?? (() => {});
    this.storage = config.storage ?? null;
  }

  /**
   * Gate 1: Get the list of tools an agent is allowed to use.
   * Computed INTERNALLY from the agent's type and tier.
   * The caller does NOT provide the tool list — the PolicyEngine owns it.
   */
  getAllowedTools(agentType: string, tier: Tier): string[] {
    const typeWhitelist = this.toolWhitelist[agentType];
    if (!typeWhitelist) return []; // Unknown type → no tools (safe default)

    // Accumulate tools from tier 0 up to current tier
    // Higher tiers inherit lower tier tools
    const tools = new Set<string>();
    for (let t = 0; t <= tier; t++) {
      const tierTools = typeWhitelist[t as Tier];
      if (tierTools) {
        for (const tool of tierTools) tools.add(tool);
      }
    }
    return Array.from(tools);
  }

  /**
   * Gate 1: Get tools that should be BLOCKED for this agent.
   * Requires knowing ALL possible tools for this agent type.
   */
  getDisallowedTools(agentType: string, tier: Tier): string[] {
    const allowed = new Set(this.getAllowedTools(agentType, tier));
    // Get ALL tools across ALL tiers for this type
    const allTools = new Set<string>();
    const typeWhitelist = this.toolWhitelist[agentType];
    if (typeWhitelist) {
      for (const tierTools of Object.values(typeWhitelist)) {
        if (tierTools) for (const tool of tierTools) allTools.add(tool);
      }
    }
    return Array.from(allTools).filter(t => !allowed.has(t));
  }

  /**
   * Gate 2: Runtime policy check BEFORE tool execution.
   * The PolicyEngine computes allowed tools INTERNALLY — the caller
   * only provides the agent record and the tool name.
   *
   * This is the fix for audit finding C-1: callers can no longer
   * bypass enforcement by passing arbitrary tool lists.
   */
  evaluateAction(agent: AgentRecord, toolName: string): PolicyDecision {
    this.checkDayRollover();

    // Check 1: Tool access — computed from INTERNAL whitelist
    const allowedTools = this.getAllowedTools(agent.type, agent.tier);
    if (!allowedTools.includes(toolName)) {
      const tierNeeded = this.findTierForTool(agent.type, toolName);
      const decision: PolicyDecision = {
        allowed: false,
        reason: `Tool "${toolName}" requires Tier ${tierNeeded ?? "?"}. You are Tier ${agent.tier}.`,
        suggestion: tierNeeded !== null
          ? `Earn promotion to Tier ${tierNeeded} to unlock this tool. Use request_development if you need help.`
          : `Tool "${toolName}" is not registered for agent type "${agent.type}".`,
      };

      this.onEvent({
        type: "policy-denied",
        agentId: agent.id,
        toolName,
        reason: decision.reason,
        timestamp: Date.now(),
      });

      return decision;
    }

    // Check 2: Blocked patterns
    for (const pattern of this.blockedPatterns) {
      if (toolName.toLowerCase().includes(pattern.toLowerCase())) {
        return { allowed: false, reason: `Tool "${toolName}" matches blocked pattern "${pattern}".` };
      }
    }

    // Check 3: Concurrent task limit
    const tierConfig = DEFAULT_TIER_CONFIGS[agent.tier];
    const activeCount = this.activeTasks.get(agent.id) ?? 0;
    if (activeCount >= tierConfig.maxConcurrentTasks) {
      return {
        allowed: false,
        reason: `Max concurrent tasks reached (${activeCount}/${tierConfig.maxConcurrentTasks} for Tier ${agent.tier}).`,
      };
    }

    // Check 4: Budget limit
    const dailyCost = this.dailyCosts.get(agent.id) ?? 0;
    if (dailyCost >= tierConfig.maxBudgetPerDay) {
      return {
        allowed: false,
        reason: `Daily budget exhausted (EUR ${dailyCost.toFixed(2)}/${tierConfig.maxBudgetPerDay.toFixed(2)} for Tier ${agent.tier}).`,
      };
    }

    return { allowed: true, reason: "OK" };
  }

  /**
   * Atomic check-and-start: evaluates policy AND starts the task in one call.
   * Prevents the TOCTOU race condition (audit finding H-6).
   */
  evaluateAndStart(agent: AgentRecord, toolName: string): PolicyDecision {
    const decision = this.evaluateAction(agent, toolName);
    if (decision.allowed) {
      this.startTask(agent.id);
    }
    return decision;
  }

  /**
   * Gate 3: Record an action in the audit log.
   * Entries are frozen (immutable) with crypto-random IDs.
   */
  recordAction(entry: Omit<AuditEntry, "id">): AuditEntry {
    const fullEntry: AuditEntry = Object.freeze({
      id: randomUUID(),
      ...entry,
    });

    // Write to persistent storage if available
    if (this.storage) {
      this.storage.appendAudit(fullEntry).catch(() => {});
    }

    // Track costs
    if (entry.cost) {
      const current = this.dailyCosts.get(entry.agentId) ?? 0;
      this.dailyCosts.set(entry.agentId, current + entry.cost);
    }

    return fullEntry;
  }

  /**
   * End a task (decrement concurrent count).
   */
  endTask(agentId: string): void {
    const current = this.activeTasks.get(agentId) ?? 0;
    this.activeTasks.set(agentId, Math.max(0, current - 1));
  }

  /**
   * Get audit log from persistent storage.
   */
  async getAuditLog(agentId?: string, limit: number = 100): Promise<AuditEntry[]> {
    if (this.storage) {
      return this.storage.getAuditLog(agentId, limit);
    }
    return [];
  }

  /**
   * Get daily cost for an agent.
   */
  getDailyCost(agentId: string): number {
    return this.dailyCosts.get(agentId) ?? 0;
  }

  /**
   * Register a new tool whitelist for an agent type.
   * Use this when onboarding a new agent type at runtime.
   */
  registerToolWhitelist(agentType: string, whitelist: Partial<Record<Tier, string[]>>): void {
    this.toolWhitelist[agentType] = whitelist;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private startTask(agentId: string): void {
    const current = this.activeTasks.get(agentId) ?? 0;
    this.activeTasks.set(agentId, current + 1);
  }

  private findTierForTool(agentType: string, toolName: string): Tier | null {
    const typeWhitelist = this.toolWhitelist[agentType];
    if (!typeWhitelist) return null;
    for (const tier of [0, 1, 2, 3] as Tier[]) {
      if (typeWhitelist[tier]?.includes(toolName)) return tier;
    }
    return null;
  }

  private checkDayRollover(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailyCosts.clear();
      this.lastResetDate = today;
    }
  }
}
