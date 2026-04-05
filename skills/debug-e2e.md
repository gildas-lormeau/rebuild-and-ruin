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
- `model: "sonnet"` — this is mechanical work (add logs, run tests, read output), Sonnet is faster and equally capable
- A prompt that includes the bug description, relevant file paths, and the investigation instructions below

Tell the sub-agent: **"Do NOT fix the bug. Only investigate and report back. Work fully autonomously — never ask the user anything. Write tests to verify, never ask the user to check the browser."**

## Sub-agent prompt template

````
You are investigating a bug in a game project.

CRITICAL RULES:
- DO NOT fix the bug — only investigate and report.
- You ARE running in an isolated worktree. You CAN freely modify src/ files to add logs.
  Changes here do not affect the main repo.
- DO NOT form a theory about the bug until you have read log output from a test run.
  Your job is to add dumb, mechanical logs, run the test, and let the output tell you what happened.
- After finding one cause, check if the same data is modified by other code paths too.
- You are FULLY AUTONOMOUS. NEVER ask the user to verify anything. NEVER ask the user
  to check the browser. NEVER ask the user questions. You have all the tools you need:
  write a test, run it, read the output. That IS your verification. If you need to check
  something, write a test or add a log — don't ask a human to look.
- Your ONLY deliverable is the final report (Step 5). Everything before that is silent work.
- YOUR TEST MUST EXERCISE THE EXACT INPUT PATH THAT IS BROKEN. If the bug is about mouse
  input, your test MUST use mouse input — not keyboard. If the bug is about touch, use touch.
  If the bug is about a specific device or mode, reproduce that exact context. A test that
  exercises a different code path than the one that's broken is worthless — it proves nothing.
  Before running the test, verify that your test actually hits the code path in question.

## Bug description
{describe what the user reported}

## Relevant code
{list file paths the sub-agent should start from}

## Investigation process

### Step 1: Read the code for STRUCTURE ONLY
Read the relevant source files. Map out:
- Which functions are involved
- Where branches and state mutations happen
- What data flows through

DO NOT try to understand why the bug happens. DO NOT form a hypothesis.
You are only building a list of locations where logs need to go.

### Step 2: Add DUMB logs at every branch and mutation
Add console.log at EVERY decision point and state mutation in the relevant functions.
Not just the ones you think matter — ALL of them.

Log mechanically:
- Function entry with argument values
- Every if/else/switch branch: which branch was taken and the condition values
- Every state mutation: variable name, old value, new value
- Function exit with return value

DO NOT skip a code path because you think it's unrelated. You don't know what's
related yet — that's what the logs will tell you.

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

### Step 4: Read the log output — NOW you can analyze
Only now, with log output in front of you, trace what actually happened.
Check which branches were taken, what values were present, where things diverged from expected.
If logs don't cover the area where things went wrong, add more and re-run.
NEVER guess — if the logs don't explain it, add more logs.

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
