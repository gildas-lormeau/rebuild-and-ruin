# `src/game/` — Pure game logic

The **game** domain is the heart of the simulation: phase machine, map
generation, castle/wall construction, cannon placement and firing,
cannonball physics, grunt AI (movement + lifecycle), territory claim
via flood-fill, upgrades, round modifiers, combo scoring, and all the
rules that define what "playing Rampart" means.

This domain is **100% pure** — every file here imports only from
`shared/`. No I/O, no rendering, no input handling, no networking, no
browser globals. You can run every function in this folder from a
Deno REPL with zero setup. That constraint is what lets the whole
game drive deterministically from a single seed, and it's what makes
the determinism fixtures (`test/determinism-fixtures/`) work.

## Read these first (in order)

1. **[game-engine.ts](./game-engine.ts)** — State machine + state
   factory. Documents the phase order (`CASTLE_SELECT → WALL_BUILD →
   CANNON_PLACE → BATTLE → loop`) and the state initialization
   primitives. **Start here for the "what phase does what" mental
   model.**

2. **[phase-setup.ts](./phase-setup.ts)** — Phase transition recipes.
   The multi-step sequences that run when entering/leaving a phase
   (e.g., `enterBattleFromCannon` rolls modifiers, initializes
   combos, snapshots castles, and emits events). This is where you
   look when a bug happens "between phases."

3. **[battle-system.ts](./battle-system.ts)** — Cannon firing,
   cannonball physics, impact events, balloon capture. The hot path
   during BATTLE phase.

4. **[build-system.ts](./build-system.ts)** — Piece placement,
   territory claim via flood-fill, wall sweep rules. The hot path
   during WALL_BUILD phase. Also contains `finalizeTerritoryWithScoring()`
   which is where end-of-build scoring happens.

5. **[grunt-system.ts](./grunt-system.ts)** + **[grunt-movement.ts](./grunt-movement.ts)**
   — Grunt spawn/tick/target-lock + 4-directional pathfinding. The
   "when should the tower die?" logic.

## File categories

### State machine + factory
- **`game-engine.ts`** — `createGameState()`, the canonical state
  factory. Initializes all default fields including the event bus, the
  empty entity overlay, and the modern-state slot. When you need to
  see "what fields does GameState have?", this is the authoritative
  answer alongside `src/shared/core/types.ts`.
- **`phase-setup.ts`** — `enterBattleFromCannon`,
  `enterBuildFromBattle`, `enterCannonFromBuild`, etc. — one per
  transition. Also owns `applyBattleStartModifiers()`,
  `awardComboBonuses()`, `resetZoneState()`.

### Per-phase systems
- **`build-system.ts`** — Wall/piece placement, territory flood-fill,
  wall sweep, end-of-build scoring. Call `canPlacePiece()` for
  placement validation, `placePiece()` to apply, `deletePlayerWalls()`
  for cleanup.
- **`cannon-system.ts`** — Cannon placement validation, slot
  accounting, cannon mode branching (NORMAL / SUPER / BALLOON /
  RAMPART), placement preview. `applyCannonPlacement()` is the
  mutation entry point.
- **`battle-system.ts`** — Cannon firing, cannonball physics
  (`advanceCannonball`), impact event application
  (`applyImpactEvent`), balloon capture rules, wall shield logic,
  `nextReadyCombined()` for controller fire dispatch.
- **`grunt-system.ts`** — Grunt spawning, respawning, blocked-state
  tracking, tower-kill detection. See **[docs/spatial-algorithms.md](../../docs/spatial-algorithms.md)**
  for the flood-fill / pathfinding rules (non-obvious and load-bearing).
- **`grunt-movement.ts`** — Pathfinding (4-directional only, unlike
  8-directional flood-fill for territory), target locking (no
  retargeting after tower kill), pace-back-and-forth when blocked.

### Generation (one-shot per game / round)
- **`map-generation.ts`** — Rampart-style map: river carving, zone
  partitioning, tower placement, grass/water distribution. Seeded
  via `Rng`.
