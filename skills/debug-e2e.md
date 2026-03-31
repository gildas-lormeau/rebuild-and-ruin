---
name: debug-e2e
description: Debug workflow — spawn a sub-agent that adds logs, runs tests, analyzes output, and reports findings. Never guess.
user-invocable: true
---

# Debug Workflow

When a bug is reported, **delegate the investigation to a sub-agent** using the Agent tool with `isolation: "worktree"` (prevents the agent from modifying source files in the main repo).

## How to launch

Spawn a general-purpose sub-agent with:
- `isolation: "worktree"` — mandatory, prevents source modification in the main repo
- A prompt that includes the bug description, relevant file paths, and the investigation instructions below

Tell the sub-agent: **"Do NOT fix the bug. Only investigate and report back."**

## Sub-agent prompt template

````
You are investigating a bug in a game project.

CRITICAL RULES:
- DO NOT fix the bug — only investigate and report.
- You ARE running in an isolated worktree. You CAN freely modify src/ files to add logs.
  Changes here do not affect the main repo.
- After finding one cause, check if the same data is modified by other code paths too.

## Bug description
{describe what the user reported}

## Relevant code
{list file paths the sub-agent should start from}

## Investigation process

### Step 1: Read the code
Read the relevant source files. Identify the conditional branches and data flow where the bug could occur.

### Step 2: Add targeted logs to source files
Add console.log at decision points in the source files. Log:
- Function name
- Key variable values (actual numbers/states, not just booleans)
- Which branch was taken

### Step 3: Write a test that triggers the bug
Create a test file in test/. Use this template:

```typescript
import { createScenario } from "./scenario-helpers.ts";
import { assert, test, runTests } from "./test-helpers.ts";
import { Phase, Mode } from "../src/types.ts";

test("describe the bug", () => {
  const s = createScenario(42);

  // Advance game to the right state
  // Use: s.runCannon(), s.runBattle(), s.runBuild(), s.playRound(),
  //      s.playRounds(n), s.advanceTo(Phase.X), s.finalizeBuild(),
  //      s.processReselection([playerIds])

  // Manipulate state to reproduce conditions
  // Use: s.setLives(pid, n), s.clearWalls(pid), s.eliminatePlayer(pid),
  //      s.destroyWalls(pid, count), s.destroyCannon(pid, idx)

  // Inspect state
  console.log(s.describe());

  // Test sub-systems
  // Banner:  const banner = s.createBanner();
  // Camera:  const cam = s.createCamera({ mode, phase, myPlayerId });
  // Dialog:  const dialog = s.createLifeLostDialog([reselect], [eliminated]);
  // Transitions: const ctx = s.createTransitionContext();

  // Assert the bug
  assert(condition, "expected vs actual message");
});

await runTests("Bug investigation");
```

Run with: bun test/your-file.ts

### Step 4: Read the log output
Parse the console output. Check which branches were taken and whether the data was correct.
If logs don't have enough info, add more and re-run. NEVER guess.

### Step 5: Report findings
Return:
- **Root cause**: one sentence
- **Evidence**: the actual log output that proves it
- **Code location**: file:line where the bug originates
- **Suggested fix direction**: what needs to change (do NOT implement)
````

## After the sub-agent reports back

1. Review the root cause and evidence
2. Implement the fix yourself (the sub-agent didn't touch the main repo)
3. Run the test again to verify
4. Optionally keep the test as a regression guard

## E2E tests (browser-required bugs only)

For bugs involving pixel rendering, touch interactions, or WebSocket connections, use E2E instead of scenario tests:

```sh
npm run test:e2e:local:quick       # headless, fast, 1 round
npx tsx test/online-e2e.ts local 0 "" 1 --headless --fast --seed 42
```

Flags: `--headless`, `--fast`, `--screenshot`, `--mobile`, `--seed N`, `--action "phase:X click:Y screenshot:label"`, `--assert "phase:X button:Y visible"`
