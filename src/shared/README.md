# `src/shared/` — Cross-domain foundation

Everything that multiple domains depend on lives here: game state
types, UI state types, platform primitives, geometry, spatial
helpers, deterministic simulation behavior, pool registries, the
event bus. Every non-entry domain (`protocol`, `game`, `ai`,
`controllers`, `input`, `render`, `online`, `runtime`) imports from
`shared/`; nothing else is allowed to import laterally.

**Invariant: `src/shared/` has four subfolders and zero loose files.**
If you're tempted to add a file at `shared/` root, something is
uncategorized — pick the right subfolder or decide the file doesn't
belong in `shared/` at all. This invariant is the point of the
subfolder structure; don't erode it.

## The four subfolders

### `shared/core/` — game core types
The shared surface of the `game` domain. Types, enums, pool
registries, interfaces that `game/` and everyone else agree on.

- **State**: `types.ts` (GameState), `player-types.ts` (Player),
  `player-slot.ts` (PlayerId, ValidPlayerId), `battle-types.ts`
  (Cannon, Cannonball, Grunt, BurningPit).
- **Constants + enums**: `game-constants.ts` (balance tuning),
  `game-phase.ts` (Phase enum + predicates), `grid.ts` (dimensions +
  Tile enum).
- **Pools** (pattern documented in `CLAUDE.md` "Extension point
  registries"): `feature-defs.ts`, `upgrade-defs.ts`, `modifier-defs.ts`,
  `cannon-mode-defs.ts`. Each holds the `*_POOL`, `*_CONSUMERS`,
  compile-time `PoolComplete` check, and helper lookups.
- **Events**: `battle-events.ts` (BattleEvent / ImpactEvent unions +
  BATTLE_MESSAGE constants + `BATTLE_EVENT_CONSUMERS`),
  `game-event-bus.ts` (typed pub/sub).
- **Spatial**: `geometry-types.ts` (TilePos, Viewport, GameMap),
  `spatial.ts` (packTile/unpackTile, tile helpers, castle center
  math, the `computeOutside` flood). The board-occupancy *queries*
  and piece-bag *logic* live in `shared/sim/`; `pieces.ts` here holds
  only the `PieceShape` / `BagState` types.
- **System contracts**: `system-interfaces.ts` (PlayerController,
  BuildViewState, CannonViewState, BattleViewState, HapticsSystem,
  SoundSystem — the cross-domain interfaces).

**When to add here:** the new file is a *type* or *enum* or *pool
definition* consumed by game/ AND at least one other domain.
**When NOT to add here:** if it's game-only logic (mutation functions
used by a single domain), it goes in `src/game/`. If it's *shared*
deterministic sim behavior (board/bag/interior mutation or `state.rng`
draws needed by 2+ domains), it goes in `shared/sim/`. If it's UI
state, `shared/ui/`. If it's a wire format, it goes in the top-level
`src/protocol/` domain — not under `shared/`.

### `shared/sim/` — deterministic simulation behavior
Game *logic* (mutation + query functions over the `Player` / board
structs) that more than one domain needs and that must run
**symmetrically on every peer**. This is the behavior counterpart to
`shared/core`'s types: the struct modules in `core/` carry no logic,
so the write-surfaces and board algorithms live here instead.
Consumed by `game/`, `ai/`, and `runtime/`.

- **`board-occupancy.ts`** — wall / interior / territory occupancy
  *queries* (`hasWallAt`, `collectOccupiedTiles`, `getBattleInterior`,
  `buildOccupancyCache`, the cardinal-obstacle mask).
- **`occupancy-queries.ts`** — captured-cannon predicates
  (`isCannonCaptured`, `isCannonCapturedBy`, `isCannonCapturedFrom`).
- **`player-walls.ts`** — the canonical write-surface for every
  `player.walls` mutation. Build edits call `markWallsDirty`;
  battle/modifier `delete*` edits intentionally skip dirty-marking
  (interior is stale by design during battle, rechecked next phase).
- **`player-interior.ts`** — interior freshness via lazy epoch pairs
  (`wallsEpoch` / `interiorEpoch`): `markWallsDirty`,
  `recomputeInterior`, `assertInteriorFresh`.
