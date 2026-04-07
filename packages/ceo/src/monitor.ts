/**
 * Monitor — PID Controller for per-agent metric correction
 *
 * A PID controller is the standard industrial control mechanism for keeping a
 * system at a target setpoint. Here we apply it to agent performance:
 *
 *   P (proportional) = How far off is the agent RIGHT NOW?
 *   I (integral)     = What is the 7-day weighted average trend?
 *   D (derivative)   = How fast is performance changing?
 *
 * Correction signal = 0.3*P + 0.5*I + 0.2*D
 *
 * A positive correction signal means the agent is above threshold (healthy).
 * A negative correction signal means the agent needs intervention.
 *
 * Gain tuning:
 * - I is highest (0.5) because sustained poor trend matters most for trust.
 * - P is second (0.3) because current state drives immediate decisions.
 * - D is lowest (0.2) because noisy derivatives can cause oscillation.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MetricDataPoint {
  /** Unix timestamp (ms) when this metric was recorded. */
  timestamp: number;
  /** Score value (0-1 scale). */
  score: number;
}

export interface PIDState {
  /** Current error: score - threshold. Positive = above target, negative = below. */
  proportional: number;
  /** Weighted average of recent errors. */
  integral: number;
  /** Rate of change per day (score units / day). */
  derivative: number;
  /** Combined correction signal: 0.3P + 0.5I + 0.2D. */
  correction: number;
  /** Number of data points used in the calculation. */
  sampleCount: number;
  /** Timestamp of the oldest data point in the window. */
  windowStart: number;
  /** Timestamp of the most recent data point. */
  windowEnd: number;
}

export interface AgentMonitorConfig {
  /** Performance target (0-1). Default: 0.70. */
  threshold?: number;
  /** Rolling window in days. Default: 7. */
  windowDays?: number;
  /**
   * Correction signal below this → warning.
   * Default: -0.10 (agent is 10 points below target on average).
   */
  warnBelow?: number;
  /**
   * Correction signal below this → recommend demotion.
   * Default: -0.25.
   */
  demoteBelow?: number;
}

// ─── PID Gains (these match the spec exactly) ───────────────────────────────

const GAIN_P = 0.3;
const GAIN_I = 0.5;
const GAIN_D = 0.2;

// ─── AgentMonitor ────────────────────────────────────────────────────────────

/**
 * Tracks a single metric for one agent over a rolling window and computes a
 * PID-style correction signal.
 *
 * One AgentMonitor instance per (agent, metric) pair. The CEO agent typically
 * tracks `trustScore` and `errorRate` separately for each monitored agent.
 *
 * Example:
 * ```ts
 * const m = new AgentMonitor({ threshold: 0.75 });
 * m.addDataPoint(Date.now(), agent.trust.score);
 * const { correction } = m.getPIDState();
 * if (m.shouldDemote()) ceo.demote(agent.id, "PID signal below demotion threshold");
 * ```
 */
export class AgentMonitor {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly warnBelow: number;
  private readonly demoteBelow: number;

  /** Raw data points ordered oldest → newest. */
  private points: MetricDataPoint[] = [];

  constructor(config: AgentMonitorConfig = {}) {
    this.threshold = config.threshold ?? 0.70;
    this.windowMs = (config.windowDays ?? 7) * 86_400_000;
    this.warnBelow = config.warnBelow ?? -0.10;
    this.demoteBelow = config.demoteBelow ?? -0.25;
  }

  /**
   * Record a new metric data point. Automatically prunes points older than the
   * rolling window.
   */
  addDataPoint(timestamp: number, score: number): void {
    this.points.push({ timestamp, score });
    this.prune(timestamp);
  }

  /**
   * Compute the current PID state from all data points in the window.
   *
   * Returns null if there are fewer than 2 data points (can't compute
   * derivative without at least two readings).
   */
  getPIDState(): PIDState | null {
    if (this.points.length < 2) return null;

    const now = this.points[this.points.length - 1].timestamp;
    const n = this.points.length;

    // ── P: proportional ─────────────────────────────────────────────────────
    // Current error = latest score minus target threshold
    const latestScore = this.points[n - 1].score;
    const P = latestScore - this.threshold;

    // ── I: integral (7-day weighted average error) ───────────────────────────
    // Weight = how recent the sample is (linear decay: newest = 1.0, oldest → 0)
    // This makes recent behaviour count more than old behaviour.
    let weightedErrorSum = 0;
    let weightSum = 0;

    for (let i = 0; i < n; i++) {
      const pt = this.points[i];
      const ageMs = now - pt.timestamp;
      // Linear weight: 1.0 at age=0, 0.0 at age=windowMs
      const weight = Math.max(0, 1 - ageMs / this.windowMs);
      const error = pt.score - this.threshold;
      weightedErrorSum += weight * error;
      weightSum += weight;
    }

    const I = weightSum > 0 ? weightedErrorSum / weightSum : 0;

    // ── D: derivative (rate of change per day) ───────────────────────────────
    // Least-squares slope over the available points, normalised to per-day.
    // Using all points (not just first/last) makes D less noisy.
    const D = this.computeSlopePerDay();

    // ── Combined correction signal ────────────────────────────────────────────
    const correction = GAIN_P * P + GAIN_I * I + GAIN_D * D;

    return {
      proportional: P,
      integral: I,
      derivative: D,
      correction,
      sampleCount: n,
      windowStart: this.points[0].timestamp,
      windowEnd: now,
    };
  }

