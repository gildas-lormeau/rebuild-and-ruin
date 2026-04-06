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
- Pre-commit hook (.git/hooks/pre-commit, plain git): reorder, tsc, biome format, biome check, eslint, knip, madge, jscpd, layers, domains, literals, architecture, entry-placement, restricted-imports, phase-transitions, typeof, null-init, battle-events, deno-lint, test:territory, export-index, hot-exports, readonly-params
- Server: `deno task server` (port 8001); type-check with `deno check server/server.ts` (NOT tsc)
- Test: `deno run test/headless.test.ts`, `deno run test/determinism.test.ts`, `deno run test/scenario.test.ts`, `deno run test/online-*.test.ts`
- Debug: use `/debug-e2e` skill — spawns a sub-agent that adds logs, runs tests, reports root cause. Never guess at bugs.
- Refactor: `npm run refactor` — AST CLI (rename-symbol, move-export, rename-prop, rename-in-file, rename-file)
- Skills live in `skills/` (not ~/.claude/skills/)

## Architecture

### Directory structure
`src/` is organized into 8 domain directories matching `.domain-boundaries.json`:
`shared/` (types, constants, config) · `game/` (systems, phase logic) · `ai/` (strategy, AI controllers) · `player/` (human controller, factory) · `input/` (input, sound, haptics) · `render/` (canvas, sprites, UI) · `online/` (multiplayer, checkpoints, online runtime) · `runtime/` (game loop, state, lifecycle).
Entry points (`entry.ts`, `main.ts`, `online-client.ts`) stay at `src/` root. `server/` is separate (Deno Deploy target).

### Module layers (19 groups, `.import-layers.json`)
L0 leaf modules → L1 geometry & config → L2 pieces → L3 core game types → L4 game state & orchestration → L5 online infrastructure → L6 runtime primitives → L7 game logic → L8 phase orchestration → L9 AI strategy → L10 controllers → L11 game bootstrap → L12 input & sound → L13 render → L14 runtime sub-systems → L15 online logic → L16 local runtime → L17 online runtime → L18 entry points (client & server). Imports must flow downward.
L18 is reserved for true entry points (e.g., `entry.ts`, `main.ts`, `server.ts`). Orchestration modules belong in L16/L17 — don't add files to L18 unless they have no in-project importers or use dynamic imports for code splitting.

### Type file organization (L3)
- `player-types.ts` — Player, FreshInterior, and player helpers (isPlayerAlive, isPlayerSeated, emptyFreshInterior, brandFreshInterior)
- `battle-types.ts` — Cannon, Cannonball, Grunt, BurningPit, CapturedCannon, CannonMode, BattleAnimState
- `geometry-types.ts` — TilePos, GameMap, Tower, Castle, House, BonusSquare, Viewport
- `types.ts` — GameState, ModernState, LobbyState, SelectionState, FrameContext, and state helpers
- `system-interfaces.ts` — Controller interfaces and per-phase state slices: `GameViewState` (base: phase + players + map), `BuildViewState` (10 fields), `CannonViewState` (7), `BattleViewState` (15). Decouples controllers, AI strategy, and input/online modules from types.ts. Controllers return intent objects (`FireIntent`, `PlacePieceIntent`) instead of mutating state directly — the orchestrator (runtime, online, AI tick) executes mutations against the real mutable GameState.

### Phase flow
CASTLE_SELECT → WALL_BUILD → CANNON_PLACE → BATTLE → loop (+ CASTLE_RESELECT when a player loses lives)
Modern mode inserts UPGRADE_PICK between battle end and build banner (from round 3).

### Game modes
- Classic: original Rampart rules, no modifiers or upgrades
- Modern: environmental modifiers (wildfire, crumbling walls, grunt surge, frozen river) + upgrade draft/pick each round
- `gameMode` setting flows through GameSettings → InitMessage → GameState (immutable per match)
- Modifier roll and upgrade offer generation happen in `enterBuildFromBattle()` using synced RNG (before BUILD_START checkpoint)
- Upgrade effects (all reset after one round): Master Builder (+5s exclusive build time — locks opponents when 1 owner, no lockout when 2+), Rapid Fire (2x ball speed), Reinforced Walls (2-hit walls via damagedWalls set)

### Extension point registries (pool pattern)
Three extension points use the same pool pattern (id type + pool array + compile-time exhaustiveness check + `implemented` flag):
- **Upgrades**: `upgrade-defs.ts` — `UpgradeId` + `UPGRADE_POOL`. Draft-eligible filtered by `IMPLEMENTED_UPGRADES`.
- **Cannon modes**: `cannon-mode-defs.ts` — `CannonMode` + pool. Centralizes size/slotCost (used by `cannonModeDef()`, `cannonSize()`, `cannonSlotCost()`). `CANNON_MODE_IDS` replaces the old manual `CANNON_MODES` set. `IMPLEMENTED_CANNON_MODES` drives the human controller cycle.
- **Modifiers**: `modifier-defs.ts` — `ModifierId` + pool. Centralizes labels/weights (used by `modifierDef()`, `IMPLEMENTED_MODIFIERS`). Labels moved here from game-constants.ts.
When adding a new entry: add the ID to the type union, add a pool entry with `implemented: false`, the compile-time check catches omissions.

### Battle event catalog (`.battle-event-catalog.json`)
Maps every BattleEvent/ImpactEvent union member to its consumer files by role (stateApply, sound, haptics, networkHandle, networkRelay, orchestrator, combo). When adding a new battle event type:
1. Define the message type in `server/protocol.ts`, add to BattleEvent or ImpactEvent union
2. Add a MESSAGE constant
3. Add a catalog entry listing all consumer files
4. Implement handlers in each declared consumer
The `lint-battle-events` pre-commit check verifies exhaustiveness.

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
