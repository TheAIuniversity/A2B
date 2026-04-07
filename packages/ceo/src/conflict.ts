/**
 * Conflict Resolution — Merge Queue + Blame DAG
 *
 * Two problems solved here:
 *
 * 1. MERGE QUEUE: Multiple agents want the same resource simultaneously.
 *    Resolution priority (highest → lowest):
 *      a) Tier     — higher-tier agents have earned more autonomy
 *      b) Trust    — within the same tier, the more trusted agent wins
 *      c) Urgency  — "high" beats "normal" beats "low"
 *      d) FIFO     — if everything else ties, first-come-first-served
 *
 * 2. BLAME DAG: A cascading failure has occurred. Multiple agents failed, and
 *    we need to find the root cause so we blame (and demote) the right one,
 *    not the downstream victims.
 *
 * Inspiration:
 * - Git merge queues (serial integration ordering)
 * - Kubernetes eviction priority classes
 * - Google SRE causality analysis
 */

import type { AgentRecord, AegisEvent, AegisEventHandler, Tier } from "@a2b/core";

// ─── Merge Queue Types ────────────────────────────────────────────────────────

export type UrgencyLevel = "low" | "normal" | "high";

/** Maps urgency to a numeric value for comparison. */
const URGENCY_RANK: Record<UrgencyLevel, number> = {
  high:   2,
  normal: 1,
  low:    0,
};

export interface ResourceClaim {
  /** Unique ID of the claim (generated on submit). */
  claimId: string;
  /** Agent requesting the resource. */
  agentId: string;
  /** The logical resource being requested (e.g., "email-sender", "db-writer"). */
  resource: string;
  /** Agent's current tier (higher tier = higher priority). */
  tier: Tier;
  /** Agent's current trust score (0-1). */
  trustScore: number;
  /** How urgent is this work? */
  urgency: UrgencyLevel;
  /** When this claim was submitted (ms since epoch). */
  submittedAt: number;
}

export interface ClaimResult {
  /** Whether the resource was granted. */
  allowed: boolean;
  /** The winning claim ID. */
  claimId: string;
  /** Human-readable explanation of the decision. */
  reason: string;
  /**
   * If denied, this is the ID of the claim currently holding the resource.
   * The requesting agent should retry once this claim is released.
   */
  blockedBy?: string;
}

// ─── Blame DAG Types ──────────────────────────────────────────────────────────

export interface FailureNode {
  /** Agent that failed. */
  agentId: string;
  /** Error message or failure reason. */
  reason: string;
  /** When the failure was detected (ms). */
  timestamp: number;
  /**
   * IDs of agents that this failure directly triggered.
   * "agentA failed → agentB (which depended on A) also failed"
   */
  triggeredFailures: string[];
  /**
   * IDs of agents whose failures this agent is downstream of.
   * Populated when linking the DAG.
   */
  causedBy: string[];
}

export interface CascadeReport {
  /** The agent at the true start of the failure chain. */
  rootCauseAgentId: string;
  /** All agents affected (including the root). Ordered root → leaves. */
  affected: string[];
  /** The full path from root to the most downstream failure. */
  longestChain: string[];
  /** Raw nodes in the DAG, keyed by agentId. */
  nodes: Record<string, FailureNode>;
}

// ─── MergeQueue ──────────────────────────────────────────────────────────────

/**
 * Serialises concurrent resource access using a priority queue.
 *
 * Resources are released explicitly via release(). Claims waiting for a
 * held resource are queued and re-evaluated on each release.
 *
 * ```ts
 * const queue = new MergeQueue({ onEvent });
 *
 * const r = queue.claimResource({
 *   agentId: "agent-42",
 *   resource: "email-sender",
 *   tier: 2,
 *   trustScore: 0.82,
 *   urgency: "high",
 * });
 *
 * if (r.allowed) {
 *   await sendEmail(...);
 *   queue.release("email-sender", r.claimId);
 * }
 * ```
 */
export class MergeQueue {
  /** Resources currently held: resource → active claimId. */
  private held: Map<string, string> = new Map();

  /** Claims waiting for a resource: resource → queue of claims. */
  private waiting: Map<string, ResourceClaim[]> = new Map();

  /** All claims ever registered, by claimId. */
  private claims: Map<string, ResourceClaim> = new Map();

  private onEvent: AegisEventHandler;
  private counter: number = 0;

  constructor(config: { onEvent?: AegisEventHandler } = {}) {
    this.onEvent = config.onEvent ?? (() => {});
  }

