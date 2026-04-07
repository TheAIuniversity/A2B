/**
 * File-Based Storage Adapter — Persistent storage using JSON files
 *
 * Stores agent records and audit logs as JSON files on disk.
 * Suitable for single-server deployments.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "fs";
import { join } from "path";
import type { StorageAdapter, AgentRecord, AuditEntry } from "../types.js";

export class FileStorage implements StorageAdapter {
  private dir: string;

  constructor(dataDir: string = "./data/a2b") {
    this.dir = dataDir;
    const dirs = ["agents", "audit", "suites", "scores"];
    for (const d of dirs) {
      const p = join(this.dir, d);
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    }
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const path = join(this.dir, "agents", `${id}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  async saveAgent(record: AgentRecord): Promise<void> {
    const path = join(this.dir, "agents", `${record.id}.json`);
    writeFileSync(path, JSON.stringify(record, null, 2));
  }

  async getAllAgents(): Promise<AgentRecord[]> {
    const agentsDir = join(this.dir, "agents");
    if (!existsSync(agentsDir)) return [];
    return readdirSync(agentsDir)
      .filter(f => f.endsWith(".json"))
      .map(f => JSON.parse(readFileSync(join(agentsDir, f), "utf-8")));
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    const path = join(this.dir, "audit", "log.jsonl");
    appendFileSync(path, JSON.stringify(entry) + "\n");
  }

  async getAuditLog(agentId?: string, limit: number = 100): Promise<AuditEntry[]> {
    const path = join(this.dir, "audit", "log.jsonl");
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    let entries: AuditEntry[] = lines.map(l => JSON.parse(l));
    if (agentId) entries = entries.filter(e => e.agentId === agentId);
    return entries.slice(-limit);
  }

  async getRegressionSuite(agentId: string): Promise<string[]> {
    const path = join(this.dir, "suites", `${agentId}.json`);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  async saveRegressionSuite(agentId: string, taskIds: string[]): Promise<void> {
    const path = join(this.dir, "suites", `${agentId}.json`);
    writeFileSync(path, JSON.stringify(taskIds, null, 2));
  }

  async getBestScore(agentId: string): Promise<number> {
    const path = join(this.dir, "scores", `${agentId}.json`);
    if (!existsSync(path)) return 0;
    return JSON.parse(readFileSync(path, "utf-8")).bestScore ?? 0;
  }

  async saveBestScore(agentId: string, score: number): Promise<void> {
    const path = join(this.dir, "scores", `${agentId}.json`);
    writeFileSync(path, JSON.stringify({ bestScore: score, updatedAt: Date.now() }));
  }
}
