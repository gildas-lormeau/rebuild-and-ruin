# Rebuild & Ruin

Rampart multiplayer remake for the web, tournament-style. Vite + TypeScript, no framework.
Online multiplayer via Deno Deploy + WebSocket (checkpoint-based sync, host migration, watcher ticks).

## Non-targets

What this project is NOT. Reject or push back on proposals in these directions:

- **No framework migration.** Vite + vanilla TypeScript is load-bearing. Don't propose React/Vue/Svelte/etc.
- **No persistent accounts / progression.** Per-match state only — no profiles, cosmetics, unlockables, ranks, or stats history.
- **No authoritative server.** Server is a checkpoint relay for host-migration; clients are authoritative for their own input. Anti-cheat / server-side validation is out of scope.
- **No matchmaking / tournament platform.** "Tournament-style" refers to the original Rampart's gameplay format (1v1-into-finals inside a match), not a platform feature. No brackets, lobbies-of-lobbies, or ranked queues.
- **No native ports.** Web-first; touch input is the mobile surface. No iOS/Android apps, no Electron.
- **No level editor or content authoring tools.** Maps are seed-generated; upgrades/modifiers/cannon modes live in pool registries and only the dev adds entries.
- **No new game modes beyond `classic` and `modern`.** New mechanics go into FEATURE_POOL gated by `hasFeature(state, ...)`, not a parallel mode.
- **No spectator/esports features.** Watcher ticks exist for host-migration recovery, not for an audience product.
- **No retired-Rampart features** (4-player, additional unit types, drawbridges) **unless explicitly scoped into modern mode.** `reference_modern_ideas` is a parking lot of considered extensions — don't proactively implement from it.

Modern mode is the explicit exception channel: features with a `FeatureId`, pool entry, and consumer map are fair game. Anything outside that mechanism is a non-target.

## Commands

