/**
 * Policy Engine — 3-Gate enforcement for agent actions
 *
 * Gate 1: Tool Registry (compile-time — agent doesn't see blocked tools)
 * Gate 2: Runtime Policy (every tool call — code-level, not prompt-based)
 * Gate 3: Audit Log (after every action — immutable record)
 *
 * Based on:
 * - Kubernetes RBAC (role-based access control)
 * - Microsoft Agent Governance Toolkit (sub-ms policy evaluation)
 * - SEAgent (privilege escalation prevention)
 */

import type { AgentRecord, Tier, AuditEntry, AegisEvent, AegisEventHandler } from "./types.js";
import { DEFAULT_TIER_CONFIGS } from "./types.js";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  suggestion?: string;
}

export interface PolicyEngineConfig {
  /** Global blocked patterns (apply to ALL agents regardless of tier) */
  blockedPatterns?: string[];
  /** Custom tool whitelist per agent type + tier */
  toolWhitelist?: Record<string, Record<Tier, string[]>>;
  onEvent?: AegisEventHandler;
}

export class PolicyEngine {
  private blockedPatterns: string[];
  private toolWhitelist: Record<string, Record<Tier, string[]>>;
  private auditLog: AuditEntry[] = [];
  private activeTasks: Map<string, number> = new Map(); // agentId → count
  private dailyCosts: Map<string, number> = new Map();  // agentId → EUR today
  private lastResetDate: string = "";
  private onEvent: AegisEventHandler;

  constructor(config: PolicyEngineConfig = {}) {
    this.blockedPatterns = config.blockedPatterns ?? [
      "rm -rf", "DROP TABLE", "DELETE FROM", "FORMAT",
    ];
    this.toolWhitelist = config.toolWhitelist ?? {};
    this.onEvent = config.onEvent ?? (() => {});
  }

  /**
   * Gate 1: Get the list of tools an agent is allowed to use.
   * Used to build --disallowedTools at spawn time.
   */
  getAllowedTools(agentId: string, agentType: string, tier: Tier, allTools: string[]): string[] {
    const whitelist = this.toolWhitelist[agentType]?.[tier];
    if (whitelist) {
      // Only allow tools in the whitelist for this type+tier
      return allTools.filter(t => whitelist.includes(t));
    }
    // Default: all tools except tier-restricted ones
    return allTools;
  }

  /**
   * Gate 1: Get tools that should be BLOCKED for this agent.
   */
  getDisallowedTools(agentId: string, agentType: string, tier: Tier, allTools: string[]): string[] {
    const allowed = new Set(this.getAllowedTools(agentId, agentType, tier, allTools));
    return allTools.filter(t => !allowed.has(t));
  }

  /**
   * Gate 2: Runtime policy check BEFORE tool execution.
   * This is CODE-LEVEL enforcement — the agent CANNOT bypass this.
   */
  evaluateAction(
    agent: AgentRecord,
    toolName: string,
    allowedTools: string[],
  ): PolicyDecision {
    this.checkDayRollover();

    // Check 1: Tool access
    if (!allowedTools.includes(toolName)) {
      const tierNeeded = this.findTierForTool(agent.type, toolName);
      const decision: PolicyDecision = {
        allowed: false,
        reason: `Tool "${toolName}" requires Tier ${tierNeeded ?? "?"}. You are Tier ${agent.tier}.`,
        suggestion: tierNeeded !== null
          ? `Earn promotion to Tier ${tierNeeded} to unlock this tool. Use request_development if you need help.`
          : undefined,
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
   * Gate 3: Record an action in the audit log.
   */
  recordAction(entry: Omit<AuditEntry, "id">): AuditEntry {
    const fullEntry: AuditEntry = {
      id: `${entry.timestamp}-${entry.agentId}-${Math.random().toString(36).slice(2, 8)}`,
      ...entry,
    };

    this.auditLog.push(fullEntry);

    // Track costs
    if (entry.cost) {
      const current = this.dailyCosts.get(entry.agentId) ?? 0;
      this.dailyCosts.set(entry.agentId, current + entry.cost);
    }

    return fullEntry;
  }

  /**
   * Track concurrent tasks.
   */
  startTask(agentId: string): void {
    const current = this.activeTasks.get(agentId) ?? 0;
    this.activeTasks.set(agentId, current + 1);
  }

  endTask(agentId: string): void {
    const current = this.activeTasks.get(agentId) ?? 0;
    this.activeTasks.set(agentId, Math.max(0, current - 1));
  }

  /**
   * Get audit log for an agent (or all agents).
   */
  getAuditLog(agentId?: string, limit: number = 100): AuditEntry[] {
    let entries = agentId
      ? this.auditLog.filter(e => e.agentId === agentId)
      : this.auditLog;
    return entries.slice(-limit);
  }

  /**
   * Get daily cost for an agent.
   */
  getDailyCost(agentId: string): number {
    return this.dailyCosts.get(agentId) ?? 0;
  }

  /**
   * Find which tier grants access to a tool.
   */
  private findTierForTool(agentType: string, toolName: string): Tier | null {
    const typeWhitelist = this.toolWhitelist[agentType];
    if (!typeWhitelist) return null;

    for (const tier of [0, 1, 2, 3] as Tier[]) {
      if (typeWhitelist[tier]?.includes(toolName)) return tier;
    }
    return null;
  }

  /**
   * Reset daily costs at midnight.
   */
  private checkDayRollover(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailyCosts.clear();
      this.lastResetDate = today;
    }
  }
}
