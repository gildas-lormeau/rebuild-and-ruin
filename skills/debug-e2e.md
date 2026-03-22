---
name: debug-e2e
description: Debug workflow using the project's E2E test — screenshots, actions, assertions, log analysis.
user-invocable: true
---

# E2E Debug Workflow

Use the project's E2E test (`test/online-e2e.ts`) as your primary debugging tool. It launches a real browser, runs the game, captures screenshots and logs. You can script interactions and assertions from the CLI.

## E2E Test Reference

### Basic commands

```sh
npm run test:e2e:local           # local, 3 AI, browser visible
npm run test:e2e:local:quick     # headless, 1 battle, fast
npm run test:e2e:mobile          # mobile emulation + screenshots
npm run test:all                 # headless + build-ai + e2e quick
npx tsx test/online-e2e.ts online 1   # online, 1 human + 2 AI + watcher
```

### Positional arguments

```
npx tsx test/online-e2e.ts <mode> <humans> <serverUrl> <minBattles>
```

- `mode`: `local` or `online`
- `humans`: 0-3 (default: 0 for local, 2 for online)
- `serverUrl`: remote server URL (online only, empty string for local)
- `minBattles`: stop after N battles (default: 2)

### Flags

| Flag | Description |
|------|-------------|
| `--headless` | No browser window. Use for automated/parallel runs. |
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
- `click:zoom|rotate|quit|X,Y` — click a named button or coordinates
- `screenshot:label` — save `logs/screenshot-action-<label>.png`
- `exit` — stop the test after this action

### Assert syntax

```
--assert "phase:BATTLE button:quit visible"
--assert "phase:CANNON_PLACE button:rotate visible"
--assert "mode:LOBBY button:quit hidden"
```

Parts:
- `phase:X` or `mode:X` — when to check
- `button:zoom|rotate|quit` — which button
- `visible` or `hidden` — expected state
- `text:SomeText` — check if text appears in the page

### Examples

```sh
# Reproduce a bug on seed 42, screenshot the battle phase
npx tsx test/online-e2e.ts local 0 --seed 42 --action "phase:BATTLE screenshot:bug exit"

# Verify zoom button is hidden in lobby, visible in battle
npx tsx test/online-e2e.ts local 0 --headless --mobile \
  --assert "phase:BATTLE button:zoom visible" "" 1

# Click zoom during battle, take screenshot, exit
npx tsx test/online-e2e.ts local 0 --mobile \
  --action "phase:BATTLE click:zoom screenshot:zoomed exit"

# Run 10 parallel headless games to catch intermittent bugs
for i in $(seq 1 10); do
  npx tsx test/online-e2e.ts local 0 --headless --seed $i "" 1 &
done; wait

# Online test with remote server
npx tsx test/online-e2e.ts online 1 https://your-server.deno.dev
```

## Debugging process

1. **Reproduce** — use `--seed` to lock the map, `--action` to trigger the exact scenario, `--screenshot` to capture the visual state.

2. **Add logs** — add `console.log` at decision points in the game code. Logs go to the browser console and are captured in `logs/e2e-*.log`.

3. **Write analysis script** — a `node -e` script that parses the log file and checks assertions (PASS/FAIL per player/frame). Never read raw logs by eye.

4. **Run test** — use `--headless` for speed, minimal `minBattles` to reach the bug quickly. Use `--assert` for UI state checks.

5. **Read script output** — it says PASS or FAIL with actual values.

6. **Fix** — only after facts from logs confirm the cause.

7. **Verify** — run again with same seed. Run multiple seeds for intermittent bugs.

8. **Clean up** — remove all debug logs. Verify `npm run build` passes clean.

## Log files

- `logs/e2e-<mode>-<humans>h-<timestamp>.log` — full console output
- `logs/screenshot-game-<mode>-<phase>.png` — phase transition screenshots
- `logs/screenshot-action-<label>.png` — action-triggered screenshots

## Key game phases for triggers

- `CASTLE_SELECT` — tower selection
- `WALL_BUILD` — piece placement / repair
- `CANNON_PLACE` — cannon placement
- `BATTLE` — shooting phase

## Key UI modes for triggers

- `LOBBY` — canvas lobby with player slots
- `SELECTION` — tower browsing
- `BANNER` — phase transition banner sweep
- `GAME` — active gameplay
- `STOPPED` — game over