- Build: `npm run build` (runs `tsc --noEmit && vite build` — always use this, never `npx vite build` alone)
- Format: `npm run format` (biome on src/ and server/); `npm run format:check` for CI; 2-space indent
- Lint: `npm run lint:all` — format:check, biome, knip, madge, jscpd (min-lines 10), lint:literals (baseline-aware), lint:typeof
- Layer linter: `deno run -A scripts/generate-import-layers.ts --check`; use `/import-hygiene` skill for full audit
- Layer classification audit: `deno run -A scripts/audit-layer-classification.ts` finds files whose declared layer-group disagrees with header self-claims, name conventions, or imported-domain spread. Pair with `scripts/audit-layer-pins.ts <file...>` to see which import "pins" a file at its current layer. Use the `/layer-graph-cleanup` skill for the full workflow.
- Export index: `npm run export-search -- <term>` before writing new code; `npm run export-index` to regenerate; `npm run export-map` for compact layer→file→symbols view
- Literals baseline: `.readonly-literals-baseline.json`; `--update-baseline` to refresh; `--all --files <globs>` for scoped reviews
- Pre-commit hook (.git/hooks/pre-commit, plain git): reorder + biome format (staged), tsc, biome check, knip, madge, eslint, jscpd, layers, cells, cell-label-refs, lateral, domains, literals, imports, architecture, arch-non-runtime, entry-placement, restricted, checkpoint-fields, applyat, test-timeouts, raw-playwright, phase-transitions, typeof, comment-refs, repeated-ternary, closure-captures, ai-rng-isolation, ctor-rng, raf-mainloop, null-init, registries, mod-lifecycle, monotone-state, useless-guards, if-chain, passthrough, helper-reuse, internal-jsdoc, tile-mutators, accessor-bypasses, shape-duplicates, dead-params, unused-iface, union-drift, deno-check, deno-lint, fast tests (scenario, determinism, input-lobby, input-touch, network-observer, camera-selection-zoom), export-index, export-map
- Lane logs on failure: pre-commit and `lint:all` both run lanes in parallel and write each lane's stdout/stderr to `$TMP/<label>.log`. On success the temp dir is deleted; on failure it's moved to `.git/pre-commit-last/` (pre-commit) or `.git/lint-all-last/` (lint:all), with a `FAILED.<label>` marker per failing lane. After a red run, read those files instead of re-running the whole pipeline.
- Server: `deno task server` (port 8001); type-check with `deno check server/server.ts` (NOT tsc)
- Test: `npm run test:scenario` (the gameplay tests — `test/scenario.test.ts`) and `npm run test:determinism` (replays bus event fixtures from `test/determinism-fixtures/`). Both use `createScenario({ seed, mode, rounds })` from `test/scenario.ts`, observe via `sc.bus.on(GAME_EVENT.X, ...)`, and use `waitForPhase` / `waitForBanner` / `waitForModifier` helpers. Online tests: `npm run test:net` (network + online suite). Note `test:network-bidirectional` needs `--allow-env=BIDIR_DUMP` — it reads that debug-dump opt-in at startup and Deno hard-throws `NotCapable` without it (looks like a total test failure, is actually a missing permission). Three parity gates: `network-vs-local` (one-way host/watcher — only host has assisted slots), `network-bidirectional` (both peers drive an assisted-human slot, modelling 2 humans on different machines with non-zero wire delay), and `camera-zoom-parity` (a touch peer with mobile auto-zoom on must converge with a desktop peer — guards the camera-never-affects-sim invariant).
- Test API contract: `createScenario` returns `{ state, bus, input, tick, runUntil, runGame, tileAt, now, ... }` (also `sentMessages`, `deliverMessage`, `mode`, `lobbyActive`, `banner`, `overlay`, `camera`, `rematch` — see `test/scenario.ts` for the full surface). There are NO methods to mutate state, scripted-place pieces, or skip phases. The AI plays the game end-to-end. If you need a specific game condition, prefer `loadSeed(name)` from the seed registry (`SEED_CONDITIONS` in `test/seed-conditions.ts`) — drift-safe named seeds; fall back to `scripts/find-seed.ts` to discover new ones. For modifier / upgrade determinism specifically, `createScenario({ ..., testHooks: { forceModifier, disabledModifiers, forceUpgrade, disabledUpgrades } })` short-circuits the RNG draws at `rollModifier` / `drawOffers` — test-only, never serialized. `test/modifiers.test.ts` (`npm run test:modifiers`) uses `forceModifier` to cover all 13 implemented modifiers in ~26s.
- Test API timeout shape: `runUntil` / `runGame` / `waitFor*` all take `{ timeoutMs }` — sim-ms on headless (mock clock), wall-clock ms on E2E. There is no `maxTicks` / `maxFrames`. `tick(N)` is the frame-denominated precision tool; `runUntil` is the budget-denominated wait tool. `lint:test-timeouts` enforces this.
- Determinism: `npm run test:determinism` replays each fixture in `test/determinism-fixtures/` and asserts the bus event log matches byte-for-byte. If a fixture diverges after a code change, the runtime is non-deterministic — revert or investigate. Only update a fixture (`npm run record-determinism -- --seed N --mode classic|modern`) when the divergence is expected and intentional. NEVER re-record to "fix" a failing test without justification. To get that justification mechanically, run `npm run check-determinism`: it replays each fixture twice and classifies it MATCHES / SAFE-RERECORD (deterministic, behavior changed — safe) / BUG (two fresh runs disagree — runtime is non-deterministic now, do NOT re-record). Exit codes 0/2/1. When it says SAFE, re-record everything in place with `npm run record-determinism -- --all` (suffix-aware; asserts each fixture's coverage invariant survives, e.g. the balloon fixture must still emit `balloonAnimStart`).
- Re-tune after a battle/grunt/house dynamics change: `npm run retune` (dry-run) detects every drifted artifact (determinism fixtures, seed registry, abandon/upgrades/modifiers seeds) and prints the fix for each; `npm run retune -- --apply` auto-heals the mechanical ones (determinism via the check→`record --all` chain, seed registry via `record-seeds`) and flags the hand-tuned seeds for re-probing. A determinism BUG (non-deterministic runtime) aborts the whole run. For the abandon seeds specifically, `npm run probe-abandon-seeds -- --mode classic|modern --rounds N` finds new full-parity seeds to paste into TRIALS. retune does NOT run the slow parity gates — verify those separately.
- Headless runtime impl lives in `test/runtime-headless.ts` — `createHeadlessRuntime(opts)` returns the underlying driver. Tests should import from `test/scenario.ts` instead of touching the headless driver directly. (The file lives in `test/` because every option/method on it is test-only — it doesn't belong in production source.)
- MCP play server (dev/research): `deno run -A scripts/mcp-play/server.ts` (or `deno task play`; registered in `.mcp.json` so the VSCode extension / CLI connects to it as a live MCP server — approve it once, then the tools surface as deferred tools) — an MCP stdio server that lets an external LLM agent play a classic match by driving ONE slot through the real controller/intent path (an `McpBrain` is brain-swapped onto the agent slot via `RuntimeConfig.controllerFactory`; the other slots stay default AI). Turn-based `observe`/`act`/`pass` over the headless mock clock, which is frozen while the agent "thinks" and burns a fixed per-action time budget when it acts. Impl: `scripts/mcp-play/harness.ts` (`createMcpGame`). Tools: observe, check_placement, select_castle, place_cannon/end_cannon, place_piece, fire, `build_toward`/`build_path`/`bombard`/`breach`/`pit_strike` (intent actions = one call per build/battle), pass, enclose_plan, save/load. Each tool returns the resulting state rendered as an annotated ASCII board (`scripts/mcp-play/render.ts`, the TS port of the `tmp/show.py` lens); `observe({ format: 'json' })` returns the raw structured `Observation` instead (what the headless tests consume). NOT in determinism/parity suites (the agent slot is non-deterministic by design). **Fairness invariant:** any agent action whose COUNT is bounded by game-time — not by slots or reload — must be charged the *real* per-action cost, or the frozen-clock model becomes an exploit. Two such levers exist and must stay honest: build pieces cost `BUILD_PIECE_TICKS` (the measured AI per-piece cadence, ~78t), and firing is gated to the live battle window (`battleCountdown <= 0 && timer > 0`, matching `ai-phase-battle.ts`) so the agent can't out-build or out-fire opponents on clock speed. Cannon placement (slot-capped) and fire rate (reload-capped) are self-limiting and need no extra charge. **Debugging the server (agent-friendly):** `deno task replay <moves.jsonl>` (`scripts/mcp-play/replay.ts`) deterministically replays a `.jsonl` of bare tool calls (`{"name":..., "arguments":{...}}`, one per line — the shape an agent emits; `#`/`//` lines are comments) through the SAME dispatch the stdio server uses (`callTool`, exported from `server.ts`; `main()` is gated behind `import.meta.main` so importing it doesn't start the stdin reader), printing each rendered board so you can watch a session evolve in-process — no subprocess, no JSON-RPC plumbing. `new_game` is auto-synthesized from `--seed`/`--rounds`/`--ticks` unless the file opens with one; `--quiet` prints just the ROUND/STANDINGS/LAST lines, `--only-last` just the final board; exit code is 1 if any call errored (so a journal doubles as a smoke test). Example/template: `scripts/mcp-play/examples/round1-smoke.jsonl`. **Auto-journal (debug the last LIVE game):** every live session auto-records its tool-call stream to a replay-compatible `.jsonl` — `tmp/mcp-play/journal/seed-<seed>-<n>.jsonl`, mirrored to a stable `tmp/mcp-play/last.jsonl` (rotates at each `new_game`; read-only/meta tools like observe/check/save are skipped; the opener bakes in the resolved seed so a no-seed random game stays reproducible; `tmp/` is gitignored so it's always-on, no env gate). Alongside each journal a **baseline digest sidecar** is written — `last.expected.jsonl` (+ the per-session `.expected.jsonl`): one `{i, round, phase, per-player score/lives/walls/cannons/enclosedTowers}` line per journaled call (`observationDigest` in `server.ts`). So after a live game: `deno task replay tmp/mcp-play/last.jsonl --quiet` re-runs it against current code, and **`deno task replay tmp/mcp-play/last.jsonl --diff` reports the FIRST call where the game state diverges** from the recorded baseline ("DIVERGENCE at call N, round R, phase P" + changed fields; exit 1 on any divergence, 0 if identical) — that's how you tell whether a code change affects the recorded game and exactly where. `replay.ts` sets `MCP_PLAY_NO_JOURNAL=1` so replaying never clobbers `last.jsonl`. To branch on state (e.g. pick a valid super-cannon coord), write a `tmp/` scratch that imports `callTool` and reads `observe({format:'json'})` between calls. The legacy `tmp/play.sh` + `tmp/show.py` flow is superseded by this (rendering moved server-side into `render.ts`).
- Scratch scripts: write throwaway `.ts` scripts that import project code (`createScenario`, etc.) into the repo's gitignored `tmp/` dir and run them flagless — `deno run -A tmp/<name>.ts`. Do NOT use absolute `/tmp`: Deno discovers `deno.json` by walking up from the *entry file*, so a script in `/tmp` finds no config and loses the import map + `node_modules` + `sloppy-imports` (the `Import "three" not a dependency` error is just the first unresolved specifier, not a real three.js dependency — the headless path never renders 3D). If a script must live in `/tmp`, pass `--config <repo>/deno.json`.
- E2E: `deno run -A test/e2e/<name>.ts` (requires `npm run dev`); Playwright + `createE2EScenario` (async mirror of headless API) + bridge busLog snapshots
- Debug: use `/debug-e2e` skill — spawns a sub-agent that adds logs, runs tests, reports root cause. Never guess at bugs.
- Testing philosophy: tests play the game via `createScenario` + event bus listeners. Never hack runtime state (`state.phase =`, `state.lives =`), never construct subsystems in isolation, never bypass game flow.
- Refactor: `npm run refactor` — AST CLI (rename-symbol, move-export, rename-prop, rename-in-file, rename-file)
- Skills live in `skills/` (not ~/.claude/skills/)

## Architecture

### Directory structure
`src/` is organized into 9 domain directories matching `.domain-boundaries.json`:
`shared/` (types, constants, config) · `protocol/` (wire format: messages, routes, checkpoints) · `game/` (systems, phase logic) · `ai/` (AI strategy / decision logic only — no controllers) · `controllers/` (BaseController + Human + AI controller wrappers + factory) · `input/` (keyboard, mouse, touch handlers — true input only) · `render/` (canvas, sprites, layout, render UI) · `online/` (multiplayer, checkpoints, online runtime) · `runtime/` (game loop, state, lifecycle, UI deps-object contracts, sound/haptics observer sub-systems).
Entry points (`entry.ts`, `main.ts`, `online-client.ts`) stay at `src/` root. `server/` is separate (Deno Deploy target). `dev/` holds dev-only browser entries (ASCII debug renderer at `dev/ascii-renderer.ts`, sprite viewer at `dev/sprite-viewer-page.ts`) — outside the layer/cell system but type-checked, formatted, and linted alongside `src/`.

### Module layers (18 groups in 5 tiers, `.import-layers.json`)
Each layer falls within one of 5 tiers (`tierOfLayer(n)` in `scripts/cells/tier-of-layer.ts`): **types** (L0–L4) → **logic** (L5–L6) → **systems** (L7–L9) → **assembly** (L10–L13) → **roots** (L14–L17). Tier is a function of layer index, not a stored field — lint scripts (`lint-domain-boundaries.ts`, `lint-entry-placement.ts`) call the helper.
Layer index = import depth: `layer(f) = 1 + max(layer(dep))`, or 0 for files with no intra-project imports. Imports must flow downward (higher layer imports lower).
Layer names in `.import-layers.json` are just `"L0"`, `"L1"`, …, `"L17"` — pure mechanical indices, no semantic content. Role labeling lives in `.import-cells.json` (see "Module cells" below). Entry points sit at their minimum import-depth layer (`entry.ts` at L2, `main.ts` at L14, `online-client.ts` at L17).

### Module cells (`.import-cells.json`)
Each cell is a `(domain × layer)` intersection with a hand-curated `role` label. Cells are where naming actually happens — the layer-only view forced unrelated roles to share a label whenever they landed at the same import depth (e.g. an online wire payload and a shared event bus both at L3). Cells separate them by domain.
Workflow tools at `scripts/cells/`:
- `cell-lookup.ts "<role>"` — find which cell a new file should land in. Use this before grepping for similar files.
- `cell-edit-impact.ts <file>` — show same-cell peers, cross-cell consumers, and test consumers before editing a contract or wiring file.
- `regen-cells.ts` — regenerate the cell map after `generate-import-layers.ts`. `--check` mode fails if stale. The `LABELS` map inside the script is the source of truth for role names.
File → domain is derived from path (`src/X/...` → `X`, `src/<root>.ts` → `entry`, `server/...` → `server`), with the `exceptions` block in `.domain-boundaries.json` for role-overrides like `server/server.ts → entry`. Full workflow reference in `docs/cell-system.md`.

### Type file organization (L1–L4)
- `interaction-types.ts` (shared/ui, L1) — OptionsContext, QuitState, ControlsState, CastleBuildState, CastleWallPlan, GameOverFocus (genuinely-UI screen state)
- `geometry-types.ts` (L1) — TilePos, GameMap, Tower, Castle, House, BonusSquare, Viewport
- `battle-types.ts` (L2) — Cannon, Cannonball, Grunt, BurningPit, CapturedCannon, CannonMode, BattleAnimState
- `dialog-state.ts` (shared/core, L2) — LifeLostEntry, UpgradePickEntry, their *DialogState wrappers, LifeLostChoice, shouldAutoResolve (inter-round dialog *decision* state the AI + orchestrator mutate; not UI chrome)
- `player-types.ts` (L3) — Player, FreshInterior, and player helpers (isPlayerAlive, isPlayerSeated, emptyFreshInterior, brandFreshInterior)
- `types.ts` (L4) — GameState, ModernState, LobbyState, SelectionState, and state helpers (FrameContext is runtime-only — lives in `runtime/state.ts`)
- `system-interfaces.ts` (L4) — Controller interfaces and per-phase state slices: `GameViewState` (base: phase + players + map), `BuildViewState` (10 fields), `CannonViewState` (7), `BattleViewState` (15). Decouples controllers, AI strategy, and input/online modules from types.ts. Controllers return intent objects (`FireIntent`, `PlacePieceIntent`) instead of mutating state directly — the orchestrator (runtime, online, AI tick) executes mutations against the real mutable GameState.

### Spatial algorithms (`docs/spatial-algorithms.md`)
Read this before implementing features involving flood-fill, wall gaps, grunt movement, or territory detection. Key: `computeOutside` uses 8-dir (any 1-tile gap breaks enclosure); grunts move 4-dir only. Don't use `computeOutside` for chokepoint/gap detection — test cardinal barrier adjacency directly.

### Phase flow
Round 1 (special): CASTLE_SELECT (auto-built walls) → CANNON_PLACE → BATTLE → WALL_BUILD (score finalized) → ROUND_END
Round N≥2: CANNON_PLACE → BATTLE → WALL_BUILD (score finalized) → ROUND_END → loop
A round closes when WALL_BUILD's timer expires: `tickBuildPhase` dispatches the `enter-round-end` transition, whose mutate runs `finalizeRound` (emits `ROUND_END`), stashes the `{needsReselect, eliminated}` routing on `runtimeState.roundEnd`, and flips to the **ROUND_END phase**. ROUND_END is SELF-DRIVING (like UPGRADE_PICK): `tickRoundEndPhase` (phase-ticks.ts) drives two beats — the score-overlay (Mode.TRANSITION) then the life-lost dialog (Mode.LIFE_LOST) — then `exitRoundEnd` routes the next transition, all re-derived from state every frame (no armed callback), so a host-promoted peer resumes without a repair hatch (there is NO `forceResolveRoundEndPhase`; the generic teardown + re-tick converges). Before the dialog beat, `peekGameOverOutcome(state)` decides DISPLAY: if the match is over the interactive CONTINUE/ABANDON prompt is suppressed (only the button-less "Eliminated" notice shows). `exitRoundEnd` re-peeks `peekGameOverOutcome` (one call covering both the pre-dialog outcome and an ABANDON-created last-player-standing); on game-over GAME_END fires via the game-over transition and `state.round` is left at the closing value. Otherwise `state.round++` + ROUND_START are deferred to `exitRoundEnd` (AFTER the dialog) — so the round stays at the closing value through the whole window. The routing inputs are runtime-only (never serialized): a peer that ADOPTS a mid-ROUND_END snapshot re-derives `needsReselect` from the board (alive players with zero enclosed towers) and skips the cosmetic per-elimination notices. **Winner = highest score among alive players.** Eliminated players (lives = 0) cannot win while any opponent is still alive; among alive candidates remaining-lives count does not matter, only score does.
CASTLE_SELECT (the same phase used at game start) is re-entered between rounds when a player loses lives — the cycle type (initial vs reselect) is derived from `state.round` (1 vs >1) and the `pids` queue passed to `enterSelectionPhase` (omitted = initial cycle for every slot; the life-losers' ids = reselect cycle), not a separate phase tag. Per-player castle grace is tracked via `player.inGracePeriod`.
Modern mode adds two conditional phases: **MODIFIER_REVEAL** between CANNON_PLACE and BATTLE (entered only when a modifier rolled in `prepareBattleState`, 2s banner + dwell), and **UPGRADE_PICK** between BATTLE and WALL_BUILD (from round 3).

### Game modes and feature capabilities
- Classic: original Rampart rules, empty feature set
- Modern: all four feature capabilities active (modifiers + upgrades + combos + catapults)
- `gameMode` setting flows through GameSettings → InitMessage → GameState (immutable per match)
- `setGameMode()` atomically sets `gameMode`, `activeFeatures`, and `modern` — always use it, never assign fields directly
- Feature gates use `hasFeature(state, "featureId")` instead of `state.modern !== null`
- `activeFeatures: ReadonlySet<FeatureId>` on GameState determines which subsystems are active
- Four feature capabilities (`FeatureId` in `feature-defs.ts`):
  - **modifiers** — environmental effects (wildfire, grunt surge, frozen river). Roll + apply in phase-setup.ts. State: activeModifier, lastModifierId, frozenTiles.
  - **upgrades** — draft/pick system. Offer generation in prepareNextRound, pick UI in upgrade-pick.ts. State: pendingUpgradeOffers, masterBuilderLockout, masterBuilderOwners.
  - **combos** — scoring streaks during battle. Init/clear in phase-setup.ts, tracker logic in combos.ts (scored from battle-system.ts impact handlers). State: comboTracker.
  - **catapults** — modern grunt variant (~25% of spawns): slower movement, range-3 tower attack, deterministic wall siege. Gated by `hasFeature(state, "catapults")`.
- Upgrade offer generation happens in `prepareNextRound()` (battle-done) using synced RNG before the BUILD_START checkpoint; modifier roll happens in `prepareBattleState()` (cannon-place-done) before BATTLE_START.
- Upgrade effects (all reset in `prepareNextRound` at the next battle-done — i.e. active through one closing WALL_BUILD plus one CANNON_PLACE + BATTLE): Master Builder (+5s exclusive build time — non-owners locked out for 5s; multiple owners race each other), Rapid Fire (2x ball speed), Reinforced Walls (2-hit walls via damagedWalls set)
- Future features (tech tree, commanders) add new FeatureId values without forking existing if chains

### Extension point registries (pool pattern)
Five extension points use the same pool pattern (id type + pool array + compile-time exhaustiveness check + `implemented` flag):
- **Features**: `feature-defs.ts` — `FeatureId` + `FEATURE_POOL` + `FEATURE_CONSUMERS`. Guards use `hasFeature(state, id)`.
- **Upgrades**: `upgrade-defs.ts` — `UpgradeId` + `UPGRADE_POOL`. Draft-eligible filtered by `IMPLEMENTED_UPGRADES`.
- **Cannon modes**: `cannon-mode-defs.ts` — `CannonMode` + pool + `CANNON_MODE_CONSUMERS`. Centralizes size/slotCost.
- **Modifiers**: `modifier-defs.ts` — `ModifierId` + pool + `MODIFIER_CONSUMERS`. Centralizes labels/weights.
- **Battle events**: `battle-events.ts` — `BattleEvent`/`ImpactEvent` unions + `BATTLE_MESSAGE` constants + `BATTLE_EVENT_CONSUMERS`.

When adding a new entry to any of these registries:
1. Add the ID to the type union (or enum value, for cannon modes).
2. Add a pool entry with `implemented: false` (the `PoolComplete` compile-time check catches omissions).
3. Add an entry to the matching `*_CONSUMERS` map listing every file that implements the entry. The `satisfies Record<Id, ...>` clause forces exhaustiveness — adding a new ID without a matching consumer map is a compile error.
4. Implement the actual game logic in each consumer file.

For modifiers and upgrades specifically, read `docs/adding-modifiers-and-upgrades.md` — it has file-by-file checklists, hook point tables, and serialization requirements. Modifiers use a registry-driven dispatch (`MODIFIER_IMPLS` in `modifier-system.ts`) so `phase-setup.ts` never needs editing.

The single `lint-registries.ts` pre-commit check iterates all 4 `*_CONSUMERS` maps and verifies every listed file path exists on disk. Role-based string-presence checks (e.g. "the gate consumer must contain a `hasFeature()` call") were intentionally dropped — TypeScript exhaustiveness + scenario tests catch the same class of bug, and the role names in the consumer maps are now free-form documentation strings, not enforced fields.

### Game rules (non-obvious, guide correctness)
- Territory: flood-fill from edges, interior = not-outside, not-wall
- Tower revival: delayed — enclosed dead tower marked pending at end of build, revived only if still enclosed at end of *next* build (towerPendingRevive set)
- Dead cannons persist as debris (block space), cleared only on zone reset
- Burning pits: grass tiles blocked for 3 battle rounds
- Wall sweep: batch collect-then-delete, one layer per call, twice per round (end-of-cannon + deferred end-of-build)
- `recheckTerritory()` for mid-build use, `finalizeTerritoryWithScoring()` at end-of-build adds scoring + tower revival; final grunt sweep fixes race condition
- Grunt movement: ticks ONLY during WALL_BUILD — grunts are static for the entire BATTLE phase (battle plans against "grunts about to move" reason about the NEXT build, not the current battle); re-acquire the next nearest in-zone tower when the locked target dies (move on after a kill, don't park on the corpse — `lockGruntTarget`), pace back-and-forth when blocked by walls, stay put once adjacent to target tower
- Grunt distance: computed to nearest tile of 2x2 tower (not top-left corner)
- Zones fully isolated by rivers; no cross-zone interaction for grunts, walls, pieces (only cannonballs cross)

## Debugging
- ALWAYS prove the root cause with logs/evidence before attempting a fix. Never guess at fixes or skip reproduction steps.

## Bug Fixes
- Fix edge cases in the FIRST attempt. Before committing a fix, enumerate all callers/consumers and check: nulled references, execution order dependencies, and eliminated-player states.

## Refactoring
- When making type/rename refactors, always grep for the old name in Pick<>, local variables, comments, interfaces, and type aliases after the refactor tool runs. Run a full build to catch missed sites.
- After any multi-file rename or type change, run a full build (`tsc --noEmit` or equivalent) AND knip/lint before committing. Fix all propagation errors in the same commit.
- Use `npx knip --fix` to auto-remove unused exports/files/dependencies. Run after refactors instead of manually deleting dead exports.

## Architecture Audits
- Check git history for context before analyzing code. Start analysis immediately — do not spend excessive time on file discovery/glob calls.

### Conventions
- ESLint enforces min 2-char identifiers. When fixing a 1-letter name, choose an expressive name (e.g. `player`, `tower`), never a 2-letter abbreviation (`pl`, `tw`).
- File order: imports → types → constants → exported functions → private functions (enforced by pre-commit)
- Use `deno run -A scripts/cells/cell-lookup.ts "<role>"` to find where new code should go (e.g. "modifier effect", "wire payload", "AI strategy"). The cell map at `.import-cells.json` is the role → location index; `.import-layers.json` is the mechanical layer-index view.
- After adding a **new file**, run `deno run -A scripts/generate-import-layers.ts` to assign it a layer, then `deno run -A scripts/cells/regen-cells.ts` to refresh the cell map. Both have `--check` modes the pre-commit hook runs — the fix for a `--check` failure is always to regenerate, never to hand-assign. If `regen-cells` flags a new `(domain, layer)` cell, add a `LABELS` entry in `scripts/cells/regen-cells.ts`.
- Use `npx biome check --write <files>` for import sorting, never reorder manually
- Prefer spatial helpers (`isWater`, `isGrass`, `waterKeys`) over importing Tile enum directly
- Check existing helpers (`npm run export-search`) before inlining logic; create new helpers when a pattern appears 2+ times
- **Phase entry is owned by `game/`.** All `state.phase` mutation flows through `setPhase` in `phase-setup.ts`, wrapped by an `enter*Phase` helper in `phase-entry.ts` (one per phase: `enterCannonPhase`, `enterModifierRevealPhase`, `enterBattlePhase`, `enterUpgradePickPhase`, `enterWallBuildPhase`, `enterSelectionPhase`). Each helper sets the phase + primes any entry-time `state.timer` value. `enterSelectionPhase` covers both CASTLE_SELECT cycles — initial (round 1, omit `pids`) and reselect (round > 1, pass the queued players); cycle type is derived from `state.round`. Runtime transitions (in `runtime-phase-machine.ts`) call these helpers from their `mutate` — they do NOT call `setPhase` directly or write `state.phase` / entry-time `state.timer` inline. The deep-import allowlist in `scripts/lint-restricted-imports.ts` permits `setPhase` for one `online/` checkpoint-replay site only; everything else goes through `game/index.ts`.
