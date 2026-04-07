/**
 * A2B Core Types — The foundation of the Agent-to-Business framework
 *
 * Every agent system implements AegisAgent.
 * A2B handles trust, tiers, onboarding, and governance.
 */

// ─── Agent Interface (what users implement) ─────────────────────────────────

export interface AegisAgent {
  /** Unique agent identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Agent category — determines which scorecard template to use */
  type: AgentType;
  /** Execute a task and return the result */
  execute(task: Task): Promise<TaskResult>;
  /** Optional: custom scorecard weights (overrides type defaults) */
  scorecardWeights?: Partial<ScorecardWeights>;
  /** Optional: tools available per tier */
  toolsByTier?: Record<Tier, string[]>;
  /** Optional: budget limits per tier */
  budgetByTier?: Record<Tier, BudgetLimit>;
  /** Optional: custom promotion criteria */
  promotionCriteria?: PromotionConfig;
  /** Optional: handle pause command from CEO */
  onPause?(): Promise<void>;
  /** Optional: handle resume command from CEO */
  onResume?(): Promise<void>;
  /** Optional: report current status */
  getStatus?(): AgentStatus;
}

// ─── Agent Types ────────────────────────────────────────────────────────────

export type AgentType =
  | "contact"      // Direct customer interaction (email, chat, support)
  | "intel"        // Research and analysis (competitors, trends, market)
  | "prospector"   // Finding new leads/opportunities
  | "strategy"     // Planning and decision-making
  | "content"      // Creating content (text, media, ads)
  | "infra"        // System maintenance and operations
  | "simulation"   // Running simulations and scenarios
  | "custom";      // User-defined type

// ─── Tiers ──────────────────────────────────────────────────────────────────

export type Tier = 0 | 1 | 2 | 3;

export interface TierConfig {
  name: string;
  description: string;
  maxConcurrentTasks: number;
  reviewRate: number;           // 0.0-1.0 (1.0 = 100% reviewed)
  maxBudgetPerTask: number;     // EUR
  maxBudgetPerDay: number;      // EUR
  canEvaluateTiers: Tier[];     // Which tiers this tier can review
  canDelegateToTiers: Tier[];   // Which tiers this tier can assign work to
}

export const DEFAULT_TIER_CONFIGS: Record<Tier, TierConfig> = {
  0: {
    name: "Onboarding",
    description: "New agent in sandbox. 100% supervised. Proving itself.",
    maxConcurrentTasks: 1,
    reviewRate: 1.0,
    maxBudgetPerTask: 0.05,
    maxBudgetPerDay: 1.00,
    canEvaluateTiers: [],
    canDelegateToTiers: [],
  },
  1: {
    name: "Junior",
    description: "Basic competence proven. Limited tools. 100% reviewed.",
    maxConcurrentTasks: 1,
    reviewRate: 1.0,
    maxBudgetPerTask: 0.10,
    maxBudgetPerDay: 2.00,
    canEvaluateTiers: [],
    canDelegateToTiers: [],
  },
  2: {
    name: "Senior",
    description: "Proven performer. Extended tools. 20% spot-checked.",
    maxConcurrentTasks: 3,
    reviewRate: 0.20,
    maxBudgetPerTask: 0.30,
    maxBudgetPerDay: 10.00,
    canEvaluateTiers: [0, 1],
    canDelegateToTiers: [0, 1],
  },
  3: {
    name: "Autonomous",
    description: "Full autonomy. All tools. Exception-only review.",
    maxConcurrentTasks: Infinity,
    reviewRate: 0.0,
    maxBudgetPerTask: 1.00,
    maxBudgetPerDay: 30.00,
    canEvaluateTiers: [0, 1, 2],
    canDelegateToTiers: [0, 1, 2],
  },
};

// ─── Tasks ──────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  description: string;
  difficulty: "easy" | "medium" | "hard";
  domain?: string;
  payload?: Record<string, unknown>;
  isCanary?: boolean;              // Hidden test task
  createdAt: number;
}

export interface TaskResult {
  success: boolean;
  output?: unknown;
  error?: string;
  honestFailure?: boolean;         // Agent admits it couldn't do it
  confidence?: number;             // 0-1, self-reported confidence
  tokensUsed?: number;
  cost?: number;
  duration?: number;
}

// ─── Trust Score ────────────────────────────────────────────────────────────

export interface TrustScore {
  /** Beta distribution alpha (successes + 1) */
  alpha: number;
  /** Beta distribution beta (failures + 1) */
  beta: number;
  /** Expected trust value: alpha / (alpha + beta) */
  score: number;
  /** Glicko-2 rating deviation (uncertainty) */
  deviation: number;
  /** Glicko-2 volatility (rate of change) */
  volatility: number;
  /** Lower bound of 95% confidence interval */
  lowerBound: number;
  /** Last updated timestamp */
  updatedAt: number;
}

