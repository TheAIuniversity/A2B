/**
 * In-Memory Storage Adapter — Default storage for development and testing
 *
 * For production, implement StorageAdapter with your preferred backend:
 * - File-based (JSON files)
 * - SQLite
 * - PostgreSQL
 * - Redis
 */

import type { StorageAdapter, AgentRecord, AuditEntry } from "../types.js";

export class MemoryStorage implements StorageAdapter {
  private agents: Map<string, AgentRecord> = new Map();
  private audit: AuditEntry[] = [];
  private suites: Map<string, string[]> = new Map();
  private bestScores: Map<string, number> = new Map();

  async getAgent(id: string): Promise<AgentRecord | null> {
    return this.agents.get(id) ?? null;
  }

  async saveAgent(record: AgentRecord): Promise<void> {
    this.agents.set(record.id, { ...record });
  }

  async getAllAgents(): Promise<AgentRecord[]> {
    return Array.from(this.agents.values());
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(entry);
    // Keep last 10,000 entries in memory
    if (this.audit.length > 10000) {
      this.audit = this.audit.slice(-10000);
    }
  }

  async getAuditLog(agentId?: string, limit: number = 100): Promise<AuditEntry[]> {
    let entries = agentId
      ? this.audit.filter(e => e.agentId === agentId)
      : this.audit;
    return entries.slice(-limit);
  }

  async getRegressionSuite(agentId: string): Promise<string[]> {
    return this.suites.get(agentId) ?? [];
  }

  async saveRegressionSuite(agentId: string, taskIds: string[]): Promise<void> {
    this.suites.set(agentId, [...taskIds]);
  }

  async getBestScore(agentId: string): Promise<number> {
    return this.bestScores.get(agentId) ?? 0;
  }

  async saveBestScore(agentId: string, score: number): Promise<void> {
    this.bestScores.set(agentId, score);
  }
}
