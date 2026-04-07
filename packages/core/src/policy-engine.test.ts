import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine, validateAgentId } from "./policy-engine.js";
import { AgentRegistry } from "./registry.js";
import { createTrustScore } from "./trust-score.js";
import type { AgentRecord, Tier } from "./types.js";

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-agent",
    name: "Test Agent",
    type: "intel",
    tier: 0 as Tier,
    enabled: true,
    trust: createTrustScore(),
    totalTasks: 0,
    totalErrors: 0,
    totalCost: 0,
    streak: 0,
    lastTaskAt: 0,
    registeredAt: Date.now(),
    lastTierChangeAt: Date.now(),
    tierHistory: [],
    onboardingPhase: "active",
    peerApprovals: [],
    ...overrides,
  };
}

describe("PolicyEngine", () => {
  const whitelist = {
    intel: {
      0: ["read_data", "request_development"],
      1: ["read_data", "search_web", "request_development"],
      2: ["read_data", "search_web", "save_insight", "notify_team"],
      3: ["read_data", "search_web", "save_insight", "notify_team", "publish_report"],
    } as Record<Tier, string[]>,
  };

  describe("Tool enforcement (audit fix C-1)", () => {
    it("Tier 0 agent CANNOT use Tier 1 tools", () => {
      const engine = new PolicyEngine({ toolWhitelist: whitelist });
      const agent = makeRecord({ tier: 0 as Tier });
      const result = engine.evaluateAction(agent, "search_web");
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes("requires Tier 1"), result.reason);
    });

    it("Tier 1 agent CAN use Tier 0 + Tier 1 tools (inheritance)", () => {
      const engine = new PolicyEngine({ toolWhitelist: whitelist });
      const agent = makeRecord({ tier: 1 as Tier });

      const r1 = engine.evaluateAction(agent, "read_data");
      assert.equal(r1.allowed, true, "Should access Tier 0 tool");

      const r2 = engine.evaluateAction(agent, "search_web");
      assert.equal(r2.allowed, true, "Should access Tier 1 tool");
    });

    it("Tier 0 agent CANNOT use Tier 3 tools", () => {
      const engine = new PolicyEngine({ toolWhitelist: whitelist });
      const agent = makeRecord({ tier: 0 as Tier });
      const result = engine.evaluateAction(agent, "publish_report");
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes("Tier 3"), result.reason);
    });

    it("Unknown agent type gets NO tools (safe default)", () => {
      const engine = new PolicyEngine({ toolWhitelist: whitelist });
      const agent = makeRecord({ type: "unknown_type" });
      const result = engine.evaluateAction(agent, "read_data");
      assert.equal(result.allowed, false);
    });

    it("PolicyEngine OWNS the whitelist — caller cannot inject tools", () => {
      const engine = new PolicyEngine({ toolWhitelist: whitelist });
      // evaluateAction now only takes (agent, toolName) — no allowedTools param
      // This is the fix: the caller cannot pass arbitrary tool lists
      const agent = makeRecord({ tier: 0 as Tier });
      const result = engine.evaluateAction(agent, "publish_report");
      assert.equal(result.allowed, false, "Cannot bypass by injecting tools");
    });
  });

  describe("Budget enforcement", () => {
    it("blocks when daily budget exceeded", () => {
      const engine = new PolicyEngine({ toolWhitelist: whitelist });
      const agent = makeRecord({ tier: 0 as Tier });

      // Exhaust budget: Tier 0 = €1.00/day
      for (let i = 0; i < 25; i++) {
        engine.recordAction({
          timestamp: Date.now(), agentId: agent.id, tier: agent.tier,
          action: "tool_call", cost: 0.05, allowed: true,
        });
      }
      // €1.25 spent, limit is €1.00
      const result = engine.evaluateAction(agent, "read_data");
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes("budget"), result.reason);
    });
  });

  describe("Atomic evaluateAndStart (audit fix H-6)", () => {
    it("increments task count atomically on allow", () => {
      const engine = new PolicyEngine({ toolWhitelist: whitelist });
      const agent = makeRecord({ tier: 0 as Tier });
      const result = engine.evaluateAndStart(agent, "read_data");
      assert.equal(result.allowed, true);
      // Second call should still work (Tier 0 max concurrent = 1... but this is the first)
      // The counter is now 1, max is 1, so next should fail
      const result2 = engine.evaluateAndStart(agent, "read_data");
      assert.equal(result2.allowed, false);
      assert.ok(result2.reason.includes("concurrent"), result2.reason);
    });
  });

  describe("Audit log integrity (audit fix C-4)", () => {
    it("entries are frozen (immutable)", () => {
      const engine = new PolicyEngine({ toolWhitelist: whitelist });
      const entry = engine.recordAction({
        timestamp: Date.now(), agentId: "test", tier: 0 as Tier,
        action: "test", allowed: true,
      });
      assert.ok(Object.isFrozen(entry), "Audit entries must be frozen");
    });

    it("entry IDs are UUID format (not Math.random)", () => {
      const engine = new PolicyEngine({ toolWhitelist: whitelist });
      const entry = engine.recordAction({
        timestamp: Date.now(), agentId: "test", tier: 0 as Tier,
        action: "test", allowed: true,
      });
      // UUID v4 format: 8-4-4-4-12 hex chars
      assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.id),
        `ID should be UUID, got: ${entry.id}`);
    });
  });
});

