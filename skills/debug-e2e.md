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
Create a test file in test/. Use one of these approaches:

**For state/logic bugs** — use the scenario API (play the game, observe events):
```typescript
import { createScenario, waitForPhase, waitForModifier } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";

const sc = await createScenario({ seed: 42, mode: "modern" });
const events: unknown[] = [];
sc.bus.on(GAME_EVENT.GRUNT_SPAWN, (e) => events.push(e));
waitForPhase(sc, Phase.BATTLE);
sc.runGame();
assert(events.length > 0);
```

Scenario API (`test/scenario.ts`):
- `createScenario({ seed?, mode?, rounds? })` — boots the FULL runtime headlessly
- `sc.state` / `sc.bus` — read-only state and the typed event bus
- `sc.tick(dtMs?)` — advance one frame (default 16ms)
- `sc.runUntil(predicate, maxTicks?, dtMs?)` — tick until predicate returns true
- `sc.runGame(maxTicks?, dtMs?)` — tick until game ends
- `waitForPhase(sc, Phase.X)` — tick until a `phaseStart` event for that phase
- `waitForBanner(sc, predicate)` — tick until a matching `bannerStart` event
- `waitForModifier(sc, modifierId?)` — tick until a modifier banner fires

**There is NO method to mutate state, scripted-place pieces, or skip phases.** The AI plays the game end-to-end, just like in a browser. If you need a specific game condition, find a seed that produces it via `deno run -A scripts/find-seed.ts` (one-off exploration) or register it in `test/seed-conditions.ts` and use `loadSeed(name)` (drift-safe, recommended for committed tests — see the "Drift-safe seeds" section below). Tests that hack state are exactly the antipattern this API replaces.

**For input/rendering/browser bugs** — use the E2E helpers:
```typescript
import { E2EGame, E2ETest } from "./e2e-helpers.ts";
const test = new E2ETest("my test");
const game = await E2EGame.create({ seed: 42, humans: 1, headless: true });
// ... assertions ...
test.check("label", condition);
await game.close();
test.done(); // prints summary, exits with code 1 on failure
```

Create options: `{ seed?, humans?, headless?, rounds?, mode? }`.
`mode: "modern"` passes `?mode=modern` URL param for modern-mode games.

The E2E bridge (`window.__e2e`) exposes structured state snapshots each frame:
- **Game state**: `mode`, `phase`, `round`, `timer`, `players`
- **Render overlay**: `overlay.entities` (houses, grunts, towers, frozenTiles), `overlay.phantoms`, `overlay.banner`, `overlay.battle`, `overlay.ui`
- **Banner prev entities**: `overlay.bannerPrevEntities` (old scene during banner sweep)
- **Controller**: `controller.cannonCursor`, `controller.buildCursor`, `controller.crosshair`
- **Camera**: `camera.viewport`
- **Coord conversion**: `worldToClient(wx, wy)`, `tileToClient(row, col)` — callable from page.evaluate
- **Targeting**: `targeting.enemyCannons`, `targeting.enemyTargets` — pixel positions of enemy entities
- **Pause/step**: set `paused = true` to freeze, `step = true` to advance one frame

**Lifecycle & phase control:**
- `game.advanceTo("CANNON_PLACE")` — waits for phase (timeout from game constants)
- `game.waitForGameOver()` — waits for mode === "STOPPED"
- `game.waitUntil(predicateString)` — custom bridge predicate
- `game.setFastMode(false)` — disable fast mode for precise mouse/timing
- `game.pause()` / `game.resume()` / `game.step()`

**Input:**
- `game.mouse.moveToWorld(wx, wy)` / `game.mouse.moveToTile(row, col)`
- `game.mouse.clickTile(row, col)` / `game.mouse.rightClickWorld(wx, wy)`
- `game.mouse.sweep(from, to, { stepPx })` — pixel-by-pixel sweep
- `game.keyboard.press("n")` / `game.dom.clickButton("confirm")`

**Query:**
- `game.query.state()` / `game.query.phase()` / `game.query.timer()`
- `game.query.controller()` / `game.query.overlay()` / `game.query.players()`

Fast mode is ON by default (accelerates lobby + phase timers). Disable fast mode with
`game.setFastMode(false)` when you need precise mouse/timing interaction.

Use bridge state snapshots for render verification — `overlay.entities`,
`overlay.banner`, `overlay.ui`, `players` are all updated every frame.

Run with: `deno run -A test/your-file.ts`
No external `timeout` command needed — tests handle their own lifecycle.

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

## E2E test commands

```sh
npm run test:e2e:cannon-cursor     # cannon phantom stability (9s)
npm run test:e2e:banner            # banner entity rendering (5s)
npm run test:e2e:all               # all focused e2e tests
npm run test:e2e:local:quick       # legacy full simulation (headless, 1 round)
```

Flags for legacy e2e: `--headless`, `--fast`, `--seed N`, `--mobile`, `--screenshot`,
`--action "phase:X click:Y screenshot:label"`, `--assert "phase:X button:Y visible"`

## Finding seeds for e2e tests

### One-off exploration — `npm run find-seed`

Use when you're debugging interactively and need a seed quickly:

```sh
npm run find-seed -- --condition wildfire --tries 50
npm run find-seed -- --condition frozenRiver --rounds 5
npm run find-seed -- --expr "state.grunts.length > 10" --rounds 4
```

Built-in conditions: `wildfire`, `crumblingWalls`, `gruntSurge`, `frozenRiver`, `anyModifier`, `manyGrunts`. Runs headless scenarios and checks the predicate per tick. Good for throwaway exploration, bad for committed tests (seeds drift silently when RNG changes).

### Drift-safe seeds — `loadSeed` + seed registry

**For committed tests that depend on a specific RNG outcome**, do NOT hardcode `seed: 42`. Register the condition in `test/seed-conditions.ts` and load by name:

```ts
// test/seed-conditions.ts
export const SEED_CONDITIONS = {
  "modifier:wildfire": {
    mode: "modern",
    rounds: 8,
    match: (sc) => () => sc.state.modern?.activeModifier === "wildfire",
  },
  "upgrade:rapid_fire": {
    mode: "modern",
    rounds: 10,
    match: (sc) => latchUpgradePicked(sc, "rapid_fire"),
  },
  // ...
};
```

```ts
// test/some.test.ts
const sc = await loadSeed("modifier:wildfire");
```

Then run `npm run record-seeds` to rescan every registered condition in one pass and rewrite `test/seed-fixtures.json`. When RNG drifts (new feature shifts rolls), one command regenerates every drift-sensitive test's seed — no per-test rehunting.

**Workflow for new drift-sensitive tests:**
1. Add an entry to `SEED_CONDITIONS`.
2. `npm run record-seeds`.
3. Write the test with `loadSeed(name)` instead of `createScenario({ seed: N })`.

See `test/upgrades.test.ts` for a full example (grouping by resolved seed, per-upgrade `t.step` assertions with effect probes).
