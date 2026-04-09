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
- Pre-commit hook (.git/hooks/pre-commit, plain git): reorder, tsc, biome format, biome check, eslint, knip, madge, jscpd, layers, domains, literals, architecture, entry-placement, restricted-imports, phase-transitions, typeof, null-init, battle-events, features, deno-lint, test:territory, export-index, hot-exports, readonly-params
- Server: `deno task server` (port 8001); type-check with `deno check server/server.ts` (NOT tsc)
- Test: `deno run test/headless.test.ts`, `deno run test/determinism.test.ts`, `deno run test/scenario.test.ts`, `deno run test/online-*.test.ts`
- Checkpoint parity: `npm run test:parity` (10 random seeds) or `npm run test:parity:quick` (seed 42). **Primary test for network/checkpoint bugs.** Runs local vs network games, compares at every phase boundary. Run after ANY change to online/, checkpoint, or serialization code. Custom seeds: `deno test --no-check test/checkpoint-parity.test.ts -- 9941 52 66`
- E2E: `deno run -A test/e2e-<name>.ts` (requires `npm run dev`); Playwright + E2EGame + render spy
- Debug: use `/debug-e2e` skill — spawns a sub-agent that adds logs, runs tests, reports root cause. Never guess at bugs.
- Refactor: `npm run refactor` — AST CLI (rename-symbol, move-export, rename-prop, rename-in-file, rename-file)
- Skills live in `skills/` (not ~/.claude/skills/)

## Architecture

### Directory structure
`src/` is organized into 8 domain directories matching `.domain-boundaries.json`:
`shared/` (types, constants, config) · `game/` (systems, phase logic) · `ai/` (strategy, AI controllers) · `player/` (human controller, factory) · `input/` (input, sound, haptics) · `render/` (canvas, sprites, UI) · `online/` (multiplayer, checkpoints, online runtime) · `runtime/` (game loop, state, lifecycle).
Entry points (`entry.ts`, `main.ts`, `online-client.ts`) stay at `src/` root. `server/` is separate (Deno Deploy target).

### Module layers (19 groups in 5 tiers, `.import-layers.json`)
Each layer group has a `tier` for quick orientation: **types** (L0–L4) → **logic** (L5–L6) → **systems** (L7–L9) → **assembly** (L10–L13) → **roots** (L14–L18).
L0 leaf modules → L1 foundational definitions → L2 derived types → L3 core game types → L4 core state & interfaces → L5 first logic → L6 deep logic → L7 handlers → L8 subsystems → L9 system implementations → L10 assembly → L11 controllers → L12 orchestration → L13 wiring → L14 composition roots → L15 app roots → L16 app entry → L17 online app → L18 online entry. Imports must flow downward (higher layer imports lower).
Groups are named by abstraction level, not by domain — files from any domain land at the layer dictated by their deepest import. Entry points sit at their minimum import-depth layer (`entry.ts` at L1, `main.ts` at L15, `online-client.ts` at L18).

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
CASTLE_SELECT → WALL_BUILD → CANNON_PLACE → BATTLE → loop (+ CASTLE_RESELECT when a player loses lives)
Modern mode inserts UPGRADE_PICK between battle end and build banner (from round 3).

### Game modes and feature capabilities
- Classic: original Rampart rules, empty feature set
- Modern: all three feature capabilities active (modifiers + upgrades + combos)
- `gameMode` setting flows through GameSettings → InitMessage → GameState (immutable per match)
- `setGameMode()` atomically sets `gameMode`, `activeFeatures`, and `modern` — always use it, never assign fields directly
- Feature gates use `hasFeature(state, "featureId")` instead of `state.modern !== null`
- `activeFeatures: ReadonlySet<FeatureId>` on GameState determines which subsystems are active
- Three feature capabilities (`FeatureId` in `feature-defs.ts`):
  - **modifiers** — environmental effects (wildfire, crumbling walls, grunt surge, frozen river). Roll + apply in phase-setup.ts. State: activeModifier, lastModifierId, frozenTiles.
  - **upgrades** — draft/pick system. Offer generation in enterBuildFromBattle, pick UI in upgrade-pick.ts. State: pendingUpgradeOffers, masterBuilderLockout, masterBuilderOwners.
  - **combos** — scoring streaks during battle. Init/clear in phase-setup.ts, scoring in combo-system.ts. State: comboTracker.