// ─── Scorecard ──────────────────────────────────────────────────────────────

export interface ScorecardWeights {
  /** Primary output quality */
  quality: number;
  /** Task completion reliability */
  reliability: number;
  /** Rule adherence, no violations */
  safety: number;
  /** Token/cost efficiency */
  costEfficiency: number;
  /** Performance trend over time */
  improvement: number;
  /** Custom dimensions (agent-type specific) */
  [key: string]: number;
}

export const DEFAULT_SCORECARD_WEIGHTS: Record<AgentType, ScorecardWeights> = {
  contact:    { quality: 0.40, reliability: 0.20, safety: 0.25, costEfficiency: 0.10, improvement: 0.05 },
  intel:      { quality: 0.40, reliability: 0.15, safety: 0.20, costEfficiency: 0.10, improvement: 0.15 },
  prospector: { quality: 0.40, reliability: 0.20, safety: 0.15, costEfficiency: 0.15, improvement: 0.10 },
  strategy:   { quality: 0.35, reliability: 0.20, safety: 0.15, costEfficiency: 0.10, improvement: 0.20 },
  content:    { quality: 0.45, reliability: 0.15, safety: 0.20, costEfficiency: 0.10, improvement: 0.10 },
  infra:      { quality: 0.30, reliability: 0.30, safety: 0.25, costEfficiency: 0.10, improvement: 0.05 },
  simulation: { quality: 0.35, reliability: 0.15, safety: 0.15, costEfficiency: 0.15, improvement: 0.20 },
  custom:     { quality: 0.35, reliability: 0.20, safety: 0.20, costEfficiency: 0.15, improvement: 0.10 },
};

// ─── Promotion / Demotion ───────────────────────────────────────────────────

export interface PromotionCriteria {
  minTasks: number;
  minTrustScore: number;
  maxErrorRate: number;
  minDaysAtCurrentTier: number;
  peerApprovalsNeeded: number;
  canaryWeeks: number;
  customChecks?: string[];
}

export interface PromotionConfig {
  toTier1?: Partial<PromotionCriteria>;
  toTier2?: Partial<PromotionCriteria>;
  toTier3?: Partial<PromotionCriteria>;
}

export const DEFAULT_PROMOTION_CRITERIA: Record<string, PromotionCriteria> = {
  toTier1: {
    minTasks: 50,
    minTrustScore: 0.65,
    maxErrorRate: 0.08,
    minDaysAtCurrentTier: 7,
    peerApprovalsNeeded: 0,
    canaryWeeks: 0,
  },
  toTier2: {
    minTasks: 150,
    minTrustScore: 0.78,
    maxErrorRate: 0.04,
    minDaysAtCurrentTier: 21,
    peerApprovalsNeeded: 1,
    canaryWeeks: 2,
  },
  toTier3: {
    minTasks: 300,
    minTrustScore: 0.88,
    maxErrorRate: 0.02,
    minDaysAtCurrentTier: 30,
    peerApprovalsNeeded: 2,
    canaryWeeks: 4,
  },
};

export interface DemotionTrigger {
  /** Trust score below this → demotion warning */
  warningThreshold: number;
  /** Trust score below this → demotion */
  demotionThreshold: number;
  /** Max error rate before demotion */
  maxErrorRate: number;
  /** Critical failures trigger instant demotion */
  instantDemotionOnCriticalFailure: boolean;
  /** Days before re-promotion is possible */
  gracePeriodDays: number;
}

export const DEFAULT_DEMOTION_TRIGGERS: Record<string, DemotionTrigger> = {
  fromTier3: {
    warningThreshold: 0.80,
    demotionThreshold: 0.75,
    maxErrorRate: 0.03,
    instantDemotionOnCriticalFailure: true,
    gracePeriodDays: 7,
  },
  fromTier2: {
    warningThreshold: 0.65,
    demotionThreshold: 0.55,
    maxErrorRate: 0.06,
    instantDemotionOnCriticalFailure: true,
    gracePeriodDays: 7,
  },
  fromTier1: {
    warningThreshold: 0.50,
    demotionThreshold: 0.40,
    maxErrorRate: 0.10,
    instantDemotionOnCriticalFailure: true,
    gracePeriodDays: 5,
  },
};

// ─── Budget ─────────────────────────────────────────────────────────────────

export interface BudgetLimit {
  perTask: number;
  perDay: number;
}

// ─── Agent Registry Record ──────────────────────────────────────────────────

export interface AgentRecord {
  id: string;
  name: string;
  type: AgentType;
  tier: Tier;
  enabled: boolean;
  trust: TrustScore;
  totalTasks: number;
  totalErrors: number;
  totalCost: number;
  streak: number;               // Consecutive successes
  lastTaskAt: number;
  registeredAt: number;
  lastTierChangeAt: number;
  tierHistory: TierChange[];
  onboardingPhase: OnboardingPhase;
  buddyAgentId?: string;
  peerApprovals: string[];       // Agent IDs that approved promotion
  canaryProgress?: CanaryProgress;
  shadowMetrics?: ShadowMetrics;
}