- **`castle-generation.ts`** — Initial castle walls when a player
  selects a tower. Called from selection phase.
- **`selection.ts`** — Tower selection phase logic (initial +
  reselect after life loss). Owns `applyClumsyBuilders` (the
  upgrade that partially destroys castle walls during rebuild).

### Cross-phase / global
- **`combo-system.ts`** — Combo scoring streaks during battle. Init
  in `enterBattleFromCannon`, scoring in `scoreImpactCombo`, final
  awards in `awardComboBonuses`. Gated by `hasFeature(state, "combos")`.
- **`round-modifiers.ts`** — Environmental modifiers (wildfire,
  crumbling walls, grunt surge, frozen river, sinkhole, high tide,
  dust storm, rubble clearing). Each has an `apply` function.
  `rollModifier()` picks the next one using seeded RNG. Gated by
  `hasFeature(state, "modifiers")`.
- **`upgrade-system.ts`** + **[upgrades/](./upgrades/)** — Upgrade
  effects (Master Builder, Rapid Fire, Reinforced Walls, etc.).
  Each upgrade lives in its own file in `upgrades/`. The pool +
  consumer map live in `src/shared/core/upgrade-defs.ts`.
- **`phase-banner.ts`** — Pre-banner state snapshot logic (captures
  castles/walls before a phase transition so the banner can cross-fade
  from old to new). Called right before `enterBuildFromBattle` etc.
- **`game-actions.ts`** — `executePlacePiece(state, intent, ctrl)`,
  `executeCannonFire(state, intent, ctrl)` — the mutation executors
  called by the orchestrator (runtime / online / AI tick) when a
  controller returns an intent. **Controllers return intents;
  orchestrators execute.** These are the orchestration entry points.

### Barrel export
- **`index.ts`** — Public surface of `src/game/` for other domains to
  import. `runtime/` and `online/` import from here, not from
  individual files. When you add a new export you expect consumers
  outside `game/` to use, add it to `index.ts`.

### Upgrades subfolder
Each upgrade has its own file in `src/game/upgrades/`. When adding a
new upgrade:
1. Add the ID to `UpgradeId` in `src/shared/core/upgrade-defs.ts` +
   add a pool entry (set `implemented: false` until you have working code).
2. Create `src/game/upgrades/<name>.ts` with the effect logic.
3. Wire the effect into `src/game/upgrade-system.ts` (the dispatch layer).
4. Add an entry to `UPGRADE_POOL` with `implemented: true` once the
   code works.

The existing upgrade files are well-commented and form a good
reference library — see `master-builder.ts`, `rapid-fire.ts`, and
`reinforced-walls.ts` for three different effect patterns.

## Common operations

### Add a new phase transition step
Look at `phase-setup.ts`. Existing transitions like
`enterBattleFromCannon` document the standard ordering:
event emission → state mutation → RNG → checkpoint emission → banner snapshot.
If your new step needs to run at a specific point, read the existing
steps for the correct insertion position.

### Add a new battle event type
See `.feature-catalog` / `CLAUDE.md` "Battle event catalog" section.
Shape:
1. Define the message interface in `src/shared/core/battle-events.ts`
2. Add to the `BattleEvent` or `ImpactEvent` union
3. Add a `BATTLE_MESSAGE.*` constant
4. Add a `BATTLE_EVENT_CONSUMERS[<id>]` entry for the files that handle it
5. Implement the handler in each declared consumer file (at minimum:
   `battle-system.ts` `applyImpactEvent` switch, sound/haptics if relevant)

The `lint-registries.ts` script will catch you if you miss a consumer
file path; TypeScript's `satisfies` clause will catch you if you miss
a union member.

### Add a new environmental modifier
See `round-modifiers.ts` for the pattern. Each modifier has:
- An `apply*` function that mutates state (and optionally records tile state)
- A `clear*` / `reapply*` function if it needs checkpoint restore
- A `MODIFIER_CONSUMERS[<id>]` entry in `modifier-defs.ts`

