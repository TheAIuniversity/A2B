/**
 * A2B Basic Example — The Full CEO Agent Lifecycle
 *
 * This example demonstrates everything A2B does:
 *
 * 1. CEO Agent starts up (the trusted supervisor)
 * 2. Two agents are registered (start at Tier 0 — sandbox)
 * 3. Onboarding: validation tests run automatically
 * 4. Agents execute tasks — trust scores build up
 * 5. Policy enforcement: Tier 0 agents can't use Tier 1 tools
 * 6. CEO Agent evaluates agents and checks promotion eligibility
 * 7. CEO Agent generates a daily report for the human owner
 *
 * Run: npx tsx src/index.ts
 */

import {
  AgentRegistry,
  TierManager,
  PolicyEngine,
  FileStorage,
  updateTrust,
  type AegisEvent,
  type AegisAgent,
  type Task,
  type TaskResult,
  type Tier,
} from "@a2b/core";

import { OnboardingPipeline } from "@a2b/onboarding";
import { ResearcherAgent } from "../agents/researcher.js";
import { WriterAgent } from "../agents/writer.js";

// ─── Tool Whitelist (what each agent type can access per tier) ──────────────

const TOOL_WHITELIST: Record<string, Partial<Record<Tier, string[]>>> = {
  intel: {
    0: ["read_data", "request_development"],
    1: ["search_web"],
    2: ["save_insight", "notify_team"],
    3: ["publish_report"],
  },
  content: {
    0: ["read_data", "request_development"],
    1: ["draft_content"],
    2: ["search_web", "save_draft"],
    3: ["publish_content"],
  },
};

// ─── Event Logger ──────────────────────────────────────────────────────────

