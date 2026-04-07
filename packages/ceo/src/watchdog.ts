/**
 * Watchdog — Dead Man's Switch for the CEO Agent
 *
 * The CEO Agent must call ping() on a regular schedule. External monitoring
 * systems call isAlive() to verify the CEO is running. If the CEO stops
 * pinging, the watchdog reports stale — and the external system (alerting,
 * PagerDuty, webhook) takes action.
 *
 * Pattern: same as Kubernetes liveness probes and hardware watchdog timers.
 * The process MUST actively reset the timer; silence == dead.
 */

import type { AegisEvent, AegisEventHandler } from "@a2b/core";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WatchdogConfig {
  /**
   * Unique ID of the CEO Agent (embedded in heartbeat events).
   */
  ceoAgentId: string;

  /**
   * How long (ms) without a ping before the watchdog considers the CEO dead.
   * Default: 6 minutes (2× the expected 5-minute heartbeat interval).
   */
  timeoutMs?: number;

  /**
   * Called every time a heartbeat event is emitted.
   */
  onEvent?: AegisEventHandler;

  /**
   * Called when the watchdog transitions from alive → stale.
   * Use this to wire up external alerting (email, webhook, PagerDuty, etc.)
   */
  onStale?: (lastSeen: number, staleSinceMs: number) => void | Promise<void>;
}

export interface HeartbeatStatus {
  /** True if the last ping was within the timeout window. */
  alive: boolean;
  /** Timestamp of the most recent ping (ms since epoch). 0 if never pinged. */
  lastHeartbeat: number;
  /** How long ago the last ping was (ms). */
  msSinceLastPing: number;
  /** Configured timeout (ms). */
  timeoutMs: number;
}

// ─── Watchdog ────────────────────────────────────────────────────────────────

/**
 * Dead Man's Switch implementation.
 *
 * Usage:
 * ```ts
 * const wd = new Watchdog({ ceoAgentId: "ceo-1", timeoutMs: 360_000 });
 * setInterval(() => wd.ping(), 300_000);   // Heartbeat every 5 minutes
 *
 * // In your monitoring system:
 * if (!wd.isAlive()) alert("CEO Agent is down!");
 * ```
 */
export class Watchdog {
  private readonly ceoAgentId: string;
  private readonly timeoutMs: number;
  private readonly onEvent: AegisEventHandler;
  private readonly onStale: WatchdogConfig["onStale"];

  private lastHeartbeat: number = 0;
  private wasAlive: boolean = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: WatchdogConfig) {
    this.ceoAgentId = config.ceoAgentId;
    this.timeoutMs = config.timeoutMs ?? 360_000; // 6 min default
    this.onEvent = config.onEvent ?? (() => {});
    this.onStale = config.onStale;
  }

  /**
   * Reset the dead man's switch. Call this on your heartbeat schedule.
   * Emits a `heartbeat` AegisEvent so the event log stays consistent.
   */
  ping(): void {
    const now = Date.now();
    this.lastHeartbeat = now;
    this.wasAlive = true;

    const event: AegisEvent = {
      type: "heartbeat",
      ceoAgentId: this.ceoAgentId,
      timestamp: now,
    };

    // Fire-and-forget — event handler errors must not kill the watchdog
    try {
      const result = this.onEvent(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error("[Watchdog] onEvent handler threw:", err);
        });
      }
    } catch (err) {
      console.error("[Watchdog] onEvent handler threw synchronously:", err);
    }
  }

  /**
   * Returns true if a ping has been received within the timeout window.
   */
  isAlive(): boolean {
    if (this.lastHeartbeat === 0) return false;
    return Date.now() - this.lastHeartbeat < this.timeoutMs;
  }

  /**
   * Returns the timestamp of the most recent ping (ms since epoch).
   * Returns 0 if ping() has never been called.
   */
  getLastHeartbeat(): number {
    return this.lastHeartbeat;
  }

  /**
   * Returns a full status snapshot for monitoring dashboards.
   */
  getStatus(): HeartbeatStatus {
    const now = Date.now();
    const msSinceLastPing = this.lastHeartbeat === 0 ? Infinity : now - this.lastHeartbeat;
    return {
      alive: this.isAlive(),
      lastHeartbeat: this.lastHeartbeat,
      msSinceLastPing: this.lastHeartbeat === 0 ? Infinity : msSinceLastPing,
      timeoutMs: this.timeoutMs,
    };
  }

  /**
   * Start a background check loop that calls onStale() when the CEO goes
   * quiet. The check interval is 1/6 of the timeout (check 6× per window).
   *
   * Call stop() when shutting down to clear the timer.
   */
  startMonitoring(): void {
    if (this.checkTimer !== null) return; // Already running

    const interval = Math.max(10_000, Math.floor(this.timeoutMs / 6));

    this.checkTimer = setInterval(() => {
      const alive = this.isAlive();

      if (this.wasAlive && !alive && this.onStale) {
        const staleSinceMs = Date.now() - this.lastHeartbeat;
        try {
          const result = this.onStale(this.lastHeartbeat, staleSinceMs);
          if (result instanceof Promise) {
            result.catch((err: unknown) => {
              console.error("[Watchdog] onStale handler threw:", err);
            });
          }
        } catch (err) {
          console.error("[Watchdog] onStale handler threw synchronously:", err);
        }
      }

      this.wasAlive = alive;
    }, interval);
  }

  /**
   * Stop the background monitoring loop.
   */
  stop(): void {
    if (this.checkTimer !== null) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }
}