- **`player-bag.ts`** — the piece-bag lifecycle (`advancePlayerBag`,
  `clearAllPlayerBags`). Drives `state.rng`, so it must run on every
  peer in the same order.
- **`pieces.ts`** — the bag *algorithm* (shape catalog, round-weighted
  generation, draw + rotation) over the `PieceShape` / `BagState`
  types declared in `shared/core/pieces.ts`.

**When to add here:** a function (not a type) that mutates a board
collection or draws from `state.rng`, carries a determinism contract,
and is needed by 2+ domains. **When NOT:** pure types/enums →
`shared/core/`; logic only one domain uses → that domain (e.g.
`src/game/`); a pure derived query with no determinism contract used
by a single domain → that domain.

### `shared/ui/` — UI/interaction types
UI state types + interaction DTOs consumed by `runtime/`, `render/`,
and `input/`.

- **`ui-contracts.ts`** — `UIContext`, `BannerState`, `BannerShow`,
  `CreateXOverlayFn` factory types, touch UI factory types. The
  interface between the composition root and render subsystems.
- **`overlay-types.ts`** — `RenderOverlay`, `EntityOverlay`, `CastleData`,
  `PlayerStats`, `GameOverOverlay`, `RendererInterface`, `LoupeHandle`.
  Per-frame render payload types.
- **`ui-mode.ts`** — `Mode` enum + predicates (`isInteractiveMode`,
  `isGameplayMode`). The orthogonal "what UI state am I in" axis
  (LOBBY / GAME / OPTIONS / BANNER / LIFE_LOST / UPGRADE_PICK /
  BALLOON_ANIM / SELECTION / STOPPED).
- **`input-action.ts`** — `Action` enum (abstracted input actions
  decoupled from raw keycodes).
- **`interaction-types.ts`** — `LifeLostDialogState`,
  `UpgradePickDialogState`, `CastleBuildState`, `ControlsState`,
  `GameOverFocus`, `AutoResolveDeps`. Transient dialog/interaction
  state that lives on `runtimeState.dialogs.*`.
- **`player-config.ts`** — `KeyBindings`, `GameSettings`, `PLAYER_NAMES`,
  `PLAYER_COLORS`, `MAX_PLAYERS`, `computeGameSeed()`. Player/settings
  config.
- **`settings-defs.ts`** — Option labels, option keys, hit test
  constants. Declarative options menu schema.
- **`settings-ui.ts`** — `cycleOption`, `formatKeyName`. Functions
  the options menu uses.
- **`theme.ts`** — Color constants, font constants, `rgb()` helper.
  Visual theme.
- **`canvas-layout.ts`** — `computeLetterboxLayout()` — letterbox
  math for the canvas. Pure geometry, no DOM.
- **`router.ts`** — `GAME_CONTAINER_ACTIVE` CSS class name,
  `GAME_EXIT_EVENT` DOM event name. UI routing primitives.

**When to add here:** UI state types, theme constants, interaction
DTOs, or anything consumed by runtime/render/input for per-frame
work.

### `shared/platform/` — zero-dep primitives
Generic utilities with no game knowledge. If you removed the game
entirely, these files would still be valid.

- **`platform.ts`** — `IS_DEV`, `IS_TOUCH_DEVICE`, cursor constants.
  Environment detection.
- **`rng.ts`** — `Rng` class (seeded deterministic RNG),
  `createSeededRng()`, `MAX_UINT32`.
- **`utils.ts`** — `assertNever()`, generic TS helpers.
- **`jsfxr.d.ts`** — Ambient type declaration for the `jsfxr` npm
  package.

**When to add here:** the file has zero imports from `shared/core/`,
`shared/sim/`, `shared/ui/`, or any domain. Pure platform detection
or generic helpers.

## File placement decision tree

When you're about to add a file to `shared/`, work through this:

1. **Is it deterministic sim *behavior*?** (mutates board / walls /
   interior / bag state, or draws from `state.rng`, and 2+ domains
   need it) → `shared/sim/`
   *(Check this before core — sim functions also "know about game
   state," so the behavior test must win first.)*
2. **Is it a *type*, enum, pool registry, or predicate about game
   rules, state, or entities?**
   → `shared/core/`
3. **Is it UI state, render overlay, theme, or interaction?**
   → `shared/ui/`
4. **Is it a zero-dep generic utility?**
   → `shared/platform/`
5. **Does it cross the network?** (serialized message, wire format,
   checkpoint payload, dedup channel, tick context) → that's the
   top-level `src/protocol/` domain, **not** `shared/`.
6. **None of the above?**
   → Reconsider whether it belongs in `shared/` at all. It might
     belong in a specific domain (`game/`, `runtime/`, etc.). If it
     really is cross-domain but doesn't fit any category, the
     category is probably wrong — propose a new subfolder rather
     than dropping it at `shared/` root.

## Why subfolders, not one flat directory

The original split (38 loose files → subfolders) used natural
coupling (Louvain clustering): `ui/` files cluster tightly together,
while `platform/` and `core/` scatter across clusters — expected,
since those are semantic groupings, not coupling-based. `sim/` was
later carved out of `core/` to separate deterministic *behavior*
(write-surfaces, board algorithms) from the *types* they operate on,
and the network wire format graduated to its own top-level
`src/protocol/` domain. See `skills/layer-graph-cleanup.md` for the
original analysis.

The split also establishes a crisp rule: **if a file is at
`shared/` root, something is uncategorized**. That rule is
mechanically checkable and catches a class of "just dropped a file
here" drift.

## Gotchas

- **Don't bypass subfolders by re-exporting.** If a file needs a
  type from `shared/core/types.ts`, import from there directly —
  don't add a re-export barrel. Re-exports obscure the dependency
  graph from the layer linter and the refactor tool.

- **`shared/core/system-interfaces.ts` is consumer-facing.** It
  defines the `PlayerController`, `BuildViewState`, etc. that
  controllers and the AI strategy consume. It uses structural
  subtypes of `GameState` (the per-phase ViewStates) so controllers
  don't have to accept the whole state. When narrowing types, use
  these ViewStates — don't widen to `GameState`.

- **`shared/sim/` runs on every peer — keep it deterministic.** These
  functions drive `state.rng` and mutate shared board state; changing
  draw order or mutation timing diverges host vs. watcher. Run
  `npm run test:determinism` and `npm run test:net` after editing
  anything here. (The wire format itself lives in `src/protocol/` —
  see that domain's README.)

- **`shared/core/game-constants.ts` has 56 dependents.** It's a
  foundational tuning file — changes to any constant propagate
  widely. The high Pain number (coupling metric) is expected
  because these are abstract constants; it's not a refactor target.

- **`shared/platform/rng.ts` is the ONE allowed place to instantiate
  an `Rng`.** Call sites receive an `Rng` via constructor or deps
  bag — don't `new Rng()` from a game or runtime file. This
  preserves the determinism contract.

- **The pool consumers are enforced at type level via `satisfies`.**
  Every `*_CONSUMERS` object in `shared/core/*-defs.ts` has a
  `satisfies Record<Id, ...>` clause. Adding a new pool ID without
  a consumer map entry is a compile error. The `lint-registries.ts`
  script additionally verifies that every listed file path exists.

## Related reading

- **[src/game/README.md](../game/README.md)** — How `shared/core/`
  types are consumed by the game domain.
- **[src/runtime/README.md](../runtime/README.md)** — How
  `shared/ui/` is threaded through the runtime.
- **[src/protocol/README.md](../protocol/README.md)** — The wire
  format + checkpoints that used to live under `shared/net/`.
- **[src/online/README.md](../online/README.md)** — How
  `src/protocol/` is the network seam.
- **[CLAUDE.md](../../CLAUDE.md)** — "Type file organization" and
  "Extension point registries" sections cover the pool pattern and
  subfolder conventions.
- **[skills/layer-graph-cleanup.md](../../skills/layer-graph-cleanup.md)**
  — Historical log of the shared/ refactor that produced this
  structure.