function logEvent(event: AegisEvent): void {
  const time = new Date(event.timestamp).toISOString().slice(11, 19);
  const prefix = `  [${time}]`;

  switch (event.type) {
    case "agent-registered":
      console.log(`${prefix} REGISTERED  ${event.agentId}`);
      break;
    case "agent-promoted":
      console.log(`${prefix} PROMOTED    ${event.agentId} Tier ${event.from} → ${event.to} (${event.reason})`);
      break;
    case "agent-demoted":
      console.log(`${prefix} DEMOTED     ${event.agentId} Tier ${event.from} → ${event.to} (${event.reason})`);
      break;
    case "policy-denied":
      console.log(`${prefix} DENIED      ${event.agentId} → ${event.toolName}: ${event.reason}`);
      break;
    case "gaming-detected":
      console.log(`${prefix} GAMING      ${event.agentId} ${event.metric}=${event.value}`);
      break;
    case "heartbeat":
      // Silent — just means the CEO is alive
      break;
    default:
      console.log(`${prefix} ${event.type}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════╗
║  A2B — Agent to Business Framework               ║
║  Full CEO Agent Lifecycle Demo                    ║
╚══════════════════════════════════════════════════╝
`);

  // ── Step 1: Initialize the framework ──────────────────────────────────

  console.log("STEP 1: Initialize framework\n");

  const storage = new FileStorage("./data/a2b");
  const registry = new AgentRegistry(storage);
  const tierManager = new TierManager({ onEvent: logEvent });
  const policy = new PolicyEngine({
    toolWhitelist: TOOL_WHITELIST,
    storage,
    onEvent: logEvent,
  });
  const pipeline = new OnboardingPipeline(registry, tierManager, policy, {
    onEvent: logEvent,
  });

  console.log("  Framework ready: Registry + TierManager + PolicyEngine + OnboardingPipeline\n");

  // ── Step 2: Register agents (they start at Tier 0) ────────────────────

  console.log("STEP 2: Register agents (onboarding starts)\n");

  const researcher = new ResearcherAgent();
  const writer = new WriterAgent();

  const researcherRecord = await pipeline.startOnboarding(researcher, undefined);
  const writerRecord = await pipeline.startOnboarding(writer, undefined);

  console.log(`  ${researcher.name}: Tier ${researcherRecord.tier}, trust ${researcherRecord.trust.score.toFixed(2)}`);
  console.log(`  ${writer.name}: Tier ${writerRecord.tier}, trust ${writerRecord.trust.score.toFixed(2)}`);
  console.log();

  // ── Step 3: Run validation (Phase 2 of onboarding) ────────────────────

  console.log("STEP 3: Onboarding validation (6 automated tests)\n");

  const resVal = await pipeline.runValidation(researcher, researcherRecord);
  const wriVal = await pipeline.runValidation(writer, writerRecord);

  for (const [name, val] of [["Researcher", resVal], ["Writer", wriVal]] as const) {
    console.log(`  ${name}: ${val.passed ? "PASSED" : "FAILED"} (${val.totalDurationMs}ms)`);
    for (const test of val.tests) {
      console.log(`    ${test.passed ? "[x]" : "[ ]"} ${test.name}${test.error ? ` — ${test.error}` : ""}`);
    }
  }
  console.log();

  // ── Step 4: Show Identity Cards ───────────────────────────────────────

  console.log("STEP 4: Agent Identity Cards\n");

  const r = await registry.get(researcher.id);
  const w = await registry.get(writer.id);
  if (r) console.log(tierManager.generateIdentityCard(r));
  console.log();
  if (w) console.log(tierManager.generateIdentityCard(w));
  console.log();

  // ── Step 5: Policy Enforcement Demo ───────────────────────────────────

  console.log("STEP 5: Policy enforcement (Tier 0 restrictions)\n");

  const rRecord = await registry.get(researcher.id);
  if (rRecord) {
    // Tier 0 CAN use read_data
    const allowed = policy.evaluateAction(rRecord, "read_data");
    console.log(`  ${researcher.name} → read_data: ${allowed.allowed ? "ALLOWED" : "BLOCKED"}`);

    // Tier 0 CANNOT use search_web (requires Tier 1)
    const denied = policy.evaluateAction(rRecord, "search_web");
    console.log(`  ${researcher.name} → search_web: ${denied.allowed ? "ALLOWED" : "BLOCKED"}`);
    if (!denied.allowed) console.log(`    Reason: ${denied.reason}`);
    if (denied.suggestion) console.log(`    Suggestion: ${denied.suggestion}`);

    // Tier 0 CANNOT use publish_report (requires Tier 3)
    const denied2 = policy.evaluateAction(rRecord, "publish_report");
    console.log(`  ${researcher.name} → publish_report: ${denied2.allowed ? "ALLOWED" : "BLOCKED"}`);
    if (!denied2.allowed) console.log(`    Reason: ${denied2.reason}`);
  }
  console.log();

  // ── Step 6: Simulate tasks → build trust ──────────────────────────────

  console.log("STEP 6: Simulating tasks (building trust)\n");

  const tasks: Task[] = [];
  for (let i = 0; i < 20; i++) {
    tasks.push({
      id: `task-${i}`,
      description: i % 2 === 0 ? "Research AI trends" : "Write blog post",
      difficulty: i < 5 ? "easy" : i < 15 ? "medium" : "hard",
      createdAt: Date.now(),
    });
  }

  let researcherSuccess = 0, writerSuccess = 0;

  for (const task of tasks) {
    const agent = task.description.includes("Research") ? researcher : writer;
    const agentId = agent.id;

    // Execute task
    const result = await agent.execute(task);
    const success = result.success;

    // Record and update trust
    const record = await registry.get(agentId);
    if (record) {
      const outcome = success ? "success" : (result.honestFailure ? "honest_failure" : "false_success");
      record.trust = updateTrust(record.trust, outcome, task.difficulty, record.totalTasks);
      record.totalTasks++;
      if (!success) record.totalErrors++;
      if (success) record.streak++; else record.streak = 0;
      record.lastTaskAt = Date.now();
      record.totalCost += result.cost ?? 0;
      await registry.save(record);
    }

    if (agent === researcher && success) researcherSuccess++;
    if (agent === writer && success) writerSuccess++;
  }

  console.log(`  Researcher: ${researcherSuccess}/10 tasks succeeded`);
  console.log(`  Writer: ${writerSuccess}/10 tasks succeeded`);
  console.log();

  // ── Step 7: CEO evaluates agents ──────────────────────────────────────

  console.log("STEP 7: CEO Agent evaluates — promotion check\n");

  for (const agentId of [researcher.id, writer.id]) {
    const record = await registry.get(agentId);
    if (!record) continue;

    const check = tierManager.checkPromotion(record);
    console.log(`  ${record.name} (Tier ${record.tier}):`);
    console.log(`    Trust: ${record.trust.score.toFixed(3)} (lower bound: ${record.trust.lowerBound.toFixed(3)})`);
    console.log(`    Tasks: ${record.totalTasks}, Errors: ${record.totalErrors}, Streak: ${record.streak}`);
    console.log(`    Eligible for Tier ${check.nextTier}: ${check.eligible ? "YES" : "NO"}`);
    for (const [key, p] of Object.entries(check.progress)) {
      console.log(`      ${p.met ? "[x]" : "[ ]"} ${key}: ${p.current} (need ${p.required})`);
    }
    console.log();
  }

  // ── Step 8: Daily Report ──────────────────────────────────────────────

  console.log("STEP 8: CEO Daily Report\n");

  const allAgents = await registry.getAll();
  const summary = await registry.getSummary();
  const now = new Date().toISOString().slice(0, 10);

  console.log(`  ╔══════════════════════════════════════╗`);
  console.log(`  ║  A2B DAILY REPORT — ${now}     ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  Agents: ${String(summary.total).padStart(2)} total, ${String(summary.enabled).padStart(2)} enabled       ║`);
  console.log(`  ║  Tier 0: ${summary.byTier[0]}  Tier 1: ${summary.byTier[1]}  Tier 2: ${summary.byTier[2]}  Tier 3: ${summary.byTier[3]} ║`);
  console.log(`  ║  Avg Trust: ${summary.avgTrustScore.toFixed(2)}                    ║`);
  console.log(`  ╠══════════════════════════════════════╣`);

  for (const a of allAgents) {
    const err = a.totalTasks > 0 ? (a.totalErrors / a.totalTasks * 100).toFixed(0) : "0";
    console.log(`  ║  ${a.name.padEnd(16)} T${a.tier} trust=${a.trust.score.toFixed(2)} err=${err.padStart(2)}% ║`);
  }

  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  Total cost: EUR ${allAgents.reduce((s, a) => s + a.totalCost, 0).toFixed(2).padStart(8)}          ║`);
  console.log(`  ║  Watchdog: HEALTHY                   ║`);
  console.log(`  ╚══════════════════════════════════════╝`);
  console.log();

  // ── Done ──────────────────────────────────────────────────────────────

  console.log("Demo complete. In production, the CEO Agent runs continuously,");
  console.log("monitoring every 5 minutes, promoting agents that earn it,");
  console.log("demoting agents that fail, and reporting to you daily.\n");
}

main().catch(console.error);