  /**
   * Request exclusive access to a resource.
   *
   * If the resource is free, grants access immediately.
   * If the resource is held, queues the claim and denies for now.
   * Callers should listen to events or poll release() to retry.
   */
  claimResource(
    params: Omit<ResourceClaim, "claimId" | "submittedAt">,
  ): ClaimResult {
    const claimId = this.nextClaimId();
    const claim: ResourceClaim = {
      ...params,
      claimId,
      submittedAt: Date.now(),
    };

    this.claims.set(claimId, claim);

    const currentHolder = this.held.get(params.resource);

    if (!currentHolder) {
      // Resource is free — grant immediately
      this.held.set(params.resource, claimId);
      return {
        allowed: true,
        claimId,
        reason: "Resource is free, claim granted",
      };
    }

    // Resource is held — enqueue and deny
    const queue = this.waiting.get(params.resource) ?? [];
    queue.push(claim);
    // Keep the waiting queue sorted by priority so the next grantee is always
    // at index 0 (avoids re-sorting on every release).
    queue.sort(compareClaims);
    this.waiting.set(params.resource, queue);

    return {
      allowed: false,
      claimId,
      reason: `Resource "${params.resource}" is held by claim ${currentHolder}`,
      blockedBy: currentHolder,
    };
  }

  /**
   * Release a resource. If other claims are waiting, the highest-priority
   * waiting claim is granted and an event is emitted.
   *
   * Must be called with the claimId that was granted (not a waiting one).
   * Returns true if the release was valid, false if the claimId did not hold
   * the resource (guards against double-release bugs).
   */
  release(resource: string, claimId: string): boolean {
    if (this.held.get(resource) !== claimId) return false;

    this.held.delete(resource);
    this.claims.delete(claimId);

    const queue = this.waiting.get(resource);
    if (!queue || queue.length === 0) return true;

    // Grant to the next in line
    const next = queue.shift()!;
    if (queue.length === 0) this.waiting.delete(resource);
    else this.waiting.set(resource, queue);

    this.held.set(resource, next.claimId);

    return true;
  }

  /**
   * Returns the active claim for a resource, or null if it is free.
   */
  getHolder(resource: string): ResourceClaim | null {
    const claimId = this.held.get(resource);
    if (!claimId) return null;
    return this.claims.get(claimId) ?? null;
  }

  /**
   * Returns all claims waiting for a resource, in priority order.
   */
  getQueue(resource: string): ResourceClaim[] {
    return this.waiting.get(resource) ?? [];
  }

  /**
   * How many resources are currently held.
   */
  getHeldCount(): number {
    return this.held.size;
  }

  /**
   * How many claims are waiting across all resources.
   */
  getWaitingCount(): number {
    let total = 0;
    for (const q of this.waiting.values()) total += q.length;
    return total;
  }

  private nextClaimId(): string {
    return `claim-${Date.now()}-${(++this.counter).toString().padStart(4, "0")}`;
  }
}

/**
 * Comparator for ResourceClaim priority:
 *   Tier desc → Trust desc → Urgency desc → submittedAt asc (FIFO)
 *
 * Negative return = a comes first (higher priority).
 */
function compareClaims(a: ResourceClaim, b: ResourceClaim): number {
  // 1. Tier (higher is better)
  if (b.tier !== a.tier) return b.tier - a.tier;

  // 2. Trust score (higher is better)
  const trustDiff = b.trustScore - a.trustScore;
  if (Math.abs(trustDiff) > 1e-6) return trustDiff > 0 ? 1 : -1;

  // 3. Urgency
  const urgencyDiff = URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency];
  if (urgencyDiff !== 0) return urgencyDiff;

  // 4. FIFO (earlier submission wins)
  return a.submittedAt - b.submittedAt;
}

// ─── BlameDAG ────────────────────────────────────────────────────────────────

/**
 * Directed Acyclic Graph for cascading failure analysis.
 *
 * Failures are registered one by one. The DAG links them via the
 * triggeredFailures relationship. traceCascade() then runs a BFS/DFS from
 * all failure roots to find the true origin.
 *
 * ```ts
 * const dag = new BlameDAG({ onEvent });
 *
 * dag.addFailure("db-agent",    "Connection pool exhausted", []);
 * dag.addFailure("api-agent",   "DB timeout",               ["db-agent"]);
 * dag.addFailure("email-agent", "API 503",                  ["api-agent"]);
 *
 * const report = dag.traceCascade("email-agent");
 * // report.rootCauseAgentId === "db-agent"
 * ```
 */
export class BlameDAG {
  private nodes: Map<string, FailureNode> = new Map();
  private onEvent: AegisEventHandler;

  constructor(config: { onEvent?: AegisEventHandler } = {}) {
    this.onEvent = config.onEvent ?? (() => {});
  }

