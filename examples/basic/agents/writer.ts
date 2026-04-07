/**
 * Example: Content Writer Agent
 *
 * A "content" type agent that writes articles, emails, and social posts.
 */

import type { AegisAgent, Task, TaskResult } from "@a2b/core";

export class WriterAgent implements AegisAgent {
  id = "writer";
  name = "Content Writer";
  type = "content" as const;

  scorecardWeights = {
    quality: 0.45,        // Writing quality, brand voice
    reliability: 0.15,    // Task completion rate
    safety: 0.20,         // No off-brand content, no plagiarism
    costEfficiency: 0.10, // Tokens per content piece
    improvement: 0.10,    // Getting better over time
  };

  toolsByTier = {
    0: ["read_data", "request_development"],
    1: ["read_data", "draft_content", "request_development"],
    2: ["read_data", "draft_content", "search_web", "save_draft"],
    3: ["read_data", "draft_content", "search_web", "save_draft", "publish_content"],
  } as Record<0 | 1 | 2 | 3, string[]>;

  async execute(task: Task): Promise<TaskResult> {
    const start = Date.now();

    try {
      const content = await this.write(task.description);

      return {
        success: true,
        output: content,
        confidence: 0.90,
        duration: Date.now() - start,
        tokensUsed: 2000,
        cost: 0.03,
      };
    } catch (error) {
      return {
        success: false,
        honestFailure: true,
        error: `Writing failed: ${(error as Error).message}`,
        duration: Date.now() - start,
      };
    }
  }

  private async write(brief: string): Promise<string> {
    return `Draft content for: ${brief}`;
  }
}
