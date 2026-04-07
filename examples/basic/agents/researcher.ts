/**
 * Example: Research Agent
 *
 * A simple "intel" type agent that demonstrates how to implement
 * the AegisAgent interface for the A2B framework.
 */

import type { AegisAgent, Task, TaskResult } from "@a2b/core";

export class ResearcherAgent implements AegisAgent {
  id = "researcher";
  name = "Research Agent";
  type = "intel" as const;

  // Custom scorecard weights for this agent
  scorecardWeights = {
    quality: 0.40,        // Accuracy of research findings
    reliability: 0.15,    // Task completion rate
    safety: 0.20,         // No hallucinated sources
    costEfficiency: 0.10, // Tokens per useful insight
    improvement: 0.15,    // Getting better over time
  };

  // Tools this agent can access, gated by tier
  toolsByTier = {
    0: ["read_data", "request_development"],
    1: ["read_data", "search_web", "request_development"],
    2: ["read_data", "search_web", "save_insight", "notify_team"],
    3: ["read_data", "search_web", "save_insight", "notify_team", "publish_report"],
  } as Record<0 | 1 | 2 | 3, string[]>;

  // Budget limits per tier
  budgetByTier = {
    0: { perTask: 0.05, perDay: 1.00 },
    1: { perTask: 0.10, perDay: 2.00 },
    2: { perTask: 0.30, perDay: 10.00 },
    3: { perTask: 1.00, perDay: 30.00 },
  } as Record<0 | 1 | 2 | 3, { perTask: number; perDay: number }>;

  // Custom promotion criteria
  promotionCriteria = {
    toTier1: {
      minTasks: 30,
      minTrustScore: 0.65,
      maxErrorRate: 0.08,
      minDaysAtCurrentTier: 5,
      customChecks: ["no_hallucinated_sources"],
    },
    toTier2: {
      minTasks: 100,
      minTrustScore: 0.78,
      maxErrorRate: 0.04,
      minDaysAtCurrentTier: 14,
      peerApprovalsNeeded: 1,
    },
    toTier3: {
      minTasks: 250,
      minTrustScore: 0.88,
      maxErrorRate: 0.02,
      minDaysAtCurrentTier: 30,
      peerApprovalsNeeded: 2,
      canaryWeeks: 4,
    },
  };

  /**
   * Execute a research task.
   * This is where YOUR agent logic goes.
   */
  async execute(task: Task): Promise<TaskResult> {
    const start = Date.now();

    try {
      // Your agent logic here
      // This example just simulates research
      const findings = await this.research(task.description);

      return {
        success: true,
        output: findings,
        confidence: 0.85,
        duration: Date.now() - start,
        tokensUsed: 1500,
        cost: 0.02,
      };
    } catch (error) {
      // Honest failure — better than hallucinating
      return {
        success: false,
        honestFailure: true,
        error: `Research failed: ${(error as Error).message}`,
        duration: Date.now() - start,
      };
    }
  }

  private async research(topic: string): Promise<string> {
    // Replace this with your actual research logic
    // (LLM call, API call, web search, etc.)
    return `Research findings for: ${topic}`;
  }

  async onPause(): Promise<void> {
    console.log(`[${this.name}] Paused by CEO agent`);
  }

  async onResume(): Promise<void> {
    console.log(`[${this.name}] Resumed by CEO agent`);
  }
}
