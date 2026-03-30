---
name: debug-e2e
description: Debug workflow — spawn a sub-agent that adds logs, runs tests, analyzes output, and reports findings. Never guess.
user-invocable: true
---

# Debug Workflow

When a bug is reported, **delegate the investigation to a sub-agent** using the Agent tool (subagent_type: general-purpose). The sub-agent runs the mechanical log/run/analyze loop in isolation and returns a clean report.

## How to launch

Spawn a general-purpose sub-agent with a prompt that includes:

1. **The bug description** — what the user reported, what's expected vs actual
2. **The investigation instructions** below (copy them into the prompt)
3. **Relevant file paths** — where the bug likely lives based on your initial read

Tell the sub-agent: **"Do NOT fix the bug. Only investigate and report back."**

## Sub-agent prompt template

```
You are investigating a bug in a game project. DO NOT fix the bug — only find the root cause.

## Bug description
{describe what the user reported}

## Relevant code
{list file paths the sub-agent should start from}

## Investigation process (follow strictly, never skip steps)

### Step 1: Understand the code path
Read the relevant source files to understand the flow. Identify decision points where the bug could occur.

### Step 2: Choose the right test tool

| Bug type | Tool | Why |
|----------|------|-----|
| Game state, phase transitions, life-lost, camera, banner data, overlay | Scenario test (test/scenario.test.ts) | Headless, instant, deterministic |
| Pixel rendering, touch interactions, online WebSocket, visual layout | E2E test (test/online-e2e.ts) | Needs real browser + canvas |

Default to scenario tests. Only use E2E when the bug requires a real browser.

### Step 3: Add logs
Add console.log at each decision point with:
- Function name / location
- Key variable values (actual numbers, not just booleans)
- Enough context to distinguish which entity / iteration / frame produced the log

### Step 4: Write a test that reproduces the conditions
- For scenario tests: use createScenario(seed), advance to the right phase, set up the exact conditions
- For E2E: use --seed, --action, --screenshot flags
- Run: bun test/scenario.test.ts or npx tsx test/online-e2e.ts

### Step 5: Analyze the output
Write an inline analysis (node -e or grep) that checks the log output for the specific assertion.
Never read raw logs by eye. The script reads them.

### Step 6: Report findings
Return a report with:
- **Root cause**: one sentence
- **Evidence**: the log output / values that prove it
- **Code location**: file:line where the bug originates
- **Suggested fix direction**: what needs to change (do NOT implement it)

## Rules
- NEVER guess. If logs don't have enough data, add more logs and re-run.
- NEVER change game logic or fix the bug — only investigate.
- NEVER declare a cause without log evidence.
- Use bun for scenario tests, npx tsx for E2E tests.
- Use timeout command for E2E tests that might hang.
- Remove all debug logs before returning your report (git checkout the logged files).
```

## Scenario test quick reference

```typescript
import { createScenario, assertPhase } from "./scenario-helpers.ts";
import { assert, test, runTests } from "./test-helpers.ts";
import { Phase, Mode } from "../src/types.ts";

test("describe the bug", () => {
  const s = createScenario(42);
  s.runCannon();                    // AI places cannons
  s.runBattle();                    // simulate full battle
  s.runBuild();                     // simulate full build phase
  s.playRound();                    // cannon + battle + build + finalize
  s.playRounds(5);                  // 5 full rounds with reselection

  console.log(s.describe());        // compact state summary

  // Manipulate state
  s.setLives(1, 2);
  s.clearWalls(1);
  s.eliminatePlayer(2);
  s.destroyWalls(1, 5);
  s.destroyCannon(1, 0);

  // Phase control
  s.advanceTo(Phase.BATTLE);
  s.finalizeBuild();
  s.processReselection([1]);

  // Sub-systems
  const cam = s.createCamera({ mode: Mode.SELECTION, phase: Phase.CASTLE_RESELECT });
  const banner = s.createBanner();
  const dialog = s.createLifeLostDialog([1], [2]);
});

runTests("Debug investigation");
```

## E2E test quick reference

```sh
npm run test:e2e:local:quick       # headless, fast, 1 round
npx tsx test/online-e2e.ts local 0 "" 1 --headless --fast --seed 42
```

Flags: `--headless`, `--fast`, `--screenshot`, `--mobile`, `--seed N`, `--action "phase:X click:Y screenshot:label"`, `--assert "phase:X button:Y visible"`

## After the sub-agent reports back

1. Review the root cause and evidence
2. Implement the fix yourself (the sub-agent didn't touch the code)
3. Run the test again to verify
4. Optionally keep the test as a regression guard