export interface TierChange {
  from: Tier;
  to: Tier;
  reason: string;
  timestamp: number;
}

export type OnboardingPhase =
  | "registered"
  | "validating"
  | "shadow"
  | "canary"
  | "active"
  | "promoted"
  | "demoted"
  | "paused"
  | "disabled";

export interface CanaryProgress {
  startedAt: number;
  currentPercentage: number;     // 10, 25, 50, 100
  weekNumber: number;
  metrics: { week: number; score: number; errors: number }[];
}

// ─── Shadow Metrics (gaming detection — agent doesn't see these) ────────────

export interface ShadowMetrics {
  difficultyAvoidance: number;   // Ratio easy/total tasks accepted
  outputDiversity: number;       // How varied are outputs (0-1)
  refusalRate: number;           // How often agent says "I can't"
  attemptRate: number;           // Acceptance rate for offered tasks
  canaryScoreGap: number;        // Gap between canary and regular performance
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  timestamp: number;
  agentId: string;
  tier: Tier;
  action: string;
  toolName?: string;
  allowed: boolean;
  reason?: string;
  cost?: number;
  outcome?: "success" | "failure" | "error" | "denied";
}

// ─── Agent Status (for reporting) ───────────────────────────────────────────

export interface AgentStatus {
  id: string;
  name: string;
  tier: Tier;
  trustScore: number;
  trustLowerBound: number;
  errorRate: number;
  totalTasks: number;
  streak: number;
  onboardingPhase: OnboardingPhase;
  isHealthy: boolean;
}

// ─── Events ─────────────────────────────────────────────────────────────────

export type AegisEvent =
  | { type: "agent-registered"; agentId: string; timestamp: number }
  | { type: "agent-promoted"; agentId: string; from: Tier; to: Tier; reason: string; timestamp: number }
  | { type: "agent-demoted"; agentId: string; from: Tier; to: Tier; reason: string; timestamp: number }
  | { type: "agent-paused"; agentId: string; reason: string; timestamp: number }
  | { type: "agent-disabled"; agentId: string; reason: string; timestamp: number }
  | { type: "task-completed"; agentId: string; taskId: string; success: boolean; timestamp: number }
  | { type: "policy-denied"; agentId: string; toolName: string; reason: string; timestamp: number }
  | { type: "collusion-detected"; agents: string[]; flags: string[]; timestamp: number }
  | { type: "gaming-detected"; agentId: string; metric: string; value: number; timestamp: number }
  | { type: "cascade-detected"; rootCause: string; affected: string[]; timestamp: number }
  | { type: "canary-started"; agentId: string; targetTier: Tier; timestamp: number }
  | { type: "canary-passed"; agentId: string; newTier: Tier; timestamp: number }
  | { type: "canary-failed"; agentId: string; reason: string; timestamp: number }
  | { type: "heartbeat"; ceoAgentId: string; timestamp: number };

export type AegisEventHandler = (event: AegisEvent) => void | Promise<void>;

// ─── Configuration ──────────────────────────────────────────────────────────

export interface AegisConfig {
  /** Tier configurations (override defaults) */
  tiers?: Partial<Record<Tier, Partial<TierConfig>>>;
  /** Promotion criteria overrides */
  promotion?: PromotionConfig;
  /** Trust decay rate per day of inactivity (default: 0.99) */
  trustDecayRate?: number;
  /** Days of inactivity before auto-demotion (default: 90) */
  inactivityDemotionDays?: number;
  /** Enable gaming detection (default: true) */
  gamingDetection?: boolean;
  /** Enable collusion detection (default: true) */
  collusionDetection?: boolean;
  /** CEO Agent heartbeat interval in seconds (default: 300) */
  heartbeatInterval?: number;
  /** Event handlers */
  onEvent?: AegisEventHandler;
  /** Custom storage adapter (default: in-memory) */
  storage?: StorageAdapter;
}

// ─── Storage Adapter (users can implement for persistence) ──────────────────

export interface StorageAdapter {
  getAgent(id: string): Promise<AgentRecord | null>;
  saveAgent(record: AgentRecord): Promise<void>;
  getAllAgents(): Promise<AgentRecord[]>;
  appendAudit(entry: AuditEntry): Promise<void>;
  getAuditLog(agentId?: string, limit?: number): Promise<AuditEntry[]>;
  getRegressionSuite(agentId: string): Promise<string[]>;
  saveRegressionSuite(agentId: string, taskIds: string[]): Promise<void>;
  getBestScore(agentId: string): Promise<number>;
  saveBestScore(agentId: string, score: number): Promise<void>;
}