describe("Agent ID Validation (audit fix C-3)", () => {
  it("allows valid IDs", () => {
    assert.doesNotThrow(() => validateAgentId("my-agent"));
    assert.doesNotThrow(() => validateAgentId("agent_01"));
    assert.doesNotThrow(() => validateAgentId("AgentX"));
  });

  it("rejects path traversal", () => {
    assert.throws(() => validateAgentId("../../etc/passwd"), /Invalid agent ID/);
    assert.throws(() => validateAgentId("../secret"), /Invalid agent ID/);
  });

  it("rejects dots", () => {
    assert.throws(() => validateAgentId("agent.evil"), /Invalid agent ID/);
  });

  it("rejects empty and too-long IDs", () => {
    assert.throws(() => validateAgentId(""), /Invalid agent ID/);
    assert.throws(() => validateAgentId("a".repeat(65)), /Invalid agent ID/);
  });

  it("rejects special characters", () => {
    assert.throws(() => validateAgentId("agent/x"), /Invalid agent ID/);
    assert.throws(() => validateAgentId("agent@evil"), /Invalid agent ID/);
    assert.throws(() => validateAgentId("agent x"), /Invalid agent ID/);
  });
});

describe("AgentRegistry (audit fix C-2)", () => {
  it("get() returns deep copy — mutation does not affect registry", async () => {
    const registry = new AgentRegistry();
    const agent = { id: "test-deep", name: "Test", type: "intel" as const, execute: async () => ({ success: true }) };
    await registry.register(agent);

    const record = await registry.get("test-deep");
    assert.ok(record);
    (record as any).tier = 3; // Try to escalate privileges

    const fresh = await registry.get("test-deep");
    assert.equal(fresh!.tier, 0, "Registry should still show Tier 0, not the mutated Tier 3");
  });

  it("save() rejects tier jumps > 1", async () => {
    const registry = new AgentRegistry();
    const agent = { id: "test-jump", name: "Test", type: "intel" as const, execute: async () => ({ success: true }) };
    await registry.register(agent);

    const record = await registry.get("test-jump");
    assert.ok(record);
    record.tier = 3 as Tier; // Try to jump from 0 to 3

    await assert.rejects(
      () => registry.save(record),
      /Invalid tier transition/
    );
  });

  it("register() rejects path-traversal agent IDs", async () => {
    const registry = new AgentRegistry();
    const evil = { id: "../../etc/passwd", name: "Evil", type: "intel" as const, execute: async () => ({ success: true }) };

    await assert.rejects(
      () => registry.register(evil),
      /Invalid agent ID/
    );
  });

  it("register() rejects duplicate IDs", async () => {
    const registry = new AgentRegistry();
    const agent = { id: "dupe", name: "Test", type: "intel" as const, execute: async () => ({ success: true }) };
    await registry.register(agent);

    await assert.rejects(
      () => registry.register(agent),
      /already registered/
    );
  });
});
