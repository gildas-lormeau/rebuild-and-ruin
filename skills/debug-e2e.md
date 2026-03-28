---
name: debug-e2e
description: Debug workflow — scenario tests for game logic, E2E browser tests only when rendering/touch/online is involved.
user-invocable: true
---

# Debug Workflow

## Choose the right tool

| Bug type | Tool | Why |
|----------|------|-----|
| Game state, phase transitions, life-lost, camera zoom, banner data, overlay content | **Scenario test** (`test/scenario.test.ts`) | Headless, instant, deterministic, no browser needed |
| Pixel rendering, touch interactions, online WebSocket, visual layout | **E2E test** (`test/online-e2e.ts`) | Needs real browser + canvas |

**Default to scenario tests.** Only reach for E2E when the bug requires a real browser.

---

## Scenario Tests (preferred)

### How it works

`test/scenario-helpers.ts` provides `createScenario(seed)` — a factory that wraps `createHeadlessRuntime` with high-level helpers for advancing phases, manipulating state, and testing camera/banner/life-lost sub-systems.

### Quick reference

```sh
bun test/scenario.test.ts        # run all scenario tests
```

### Writing a scenario test

```typescript
import { createScenario, assertPhase, assertCameraZone } from "./scenario-helpers.ts";
import { assert, test, runTests } from "./test-helpers.ts";
import { Phase, Mode } from "../src/types.ts";

test("describe the bug being tested", () => {
  const s = createScenario(42);

  // Advance game state
  s.runCannon();                    // AI places cannons
  s.runBattle();                    // simulate full battle
  s.runBuild();                     // simulate full build phase
  s.playRound();                    // cannon + battle + build + finalize

  // Inspect state
  console.log(s.describe());        // "Phase:BATTLE | P0: 3♥ 12w 2c 45t 0pts | ..."

  // Manipulate state to reproduce the bug
  s.setLives(1, 2);                // set player 1 to 2 lives
  s.clearWalls(1);                  // remove all walls for player 1
  s.eliminatePlayer(2);             // force-eliminate player 2
  s.destroyWalls(1, 5);             // remove 5 walls + reclaim territory
  s.destroyCannon(1, 0);            // kill cannon at index 0 (hp=0)

  // Phase control
  s.advanceTo(Phase.BATTLE);        // advance to specific phase
  s.finalizeBuild();                // finalize build (sweep + territory + life check)
  s.processReselection([1]);        // handle reselection for players

  // Test camera behavior
  const cam = s.createCamera({
    mode: Mode.SELECTION,
    phase: Phase.CASTLE_RESELECT,
    myPlayerId: 0,
    mobileAutoZoom: true,
  });
  cam.tick();
  assertCameraZone(cam, null);      // camera should stay unzoomed

  // Test banner state
  const banner = s.createBanner();
  // ... set pendingOldWalls, call showBannerTransition, check oldCastles

  // Test life-lost dialog
  const dialog = s.createLifeLostDialog([1], [2]);  // reselect=[1], eliminated=[2]
  const ticked = s.tickLifeLostDialog(dialog, 5.0);  // tick for 5 seconds
  assert(ticked === null, "Dialog should resolve");
});

runTests("My Tests");
```

### Available assertions

### Tile finders

```typescript
s.findGrassTile(playerId)       // open grass tile in player's zone (not occupied)
s.findInteriorTile(playerId)    // interior tile not blocked by tower/cannon
s.findEnemyWallTile(playerId)   // {row, col, owner} of an enemy wall tile
```

### Available assertions

```typescript
assertPhase(s, Phase.CANNON_PLACE)
assertLives(s, playerId, expectedLives)
assertEliminated(s, playerId)
assertNotEliminated(s, playerId)
assertHasWalls(s, playerId)
assertNoWalls(s, playerId)
assertCameraZone(handle, expectedZone)  // null = unzoomed
assertBannerNewWallsMatch(banner, state)
assertLifeLostLabel(entry, "Continuing..." | "Abandoned" | "none")
```

### Debugging approach

1. **Reproduce** — write a scenario that sets up the exact conditions
2. **Add logs** — use `console.log` inside the test to inspect state
3. **Prove the bug** — write an assertion that fails with the bug present
4. **Fix** — modify the source code
5. **Prove the fix** — same test now passes, logs show before/after
6. **Commit** — test stays as a regression guard

### Example: how the banner sweep bug was found and fixed

The bug: swept walls vanished instantly during the Place Cannons banner instead of progressively.

