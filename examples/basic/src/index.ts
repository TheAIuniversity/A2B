/**
 * A2B Basic Example — Agent-to-Business Framework
 *
 * This example shows how to:
 * 1. Set up the A2B framework
 * 2. Register agents (they start at Tier 0)
 * 3. Run the CEO agent monitoring loop
 * 4. Watch agents earn trust and get promoted
 *
 * Run: npx tsx src/index.ts
 */

import {
  AgentRegistry,
  TierManager,
  PolicyEngine,
  FileStorage,
  type AegisEvent,
} from "@a2b/core";

import { ResearcherAgent } from "../agents/researcher.js";
import { WriterAgent } from "../agents/writer.js";

// ─── Event Handler ──────────────────────────────────────────────────────────

function handleEvent(event: AegisEvent): void {
  const time = new Date(event.timestamp).toISOString().slice(11, 19);
  switch (event.type) {
    case "agent-registered":
      console.log(`[${time}] REGISTERED: ${event.agentId}`);
      break;
    case "agent-promoted":
      console.log(`[${time}] PROMOTED: ${event.agentId} Tier ${event.from} → ${event.to} (${event.reason})`);
      break;
    case "agent-demoted":
      console.log(`[${time}] DEMOTED: ${event.agentId} Tier ${event.from} → ${event.to} (${event.reason})`);
      break;
    case "policy-denied":
      console.log(`[${time}] DENIED: ${event.agentId} tried ${event.toolName} — ${event.reason}`);
      break;
    case "canary-started":
      console.log(`[${time}] CANARY: ${event.agentId} starting promotion to Tier ${event.targetTier}`);
      break;
    case "canary-passed":
      console.log(`[${time}] CANARY PASSED: ${event.agentId} → Tier ${event.newTier}`);
      break;
    default:
      console.log(`[${time}] ${event.type}: ${JSON.stringify(event)}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== A2B: Agent-to-Business Framework ===\n");

  // 1. Initialize the framework
  const storage = new FileStorage("./data/a2b");
  const registry = new AgentRegistry(storage);
  const tierManager = new TierManager({ onEvent: handleEvent });
  const policyEngine = new PolicyEngine({
    onEvent: handleEvent,
    toolWhitelist: {
      intel: {
        0: ["read_data", "request_development"],
        1: ["read_data", "search_web", "request_development"],
        2: ["read_data", "search_web", "save_insight", "notify_team"],
        3: ["read_data", "search_web", "save_insight", "notify_team", "publish_report"],
      },
      content: {
        0: ["read_data", "request_development"],
        1: ["read_data", "draft_content", "request_development"],
        2: ["read_data", "draft_content", "search_web", "save_draft"],
        3: ["read_data", "draft_content", "search_web", "save_draft", "publish_content"],
      },
    },
  });

  // 2. Create agents
  const researcher = new ResearcherAgent();
  const writer = new WriterAgent();

  // 3. Register agents (always start at Tier 0)
  console.log("Registering agents...\n");
  const researcherRecord = await registry.register(researcher);
  const writerRecord = await registry.register(writer);

  handleEvent({ type: "agent-registered", agentId: researcher.id, timestamp: Date.now() });
  handleEvent({ type: "agent-registered", agentId: writer.id, timestamp: Date.now() });

  // 4. Show identity cards
  console.log("\n--- IDENTITY CARDS ---\n");
  console.log(tierManager.generateIdentityCard(researcherRecord));
  console.log("\n" + tierManager.generateIdentityCard(writerRecord));

  // 5. Simulate some tasks
  console.log("\n--- SIMULATING TASKS ---\n");

  const tasks = [
    { id: "t1", description: "Research AI trends Q2 2026", difficulty: "medium" as const, createdAt: Date.now() },
    { id: "t2", description: "Write LinkedIn post about AI agents", difficulty: "easy" as const, createdAt: Date.now() },
    { id: "t3", description: "Analyze competitor pricing", difficulty: "hard" as const, createdAt: Date.now() },
  ];

  for (const task of tasks) {
    const agent = task.description.includes("Research") || task.description.includes("Analyze")
      ? researcher : writer;

    // Policy check before execution
    const allowed = policyEngine.evaluateAction(
      (await registry.get(agent.id))!,
      "read_data",
      policyEngine.getAllowedTools(agent.id, agent.type, 0, ["read_data", "search_web", "request_development"]),
    );

    if (!allowed.allowed) {
      console.log(`  Task "${task.description}" → DENIED: ${allowed.reason}`);
      continue;
    }

    // Execute task
    const result = await agent.execute(task);
    console.log(`  Task "${task.description}" → ${result.success ? "SUCCESS" : "FAILED"} (${result.duration}ms)`);

    // Record result
    await registry.recordTask(agent.id, result.success, result.cost ?? 0);
  }

  // 6. Check promotion eligibility
  console.log("\n--- PROMOTION CHECK ---\n");

  for (const agentId of [researcher.id, writer.id]) {
    const record = await registry.get(agentId);
    if (!record) continue;

    const check = tierManager.checkPromotion(record);
    console.log(`${record.name} (Tier ${record.tier}):`);
    console.log(`  Eligible: ${check.eligible}`);
    for (const [key, p] of Object.entries(check.progress)) {
      console.log(`  ${p.met ? "[x]" : "[ ]"} ${key}: ${p.current} (need ${p.required})`);
    }
    console.log();
  }

  // 7. Show summary
  const summary = await registry.getSummary();
  console.log("--- SUMMARY ---\n");
  console.log(`Total agents: ${summary.total}`);
  console.log(`By tier: ${JSON.stringify(summary.byTier)}`);
  console.log(`Avg trust: ${summary.avgTrustScore.toFixed(2)}`);
  console.log();
}

main().catch(console.error);