  /**
   * Record a failure in the DAG.
   *
   * @param agentId    - The agent that failed.
   * @param reason     - Human-readable failure description.
   * @param causedByIds - IDs of agents whose failures directly caused this one.
   *                     Pass [] if this is a root failure (no known upstream cause).
   */
  addFailure(agentId: string, reason: string, causedByIds: string[]): void {
    const now = Date.now();

    const node: FailureNode = {
      agentId,
      reason,
      timestamp: now,
      triggeredFailures: [],
      causedBy: causedByIds,
    };

    this.nodes.set(agentId, node);

    // Back-link: add this agent to the triggeredFailures list of each cause
    for (const causeId of causedByIds) {
      const causeNode = this.nodes.get(causeId);
      if (causeNode && !causeNode.triggeredFailures.includes(agentId)) {
        causeNode.triggeredFailures.push(agentId);
      }
    }
  }

  /**
   * Trace the cascade from a known failed agent back to the root cause.
   *
   * Algorithm: Walk up the causedBy chain from startAgentId until we find a
   * node with no upstream causes (that is the root). If there are multiple
   * root candidates (independent failures), pick the one with the earliest
   * timestamp.
   *
   * Also returns the full set of affected agents and the longest downstream
   * chain from the root.
   */
  traceCascade(startAgentId: string): CascadeReport | null {
    if (!this.nodes.has(startAgentId)) return null;

    // Step 1: Find all root causes by walking up from startAgentId
    const roots = this.findRoots(startAgentId);

    // Step 2: Pick the earliest root (most likely the true origin)
    let rootCause = roots[0];
    for (const r of roots) {
      const rNode = this.nodes.get(r)!;
      const currentNode = this.nodes.get(rootCause)!;
      if (rNode.timestamp < currentNode.timestamp) rootCause = r;
    }

    // Step 3: BFS from root to collect all affected agents
    const affected = this.bfsDownstream(rootCause);

    // Step 4: Find the longest downstream chain from root
    const longestChain = this.longestPath(rootCause);

    // Step 5: Emit cascade-detected event
    const event: AegisEvent = {
      type: "cascade-detected",
      rootCause,
      affected,
      timestamp: Date.now(),
    };

    try {
      const result = this.onEvent(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error("[BlameDAG] onEvent handler threw:", err);
        });
      }
    } catch (err) {
      console.error("[BlameDAG] onEvent handler threw synchronously:", err);
    }

    return {
      rootCauseAgentId: rootCause,
      affected,
      longestChain,
      nodes: Object.fromEntries(
        Array.from(this.nodes.entries()).map(([k, v]) => [k, { ...v }]),
      ),
    };
  }

  /**
   * Remove all failure records (call at the start of each monitoring cycle
   * or after resolutions have been applied).
   */
  clear(): void {
    this.nodes.clear();
  }

  /**
   * How many failure nodes are currently in the DAG.
   */
  size(): number {
    return this.nodes.size;
  }

  /**
   * Walk up causedBy links from a starting node, collecting all nodes that
   * have no upstream causes (roots). Returns agentIds of root nodes.
   */
  private findRoots(startAgentId: string): string[] {
    const visited = new Set<string>();
    const roots: string[] = [];

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);

      const node = this.nodes.get(id);
      if (!node) return;

      const knownCauses = node.causedBy.filter(c => this.nodes.has(c));

      if (knownCauses.length === 0) {
        roots.push(id);
      } else {
        for (const cause of knownCauses) visit(cause);
      }
    };

    visit(startAgentId);
    return roots.length > 0 ? roots : [startAgentId];
  }

  /**
   * BFS downstream from a root node, returning all reachable agent IDs in
   * breadth-first order (root first, leaves last).
   */
  private bfsDownstream(rootId: string): string[] {
    const visited = new Set<string>();
    const queue: string[] = [rootId];
    const result: string[] = [];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      result.push(id);

      const node = this.nodes.get(id);
      if (node) {
        for (const next of node.triggeredFailures) {
          if (!visited.has(next)) queue.push(next);
        }
      }
    }

    return result;
  }

  /**
   * DFS to find the longest downstream path from a root.
   * Returns the path as an ordered array of agentIds.
   */
  private longestPath(rootId: string): string[] {
    const memo: Map<string, string[]> = new Map();

    const dfs = (id: string, visited: Set<string>): string[] => {
      if (memo.has(id)) return memo.get(id)!;
      if (visited.has(id)) return [id]; // Cycle guard (shouldn't happen in a DAG)

      visited.add(id);
      const node = this.nodes.get(id);
      if (!node || node.triggeredFailures.length === 0) {
        const result = [id];
        memo.set(id, result);
        return result;
      }

      let longest: string[] = [];
      for (const next of node.triggeredFailures) {
        const sub = dfs(next, new Set(visited));
        if (sub.length > longest.length) longest = sub;
      }

      const result = [id, ...longest];
      memo.set(id, result);
      return result;
    };

    return dfs(rootId, new Set());
  }
}