  /**
   * Returns true if the correction signal is below the warning threshold.
   * The agent needs attention but not yet a demotion.
   */
  shouldWarn(): boolean {
    const state = this.getPIDState();
    if (!state) return false;
    return state.correction < this.warnBelow && state.correction >= this.demoteBelow;
  }

  /**
   * Returns true if the correction signal is below the demotion threshold.
   * The CEO should demote or pause this agent.
   */
  shouldDemote(): boolean {
    const state = this.getPIDState();
    if (!state) return false;
    return state.correction < this.demoteBelow;
  }

  /**
   * Returns the current score if at least one data point exists.
   */
  getLatestScore(): number | null {
    if (this.points.length === 0) return null;
    return this.points[this.points.length - 1].score;
  }

  /**
   * How many data points are in the current window.
   */
  getSampleCount(): number {
    return this.points.length;
  }

  /**
   * Remove data points older than the rolling window relative to `now`.
   */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    // Keep at least 2 points so derivative can always be computed
    while (this.points.length > 2 && this.points[0].timestamp < cutoff) {
      this.points.shift();
    }
  }

  /**
   * Ordinary least-squares linear regression slope over the time series.
   * Returns the slope in score-units per day.
   *
   * Using OLS rather than (last - first) / time avoids extreme sensitivity to
   * outlier readings at either end of the window.
   */
  private computeSlopePerDay(): number {
    const n = this.points.length;
    if (n < 2) return 0;

    // Convert timestamps to days-from-start for numerical stability
    const t0 = this.points[0].timestamp;
    const xs = this.points.map(p => (p.timestamp - t0) / 86_400_000);
    const ys = this.points.map(p => p.score);

    const meanX = xs.reduce((s, v) => s + v, 0) / n;
    const meanY = ys.reduce((s, v) => s + v, 0) / n;

    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      num += dx * (ys[i] - meanY);
      den += dx * dx;
    }

    return den > 0 ? num / den : 0;
  }
}

// ─── MonitorRegistry ─────────────────────────────────────────────────────────

/**
 * Manages one AgentMonitor per (agentId, metric) pair.
 *
 * The CEO agent calls addDataPoint() after every evaluation cycle and reads
 * shouldWarn() / shouldDemote() when deciding what action to take.
 */
export class MonitorRegistry {
  private monitors: Map<string, AgentMonitor> = new Map();
  private defaultConfig: AgentMonitorConfig;

  constructor(defaultConfig: AgentMonitorConfig = {}) {
    this.defaultConfig = defaultConfig;
  }

  /**
   * Returns the monitor for the given (agentId, metric) combination, creating
   * it with the default config if it doesn't yet exist.
   */
  get(agentId: string, metric: string): AgentMonitor {
    const key = `${agentId}::${metric}`;
    let monitor = this.monitors.get(key);
    if (!monitor) {
      monitor = new AgentMonitor(this.defaultConfig);
      this.monitors.set(key, monitor);
    }
    return monitor;
  }

  /**
   * Record a data point for a specific (agentId, metric).
   */
  record(agentId: string, metric: string, timestamp: number, score: number): void {
    this.get(agentId, metric).addDataPoint(timestamp, score);
  }

  /**
   * Get PID state for a specific (agentId, metric). Returns null if
   * insufficient data.
   */
  getPIDState(agentId: string, metric: string): PIDState | null {
    return this.get(agentId, metric).getPIDState();
  }

  /**
   * Returns all agent IDs that currently have at least one monitor registered.
   */
  getTrackedAgentIds(): string[] {
    const ids = new Set<string>();
    for (const key of this.monitors.keys()) {
      ids.add(key.split("::")[0]);
    }
    return Array.from(ids);
  }
}