- Modifier roll and upgrade offer generation happen in `enterBuildFromBattle()` using synced RNG (before BUILD_START checkpoint)
- Upgrade effects (all reset after one round): Master Builder (+5s exclusive build time — locks opponents when 1 owner, no lockout when 2+), Rapid Fire (2x ball speed), Reinforced Walls (2-hit walls via damagedWalls set)
- Future features (tech tree, commanders) add new FeatureId values without forking existing if chains

### Extension point registries (pool pattern)
Four extension points use the same pool pattern (id type + pool array + compile-time exhaustiveness check + `implemented` flag):
- **Features**: `feature-defs.ts` — `FeatureId` + `FEATURE_POOL`. `MODERN_FEATURES` derived from `IMPLEMENTED_FEATURES`. `featureDef()` lookup used by `lint-features.ts`. Guards use `hasFeature(state, id)`.
- **Upgrades**: `upgrade-defs.ts` — `UpgradeId` + `UPGRADE_POOL`. Draft-eligible filtered by `IMPLEMENTED_UPGRADES`.
- **Cannon modes**: `cannon-mode-defs.ts` — `CannonMode` + pool. Centralizes size/slotCost (used by `cannonModeDef()`, `cannonSize()`, `cannonSlotCost()`). `CANNON_MODE_IDS` replaces the old manual `CANNON_MODES` set. `IMPLEMENTED_CANNON_MODES` drives the human controller cycle.
- **Modifiers**: `modifier-defs.ts` — `ModifierId` + pool. Centralizes labels/weights (used by `modifierDef()`, `IMPLEMENTED_MODIFIERS`). Labels moved here from game-constants.ts.
When adding a new entry: add the ID to the type union, add a pool entry with `implemented: false`, the compile-time check catches omissions.

### Battle event catalog (`.battle-event-catalog.json`)
Maps every BattleEvent/ImpactEvent union member to its consumer files by role (stateApply, sound, haptics, networkHandle, networkRelay, orchestrator, combo). When adding a new battle event type:
1. Define the message type in `src/shared/battle-events.ts`, add to BattleEvent or ImpactEvent union
2. Add a BATTLE_MESSAGE constant in `battle-events.ts` (protocol.ts spreads it into MESSAGE automatically)
3. Add the type to the ServerMessage union in `src/shared/protocol.ts`
4. Add a catalog entry listing all consumer files
5. Implement handlers in each declared consumer
The `lint-battle-events` pre-commit check verifies exhaustiveness.

### Feature catalog (`.feature-catalog.json`)
Maps every FeatureId to its consumer files by role (gate, stateAccess, serialize, checkpoint, render, ai). When adding a new feature capability:
1. Add the string literal to `FeatureId` union in `feature-defs.ts`
2. Add a pool entry with `implemented: false`
3. Add a catalog entry listing all consumer files
4. Add `hasFeature(state, "id")` guards in gate consumer files
5. Implement feature logic in each declared consumer
The `lint-features` pre-commit check verifies exhaustiveness (pool ↔ catalog ↔ consumer files).

### Game rules (non-obvious, guide correctness)
- Territory: flood-fill from edges, interior = not-outside, not-wall
- Tower revival: delayed — enclosed dead tower marked pending at end of build, revived only if still enclosed at end of *next* build (towerPendingRevive set)
- Dead cannons persist as debris (block space), cleared only on zone reset
- Burning pits: grass tiles blocked for 3 battle rounds
- Wall sweep: batch collect-then-delete, one layer per call, twice per battle
- `recheckTerritoryOnly()` for mid-build use, `finalizeTerritoryWithScoring()` at end-of-build adds scoring + tower revival; final grunt sweep fixes race condition
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

## Architecture Audits
- Check git history for context before analyzing code. Start analysis immediately — do not spend excessive time on file discovery/glob calls.

### Conventions
- ESLint enforces min 2-char identifiers. When fixing a 1-letter name, choose an expressive name (e.g. `player`, `tower`), never a 2-letter abbreviation (`pl`, `tw`).
- File order: imports → types → constants → exported functions → private functions (enforced by pre-commit)
- Always check `.import-layers.json` before placing new code in a file
- Use `npx biome check --write <files>` for import sorting, never reorder manually
- Prefer spatial helpers (`isWater`, `isGrass`, `waterKeys`) over importing Tile enum directly
- Check existing helpers (`npm run export-search`) before inlining logic; create new helpers when a pattern appears 2+ times