```typescript
test("Place Cannons banner old scene includes pre-sweep walls", () => {
  const s = createScenario();
  s.runCannon(); s.runBattle(); s.runBuild();

  // Add an isolated wall that will be swept
  const player = s.state.players[0]!;
  player.walls.add(isolatedKey);
  const wallsBefore = player.walls.size;

  // Stash pre-sweep walls (simulates what tickHostBuildPhase does)
  const banner = s.createBanner();
  banner.pendingOldWalls = snapshotAllWalls(s.state);

  // Sweep happens here
  s.finalizeBuild();
  console.log("walls before:", wallsBefore, "after:", player.walls.size);

  // Banner captures old scene using pendingOldWalls
  showBannerTransition({ banner, state: s.state, ... });

  // Old scene has pre-sweep walls, new scene doesn't → progressive reveal
  assert(banner.oldCastles[0].walls.has(isolatedKey), "old scene has swept wall");
  assert(!player.walls.has(isolatedKey), "new scene doesn't");
});
```

---

## E2E Browser Tests (when needed)

Use `test/online-e2e.ts` only when the bug involves actual rendering, touch input, WebSocket connections, or visual layout that can't be tested headlessly.

### Basic commands

```sh
npm run test:e2e:local           # local, 3 AI, browser visible
npm run test:e2e:local:quick     # headless, 1 battle, fast
npm run test:e2e:mobile          # mobile emulation + screenshots
npx tsx test/online-e2e.ts online 1   # online, 1 human + 2 AI + watcher
```

### Positional arguments

```
npx tsx test/online-e2e.ts <mode> <humans> <serverUrl> <rounds>
```

- `mode`: `local` or `online`
- `humans`: 0-3 (default: 0 for local, 2 for online)
- `serverUrl`: remote server URL (online only, empty string for local)
- `rounds`: number of game rounds (default: 3, any positive integer)

### Flags

| Flag | Description |
|------|-------------|
| `--headless` | No browser window. Use for automated/parallel runs. |
| `--fast` | Accelerate game time (~25x, including lobby). A 1-round test completes in ~9s. |
| `--screenshot` | Capture PNG at every phase transition → `logs/screenshot-game-*.png` |
| `--mobile` | Emulate Pixel 7 landscape (touch, small viewport) |
| `--seed N` | Force map seed for reproducible bugs |
| `--action "..."` | Script an interaction at a specific phase (repeatable) |
| `--assert "..."` | Assert UI state at a specific phase (repeatable, exit code 1 on failure) |

### Action syntax

```
--action "phase:BATTLE click:zoom screenshot:label exit"
```

Parts (space-separated, all optional except trigger):
- `phase:X` or `mode:X` — when to trigger (matches game phase or UI mode)
- `click:home|enemy|rotate|quit|X,Y` — click a named button or coordinates
- `screenshot:label` — save `logs/screenshot-action-<label>.png`
- `exit` — stop the test after this action

### Assert syntax

```
--assert "phase:BATTLE button:quit visible"
--assert "phase:CANNON_PLACE button:rotate visible"
--assert "mode:LOBBY button:quit hidden"
```

### E2E debugging process

1. **Reproduce** — use `--seed` to lock the map, `--action` to trigger the exact scenario, `--screenshot` to capture the visual state.
2. **Add logs** — add `console.log` at decision points in the game code. Logs go to the browser console and are captured in `logs/e2e-*.log`.
3. **Write analysis script** — a `node -e` script that parses the log file and checks assertions (PASS/FAIL per player/frame). Never read raw logs by eye.
4. **Run test** — use `--headless --fast` for speed, minimal rounds (`"" 1`) to reach the bug quickly. Wrap with `timeout` only if the test might hang.
5. **Read script output** — it says PASS or FAIL with actual values.
6. **Fix** — only after facts from logs confirm the cause.
7. **Verify** — run again with same seed. Run multiple seeds for intermittent bugs.
8. **Clean up** — remove all debug logs. Verify `npm run build` passes clean.

### Log files

- `logs/e2e-<mode>-<humans>h-<timestamp>.log` — full console output
- `logs/screenshot-game-<mode>-<phase>.png` — phase transition screenshots
- `logs/screenshot-action-<label>.png` — action-triggered screenshots

### Key game phases for triggers

- `CASTLE_SELECT` — tower selection
- `WALL_BUILD` — piece placement / repair
- `CANNON_PLACE` — cannon placement
- `BATTLE` — shooting phase

### Key UI modes for triggers

- `LOBBY` — canvas lobby with player slots
- `SELECTION` — tower browsing
- `BANNER` — phase transition banner sweep
- `GAME` — active gameplay
- `STOPPED` — game over
