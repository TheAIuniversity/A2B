/**
 * @a2b/ceo — CEO Agent Package
 *
 * Top-level supervisor for the A2B agent framework.
 *
 * Primary entry point:
 *   import { CEOAgent } from "@a2b/ceo";
 *   const ceo = new CEOAgent({ onEvent: ..., storage: ... });
 *   ceo.start();
 */

// ─── CEO Agent (primary export) ──────────────────────────────────────────────

export { CEOAgent } from "./ceo-agent.js";
export type { CEOAgentConfig, AgentEvaluation, DailyReport } from "./ceo-agent.js";

// ─── PID Monitor ─────────────────────────────────────────────────────────────

export { AgentMonitor, MonitorRegistry } from "./monitor.js";
export type { MetricDataPoint, PIDState, AgentMonitorConfig } from "./monitor.js";

// ─── Conflict Resolution ──────────────────────────────────────────────────────

export { MergeQueue, BlameDAG } from "./conflict.js";
export type {
  ResourceClaim,
  ClaimResult,
  UrgencyLevel,
  FailureNode,
  CascadeReport,
} from "./conflict.js";

// ─── Watchdog ─────────────────────────────────────────────────────────────────

export { Watchdog } from "./watchdog.js";
export type { WatchdogConfig, HeartbeatStatus } from "./watchdog.js";
