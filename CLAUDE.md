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
- Pre-commit hook (.git/hooks/pre-commit, plain git): reorder, tsc, biome format, biome check, eslint, knip, madge, jscpd, layers, domains, literals, architecture, entry-placement, restricted-imports, phase-transitions, typeof, null-init, battle-events, features, modifiers, cannon-modes, deno-lint, test:scenario, test:determinism, export-index, hot-exports, readonly-params
- Server: `deno task server` (port 8001); type-check with `deno check server/server.ts` (NOT tsc)
- Test: `npm run test:scenario` (the gameplay tests — `test/scenario.test.ts`) and `npm run test:determinism` (replays bus event fixtures from `test/determinism-fixtures/`). Both use `createScenario({ seed, mode, rounds })` from `test/scenario.ts`, observe via `sc.bus.on(GAME_EVENT.X, ...)`, and use `waitForPhase` / `waitForBanner` / `waitForModifier` helpers. Online tests: `deno test --no-check test/online-*.test.ts`.
- Test API contract: `createScenario` returns `{ state, bus, tick, runUntil, runGame, now }`. There are NO methods to mutate state, scripted-place pieces, or skip phases. The AI plays the game end-to-end. If you need a specific game condition, find a seed that produces it (`scripts/find-seed.ts`).
- Determinism: `npm run test:determinism` replays each fixture in `test/determinism-fixtures/` and asserts the bus event log matches byte-for-byte. If a fixture diverges after a code change, the runtime is non-deterministic — revert or investigate. Only update a fixture (`npm run record-determinism -- --seed N --mode classic|modern`) when the divergence is expected and intentional. NEVER re-record to "fix" a failing test without justification.
- Headless runtime impl lives in `test/runtime-headless.ts` — `createHeadlessRuntime(opts)` returns the underlying driver. Tests should import from `test/scenario.ts` instead of touching the headless driver directly. (The file lives in `test/` because every option/method on it is test-only — it doesn't belong in production source.)
- E2E: `deno run -A test/e2e-<name>.ts` (requires `npm run dev`); Playwright + E2EGame + bridge state snapshots
- Debug: use `/debug-e2e` skill — spawns a sub-agent that adds logs, runs tests, reports root cause. Never guess at bugs.
- Testing philosophy: tests play the game via `createScenario` + event bus listeners. Never hack runtime state (`state.phase =`, `state.lives =`), never construct subsystems in isolation, never bypass game flow.
- Refactor: `npm run refactor` — AST CLI (rename-symbol, move-export, rename-prop, rename-in-file, rename-file)
- Skills live in `skills/` (not ~/.claude/skills/)

## Architecture

### Directory structure
`src/` is organized into 8 domain directories matching `.domain-boundaries.json`:
`shared/` (types, constants, config) · `game/` (systems, phase logic) · `ai/` (strategy, AI controllers) · `player/` (human controller, factory) · `input/` (input, sound, haptics) · `render/` (canvas, sprites, UI) · `online/` (multiplayer, checkpoints, online runtime) · `runtime/` (game loop, state, lifecycle).
Entry points (`entry.ts`, `main.ts`, `online-client.ts`) stay at `src/` root. `server/` is separate (Deno Deploy target).

### Module layers (17 groups in 5 tiers, `.import-layers.json`)
Each layer group has a `tier` for quick orientation: **types** (L0–L4) → **logic** (L5–L6) → **systems** (L7–L9) → **assembly** (L10–L13) → **roots** (L14–L16).
L0 leaf modules → L1 foundational definitions → L2 derived types → L3 core game types → L4 core state & interfaces → L5 first logic → L6 deep logic → L7 handlers → L8 subsystems → L9 system implementations → L10 assembly → L11 controllers → L12 orchestration → L13 wiring → L14 composition roots → L15 app roots → L16 app entry. Imports must flow downward (higher layer imports lower).
Groups are named by abstraction level, not by domain — files from any domain land at the layer dictated by their deepest import. Entry points sit at their minimum import-depth layer (`entry.ts` at L1, `main.ts` at L15, `online-client.ts` at L16).

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
- Always check `.import-layers.json` before placing new code in a file
- Use `npx biome check --write <files>` for import sorting, never reorder manually
- Prefer spatial helpers (`isWater`, `isGrass`, `waterKeys`) over importing Tile enum directly
- Check existing helpers (`npm run export-search`) before inlining logic; create new helpers when a pattern appears 2+ times
