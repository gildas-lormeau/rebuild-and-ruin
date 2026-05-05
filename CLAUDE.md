# Rebuild & Ruin

Rampart multiplayer remake for the web, tournament-style. Vite + TypeScript, no framework.
Online multiplayer via Deno Deploy + WebSocket (checkpoint-based sync, host migration, watcher ticks).

## Commands

- Build: `npm run build` (runs `tsc --noEmit && vite build` — always use this, never `npx vite build` alone)
- Format: `npm run format` (biome on src/ and server/); `npm run format:check` for CI; 2-space indent
- Lint: `npm run lint:all` — format:check, biome, knip, madge, jscpd (min-lines 15), lint:literals (baseline-aware), lint:typeof
- Layer linter: `deno run -A scripts/generate-import-layers.ts --check --server`; use `/import-hygiene` skill for full audit
- Export index: `npm run export-search -- <term>` before writing new code; `npm run export-index` to regenerate; `npm run export-map` for compact layer→file→symbols view
- Literals baseline: `.readonly-literals-baseline.json`; `--update-baseline` to refresh; `--all --files <globs>` for scoped reviews
- Pre-commit hook (.git/hooks/pre-commit, plain git): reorder + biome format (staged), tsc, biome check, knip, madge, eslint, jscpd, layers, lateral, domains, literals, imports, architecture, arch-non-runtime, entry-placement, restricted, checkpoint-fields, test-timeouts, raw-playwright, phase-transitions, typeof, null-init, registries, useless-guards, if-chain, passthrough, tile-mutators, shape-duplicates, dead-params, deno-check, deno-lint, fast tests (scenario, determinism, dev-speed, input-lobby, input-touch, haptics-observer, network-observer), export-index, export-map
- Server: `deno task server` (port 8001); type-check with `deno check server/server.ts` (NOT tsc)
- Test: `npm run test:scenario` (the gameplay tests — `test/scenario.test.ts`) and `npm run test:determinism` (replays bus event fixtures from `test/determinism-fixtures/`). Both use `createScenario({ seed, mode, rounds })` from `test/scenario.ts`, observe via `sc.bus.on(GAME_EVENT.X, ...)`, and use `waitForPhase` / `waitForBanner` / `waitForModifier` helpers. Online tests: `deno test --no-check test/online-*.test.ts`.
- Test API contract: `createScenario` returns `{ state, bus, tick, runUntil, runGame, tileAt, now }`. There are NO methods to mutate state, scripted-place pieces, or skip phases. The AI plays the game end-to-end. If you need a specific game condition, find a seed that produces it (`scripts/find-seed.ts`).
- Test API timeout shape: `runUntil` / `runGame` / `waitFor*` all take `{ timeoutMs }` — sim-ms on headless (mock clock), wall-clock ms on E2E. There is no `maxTicks` / `maxFrames`. `tick(N)` is the frame-denominated precision tool; `runUntil` is the budget-denominated wait tool. `lint:test-timeouts` enforces this.
- Determinism: `npm run test:determinism` replays each fixture in `test/determinism-fixtures/` and asserts the bus event log matches byte-for-byte. If a fixture diverges after a code change, the runtime is non-deterministic — revert or investigate. Only update a fixture (`npm run record-determinism -- --seed N --mode classic|modern`) when the divergence is expected and intentional. NEVER re-record to "fix" a failing test without justification.
- Headless runtime impl lives in `test/runtime-headless.ts` — `createHeadlessRuntime(opts)` returns the underlying driver. Tests should import from `test/scenario.ts` instead of touching the headless driver directly. (The file lives in `test/` because every option/method on it is test-only — it doesn't belong in production source.)
- E2E: `deno run -A test/e2e-<name>.ts` (requires `npm run dev`); Playwright + `createE2EScenario` (async mirror of headless API) + bridge busLog snapshots
- Debug: use `/debug-e2e` skill — spawns a sub-agent that adds logs, runs tests, reports root cause. Never guess at bugs.
- Testing philosophy: tests play the game via `createScenario` + event bus listeners. Never hack runtime state (`state.phase =`, `state.lives =`), never construct subsystems in isolation, never bypass game flow.
- Refactor: `npm run refactor` — AST CLI (rename-symbol, move-export, rename-prop, rename-in-file, rename-file)
- Skills live in `skills/` (not ~/.claude/skills/)

## Architecture

### Directory structure
`src/` is organized into 9 domain directories matching `.domain-boundaries.json`:
`shared/` (types, constants, config) · `protocol/` (wire format: messages, routes, checkpoints) · `game/` (systems, phase logic) · `ai/` (AI strategy / decision logic only — no controllers) · `controllers/` (BaseController + Human + AI controller wrappers + factory) · `input/` (keyboard, mouse, touch handlers — true input only) · `render/` (canvas, sprites, layout, render UI) · `online/` (multiplayer, checkpoints, online runtime) · `runtime/` (game loop, state, lifecycle, UI deps-object contracts, sound/haptics observer sub-systems).
Entry points (`entry.ts`, `main.ts`, `online-client.ts`) stay at `src/` root. `server/` is separate (Deno Deploy target).

### Module layers (19 groups in 5 tiers, `.import-layers.json`)
Each layer group has a `tier` for quick orientation: **types** (L0–L4) → **logic** (L5–L6) → **systems** (L7–L9) → **assembly** (L10–L13) → **roots** (L14–L18).
L0 leaf modules → L1 foundational types → L2 derived types & local entry → L3 wire format & config types → L4 core game state & server stubs → L5 first logic → L6 upgrades, modifiers & runtime contracts → L7 cross-domain handlers → L8 subsystems → L9 system implementations → L10 mid-depth assembly → L11 system composition → L12 phase orchestration → L13 wiring → L14 composition roots → L15 session & runtime lifecycle → L16 app wiring → L17 app entry → L18 online client entry. Imports must flow downward (higher layer imports lower).
Groups are named by abstraction level, not by domain — files from any domain land at the layer dictated by their deepest import. Entry points sit at their minimum import-depth layer (`entry.ts` at L2, `main.ts` at L17, `online-client.ts` at L18).

### Type file organization (L1–L4)
- `interaction-types.ts` (L1) — LifeLostDialogState, UpgradePickDialogState, ControlsState, CastleBuildState, CastleWallPlan, GameOverFocus
- `geometry-types.ts` (L1) — TilePos, GameMap, Tower, Castle, House, BonusSquare, Viewport
- `battle-types.ts` (L2) — Cannon, Cannonball, Grunt, BurningPit, CapturedCannon, CannonMode, BattleAnimState
- `player-types.ts` (L3) — Player, FreshInterior, and player helpers (isPlayerAlive, isPlayerSeated, emptyFreshInterior, brandFreshInterior)
- `types.ts` (L4) — GameState, ModernState, LobbyState, SelectionState, FrameContext, and state helpers
- `system-interfaces.ts` (L4) — Controller interfaces and per-phase state slices: `GameViewState` (base: phase + players + map), `BuildViewState` (10 fields), `CannonViewState` (7), `BattleViewState` (15). Decouples controllers, AI strategy, and input/online modules from types.ts. Controllers return intent objects (`FireIntent`, `PlacePieceIntent`) instead of mutating state directly — the orchestrator (runtime, online, AI tick) executes mutations against the real mutable GameState.

### Spatial algorithms (`docs/spatial-algorithms.md`)
Read this before implementing features involving flood-fill, wall gaps, grunt movement, or territory detection. Key: `computeOutside` uses 8-dir (any 1-tile gap breaks enclosure); grunts move 4-dir only. Don't use `computeOutside` for chokepoint/gap detection — test cardinal barrier adjacency directly.

### Phase flow
Round 1 (special): CASTLE_SELECT (auto-built walls) → CANNON_PLACE → BATTLE → WALL_BUILD (score finalized)
Round N≥2: CANNON_PLACE → BATTLE → WALL_BUILD (score finalized) → loop
A round closes at the end of WALL_BUILD when the score is displayed (`finalizeRound` emits `ROUND_END`). The `round-end` transition's mutate then peeks for game-over via `peekGameOverOutcome(state)` BEFORE the life-lost dialog displays — if the match is over, the popup is suppressed (its CONTINUE/ABANDON choice is moot), GAME_END fires from postDisplay (after the score overlay), and `state.round` is left at the closing-round value. Otherwise, `state.round++` + ROUND_START fire and the popup runs normally. **Winner = highest score among alive players.** Eliminated players (lives = 0) cannot win while any opponent is still alive; among alive candidates remaining-lives count does not matter, only score does.
CASTLE_RESELECT inserted between rounds when a player loses lives.
Modern mode: UPGRADE_PICK between BATTLE and WALL_BUILD (from round 3).

### Game modes and feature capabilities
- Classic: original Rampart rules, empty feature set
- Modern: all three feature capabilities active (modifiers + upgrades + combos)
- `gameMode` setting flows through GameSettings → InitMessage → GameState (immutable per match)
- `setGameMode()` atomically sets `gameMode`, `activeFeatures`, and `modern` — always use it, never assign fields directly
- Feature gates use `hasFeature(state, "featureId")` instead of `state.modern !== null`
- `activeFeatures: ReadonlySet<FeatureId>` on GameState determines which subsystems are active
- Three feature capabilities (`FeatureId` in `feature-defs.ts`):
  - **modifiers** — environmental effects (wildfire, crumbling walls, grunt surge, frozen river). Roll + apply in phase-setup.ts. State: activeModifier, lastModifierId, frozenTiles.
  - **upgrades** — draft/pick system. Offer generation in prepareNextRound, pick UI in upgrade-pick.ts. State: pendingUpgradeOffers, masterBuilderLockout, masterBuilderOwners.
  - **combos** — scoring streaks during battle. Init/clear in phase-setup.ts, scoring in combo-system.ts. State: comboTracker.
- Upgrade offer generation happens in `prepareNextRound()` (battle-done) using synced RNG before the BUILD_START checkpoint; modifier roll happens in `prepareBattleState()` (cannon-place-done) before BATTLE_START.
- Upgrade effects (all reset in `prepareNextRound` at the next battle-done — i.e. active through one closing WALL_BUILD plus one CANNON_PLACE + BATTLE): Master Builder (+5s exclusive build time — locks opponents when 1 owner, no lockout when 2+), Rapid Fire (2x ball speed), Reinforced Walls (2-hit walls via damagedWalls set)
- Future features (tech tree, commanders) add new FeatureId values without forking existing if chains

### Extension point registries (pool pattern)
Four extension points use the same pool pattern (id type + pool array + compile-time exhaustiveness check + `implemented` flag):
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
- Wall sweep: batch collect-then-delete, one layer per call, twice per battle
- `recheckTerritory()` for mid-build use, `finalizeTerritoryWithScoring()` at end-of-build adds scoring + tower revival; final grunt sweep fixes race condition
- Grunt movement: no retargeting after tower kill, pace back-and-forth when blocked by walls, stay put once adjacent to target tower
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
- Always check `.import-layers.json` before placing new code in a file. Array index = layer number (L0 leaves → L18 entry points). Imports flow downward by number.
- After adding a **new file**, run `deno run -A scripts/generate-import-layers.ts --server` to assign it a layer, then review the diff. The pre-commit `--check` fails if any file is missing from the map — the fix is always to regenerate, never to hand-assign (the generator computes the layer from imports).
- Use `npx biome check --write <files>` for import sorting, never reorder manually
- Prefer spatial helpers (`isWater`, `isGrass`, `waterKeys`) over importing Tile enum directly
- Check existing helpers (`npm run export-search`) before inlining logic; create new helpers when a pattern appears 2+ times
- **Phase entry is owned by `game/`.** All `state.phase` mutation flows through `setPhase` in `phase-setup.ts`, wrapped by an `enter*Phase` helper in `game-engine.ts` (one per phase: `enterCannonPhase`, `enterModifierRevealPhase`, `enterBattlePhase`, `enterUpgradePickPhase`, `enterWallBuildPhase`, `enterReselectPhase`, `setReselectPhase`). Each helper sets the phase + primes any entry-time `state.timer` value. Runtime transitions (in `runtime-phase-machine.ts`) call these helpers from their `mutate` — they do NOT call `setPhase` directly or write `state.phase` / entry-time `state.timer` inline. The deep-import allowlist in `scripts/lint-restricted-imports.ts` permits `setPhase` for two `online/` checkpoint-replay sites only; everything else goes through `game/index.ts`.
