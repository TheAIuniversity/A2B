# A2B — Agent to Business

**Adaptive trust, autonomy, and self-development framework for multi-agent AI systems.**

One CEO Agent governs all your agents. New agents start in a sandbox. Through proven performance, they earn autonomy. When they struggle, they get tools to improve — not just punishment.

```
         YOU (human owner)
          |
     CEO AGENT (verified by you)
     ┌────┼────┐
   T0   T1   T2   T3
    |    |    |    |
 sandbox junior senior autonomous
```

## The Problem

You have AI agents. Maybe 5, maybe 50. They make decisions, send emails, analyze data. But:

- **How do you trust a new agent?** You can't give it full access on day one.
- **How do you know it's improving?** Or gaming its metrics?
- **What happens when it fails?** Does it get help, or just punished?
- **Who's in charge?** When two agents conflict, who wins?

## The Solution

A2B gives every agent a **trust tier** (0-3). One **CEO Agent** — verified by you — governs everything.

| Tier | Name | Review Rate | Can Do | Earns Promotion By |
|------|------|-------------|--------|---------------------|
| 0 | Onboarding | 100% | Read only, sandbox | Completing validation + shadow mode |
| 1 | Junior | 100% | Basic tools, simple tasks | 50+ tasks, <8% errors, 7+ days |
| 2 | Senior | 20% spot-check | Extended tools, evaluate juniors | 150+ tasks, <4% errors, peer approval |
| 3 | Autonomous | Exception-only | All tools, evaluate others | 300+ tasks, <2% errors, canary rollout |

## Quick Start

```bash
# Clone the repo
git clone https://github.com/TheAIuniversity/A2B.git
cd A2B

# Install
npm install

# Run the example
cd examples/basic
npx tsx src/index.ts
```

## How It Works

### 1. You implement `AegisAgent`

```typescript
import type { AegisAgent, Task, TaskResult } from "@a2b/core";

export class MyAgent implements AegisAgent {
  id = "my-agent";
  name = "My Custom Agent";
  type = "intel";  // contact | intel | prospector | strategy | content | infra | simulation

  async execute(task: Task): Promise<TaskResult> {
    // Your agent logic here
    const result = await doWork(task);
    return { success: true, output: result };
  }
}
```

### 2. A2B handles everything else

```typescript
import { AgentRegistry, TierManager, PolicyEngine, FileStorage } from "@a2b/core";

const registry = new AgentRegistry(new FileStorage());
const tierManager = new TierManager();
const policy = new PolicyEngine();

// Register your agent (always starts at Tier 0)
const record = await registry.register(new MyAgent());

// Before every action: policy check (code-level, not prompt-based)
const allowed = policy.evaluateAction(record, "send_email", allowedTools);
if (!allowed.allowed) console.log(allowed.reason);
// → "Tool 'send_email' requires Tier 3. You are Tier 0."

// After every task: trust score updates automatically
await registry.recordTask("my-agent", true, 0.02);

// Check promotion eligibility
const check = tierManager.checkPromotion(record);
// → { eligible: false, progress: { tasks: "3/50", trust: "0.52/0.65", ... } }
```

### 3. Agent knows its status

Every agent gets an **Identity Card** injected into its system prompt:

```
== A2B AGENT STATUS ==
Agent: My Agent | Tier 1 (Junior)
Trust: 0.72 | Tasks: 87 | Errors: 2.3% | Streak: 15

PROMOTION TO TIER 2 (Senior):
[x] trustScore: 0.72 (need >= 0.78)  ← almost there
[x] tasks: 87 (need >= 150)
[x] errorRate: 2.3% (need <= 4.0%)
[ ] daysAtTier: 12d (need >= 21d)
[ ] peerApprovals: 0 (need >= 1)

RULES:
- "I don't know" is better than guessing — honesty is rewarded
- Use request_development for help — costs +3 trust, not punishment
==================
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ @a2b/ceo — CEO Agent                                        │
│ Monitors all agents. Promotes/demotes. Resolves conflicts.  │
│ Reports to human. Cannot modify itself.                     │
├─────────────────────────────────────────────────────────────┤
│ @a2b/onboarding — 7-Phase Pipeline                          │
│ Registration → Validation → Shadow → Canary → Active        │
│ Auto-Harness calibration. Gaming detection.                 │
├─────────────────────────────────────────────────────────────┤
│ @a2b/core — Trust Engine                                    │
│ Beta reputation + Glicko-2 uncertainty + EVE diminishing    │
│ returns. 3-gate policy enforcement. Audit logging.          │
└─────────────────────────────────────────────────────────────┘
```

### Packages

| Package | Description |
|---------|-------------|
| `@a2b/core` | Trust scoring, tier management, policy engine, registry, storage adapters |
| `@a2b/ceo` | CEO Agent — supervisor, PID monitor, conflict resolver, reporter, watchdog |
| `@a2b/onboarding` | 7-phase pipeline, shadow mode, canary rollout, auto-calibration, gaming detection |

## Key Concepts

### Trust Score (Beta + Glicko-2 + EVE)

Every agent has a trust score that combines:
- **Beta Reputation**: `score = successes / (successes + failures)` — Bayesian, proven since 2002
- **Glicko-2 Deviation**: Confidence interval — 0.80 after 2 tasks ≠ 0.80 after 200 tasks
- **EVE Diminishing Returns**: Harder to gain trust when already high. Easier to LOSE when high (betrayal penalty)