Existing modifiers cover the full matrix: pure effects (`wildfire`),
stateful effects (`frozen_river`, `sinkhole`, `high_tide`), and
multi-round effects (`dust_storm`).

### Add a new upgrade
See `src/game/upgrades/` for examples. Pattern:
1. Create the file with the effect logic
2. Wire into `upgrade-system.ts`
3. Add to the pool + consumer map in `src/shared/core/upgrade-defs.ts`
4. Tests: `test/upgrades/<upgrade-name>.test.ts` — verify the effect fires

## Gotchas

- **Territory flood-fill is 8-directional, grunt movement is
  4-directional.** This is intentional: `computeOutside` uses 8-dir
  (any 1-tile gap breaks enclosure), but grunts can only move cardinally.
  **Don't use `computeOutside` for chokepoint/gap detection** —
  test cardinal barrier adjacency directly. See
  [docs/spatial-algorithms.md](../../docs/spatial-algorithms.md) for
  the full rationale.

- **Tower revival is delayed.** An enclosed dead tower is marked
  `pendingRevive` at end-of-build, then revived only if it's STILL
  enclosed at the end of the *next* build. One build of grace is
  not enough. See `build-system.ts` `finalizeTerritoryWithScoring`.

- **Dead cannons persist as debris.** Cleared only on zone reset
  (after life loss), not between rounds. `isCannonAlive()` filters
  them when iterating.

- **Zones are fully isolated.** No cross-zone interaction for grunts,
  walls, pieces — only cannonballs cross. If you're iterating entities
  for a cross-zone effect, explicitly scope to one zone; don't
  accumulate across all players.

- **Wall sweep is two layers per battle, not one.** `sweepOuterWalls`
  is called twice in `enterBuildFromBattle`. This is balance-load-bearing.

- **Grunts spawn distance is measured to the nearest tile of the
  2x2 tower, not the top-left corner.** `distanceToTower` is correct;
  plain `tilesFrom(tower)` is not.

- **`recheckTerritory()` vs `finalizeTerritoryWithScoring()`.**
  `recheckTerritory` is for mid-build use; `finalizeTerritoryWithScoring`
  at end-of-build adds scoring + tower revival + a final grunt sweep
  that fixes a race condition. Don't mix them up.

- **Controllers return intents, game mutates.** If you're adding a new
  controller method, return `XxxIntent | null`, and add an
  `executeXxx` function in `game-actions.ts` that the orchestrator
  calls. Don't mutate `state` from inside a controller.

- **Pool pattern exhaustiveness checks are compile-time.** If you
  add a new `UpgradeId` without a matching `UPGRADE_POOL` entry,
  TypeScript will complain. Same for modifiers, cannon modes, features,
  and battle events. Trust the type system.

- **AI lives in `src/ai/`, not here.** Game rules are in `game/`, AI
  decision-making is in `ai/`. `ai/` can import from `game/` but
  not vice versa. If you're making a balance decision, it goes here;
  if you're making a strategy decision, it goes there.

## Related reading

- **[src/shared/core/](../shared/core/)** — Game core types:
  `types.ts` (GameState), `player-types.ts` (Player), `battle-types.ts`
  (Cannon, Cannonball, Grunt), `battle-events.ts` (event union),
  `pieces.ts`, `grid.ts`, `spatial.ts`, `board-occupancy.ts`.
- **[docs/spatial-algorithms.md](../../docs/spatial-algorithms.md)** —
  Flood-fill rules, grunt movement constraints, interior caching,
  gap detection pitfalls. **Read this before touching grunt or
  territory code.**
- **[docs/protocol.md](../../docs/protocol.md)** — Wire protocol,
  checkpoint shapes, event relay behavior. Useful if you're debugging
  a "local works, online doesn't" issue.
- **[skills/debug.md](../../skills/debug.md)** — Debugging workflow
  using the scenario API. The scenario API plays real games and
  observes events; don't reach inside state directly.
- **[CLAUDE.md](../../CLAUDE.md)** — Top-level architecture summary,
  test API contract, extension point registries, non-obvious game rules.