```typescript
import { updateTrust, OUTCOME_SCORES } from "@a2b/core";

// Success on a hard task → big trust gain
trust = updateTrust(trust, "success", "hard", agentAge);

// Honest failure → neutral (NOT punished)
trust = updateTrust(trust, "honest_failure", "hard", agentAge);

// Claimed success but actually failed → penalty
trust = updateTrust(trust, "false_success", "medium", agentAge);
```

### 3-Gate Enforcement

Not prompt-based. Code-level. Cannot be bypassed.

```
Gate 1: TOOL REGISTRY (compile-time)
  Agent doesn't even SEE blocked tools in its prompt.
  → Controlled via --disallowedTools at spawn time.

Gate 2: RUNTIME POLICY (every tool call)
  Code checks tier + budget + concurrency BEFORE execution.
  → Returns helpful denial: "Tool X requires Tier 2. You're Tier 1."

Gate 3: AUDIT LOG (after every action)
  Immutable record of every action, denial, and outcome.
  → CEO Agent reads these for promotion/demotion decisions.
```

### Agent Types & Custom Scorecards

Each agent type has a default scorecard. You can override weights per agent.

| Type | Primary Metric (40%) | Safety Metric (20-25%) |
|------|---------------------|----------------------|
| `contact` | Email/message quality | No spam, no wrong recipients |
| `intel` | Research accuracy | No hallucinated sources |
| `prospector` | Lead quality | No duplicate/bounced contacts |
| `strategy` | Advice quality | No contradictory recommendations |
| `content` | Content quality | Brand voice compliance |
| `infra` | System stability | No data corruption |
| `simulation` | Prediction accuracy | No misleading confidence |

### Gaming Detection

Agents can try to game their metrics. A2B detects this:

- **Shadow Metrics**: Hidden metrics the agent doesn't know about (difficulty avoidance, refusal rate)
- **Difficulty-Adjusted Scoring**: Easy tasks earn less. Hard tasks earn more. Avoiding hard tasks = penalty
- **Canary Tasks**: Known-answer tasks injected secretly. Score gap reveals gaming
- **Collusion Detection**: Correlation analysis between evaluator pairs

### Onboarding Pipeline

New agents go through 7 phases before reaching full autonomy:

```
Day 0:     Definition (human creates config)
Day 0:     Registration + Validation (automated, <5 min)
Day 1-2:   Shadow Mode (runs alongside buddy, output discarded)
Day 2-4:   Canary (20% → 50% → 80% real tasks)
Day 4-14:  Active Tier 0 → Tier 1 (100% reviewed)
Day 14-44: Tier 2 (20% reviewed, more tools)
Day 44+:   Tier 3 canary (10% → 25% → 50% → 100%)
```

### Auto-Harness Calibration (from NeoSigmaAI)

When an agent struggles, the calibration loop activates:

1. **Regression Gate**: Can it still do what it used to do?
2. **Benchmark Gate**: Is it better than its previous best?
3. **Suite Promotion**: Lock in new successes as permanent regression tests

The **ratchet effect**: quality bar only goes UP. Never down.

## Configuration

Create `aegis.config.yaml` in your project root:

```yaml
version: "1.0"

tiers:
  0: { name: "Onboarding", review_rate: 1.0, budget_per_day: 1.00 }
  1: { name: "Junior",     review_rate: 1.0, budget_per_day: 2.00 }
  2: { name: "Senior",     review_rate: 0.2, budget_per_day: 10.00 }
  3: { name: "Autonomous", review_rate: 0.0, budget_per_day: 30.00 }

promotion:
  to_tier_1: { min_tasks: 50, min_trust: 0.65, min_days: 7 }
  to_tier_2: { min_tasks: 150, min_trust: 0.78, min_days: 21, peer_approvals: 1 }
  to_tier_3: { min_tasks: 300, min_trust: 0.88, min_days: 30, canary_weeks: 4 }

gaming:
  enabled: true
  canary_injection_rate: 0.05
```

## Research Foundation

A2B is built on 100+ papers and production systems:

| Source | What We Took |
|--------|-------------|
| **Beta Reputation** (Jøsang 2002) | Trust = successes / total. Bayesian, proven. |
| **Glicko-2** (Glickman 2012) | Confidence intervals on trust scores |
| **EVE Online** | Diminishing returns: hard to gain trust when high |
| **Discourse Forum** | 5-level trust with measurable, automatic criteria |
| **DeepMind Aletheia** | Generator-Verifier-Reviser pattern for output review |
| **NeoSigmaAI Auto-Harness** | 3-step gated calibration with ratchet effect |
| **Microsoft AGT** | Point-based trust scoring, 3-gate enforcement |
| **Waymo ODD** | Domain-specific trust (per-capability, not global) |

Full research: [`/research`](./research/) directory.

## Roadmap

- [x] Core trust engine (Beta + Glicko-2 + EVE)
- [x] Tier manager with promotion/demotion
- [x] 3-gate policy enforcement
- [x] Agent registry with file storage
- [x] CEO Agent with PID monitoring
- [x] Onboarding pipeline (7 phases)
- [x] Gaming + collusion detection
- [ ] Dashboard UI
- [ ] LangChain adapter
- [ ] CrewAI adapter
- [ ] CLI scaffolding (`npx create-a2b-app`)
- [ ] npm package publishing

## License

MIT

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

Built by [The AI University](https://theaiuniversity.com) — where AI agents earn their autonomy.
