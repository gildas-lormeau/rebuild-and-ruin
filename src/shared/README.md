# `src/shared/` — Cross-domain foundation

Everything that multiple domains depend on lives here: game state
types, network wire format, UI state types, platform primitives,
geometry, spatial helpers, pool registries, the event bus. Every
non-entry domain (`game`, `ai`, `player`, `input`, `render`, `online`,
`runtime`) imports from `shared/`; nothing else is allowed to import
laterally.

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
  `player-slot.ts` (PlayerSlotId, ValidPlayerSlot), `battle-types.ts`
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
  math), `board-occupancy.ts` (wall/interior/territory tracking),
  `pieces.ts` (tetromino shapes).
- **System contracts**: `system-interfaces.ts` (PlayerController,
  BuildViewState, CannonViewState, BattleViewState, HapticsSystem,
  SoundSystem — the cross-domain interfaces).

**When to add here:** the new file is a *type* or *enum* or *pool
definition* consumed by game/ AND at least one other domain.
**When NOT to add here:** if it's game logic (mutation functions), it
goes in `src/game/`. If it's UI state, it goes in `shared/ui/`. If
it's a wire format, it goes in `shared/net/`.

### `shared/net/` — wire format + checkpoints
Network seam. Consumed primarily by `online/` but also by `runtime/`
(runtime-types.ts imports message types), `entry/`, and `server/`.

- **`protocol.ts`** — ServerMessage/GameMessage unions, MESSAGE
  constants. The canonical wire format.
- **`checkpoint-data.ts`** — BattleStartData (rng resync) plus the
  serialized field shapes used by FULL_STATE (join / host migration).
  Phase-marker checkpoints (BUILD_START / BUILD_END / CANNON_START)
  carry no payload — watchers derive state locally on receipt.
- **`tick-context.ts`** — `HostNetContext`, `TimerAccums`,
  `isHostInContext()` helper. The per-frame networking context
  that gates host/watcher behavior.
- **`phantom-types.ts`** — `DedupChannel` interface + `NOOP_DEDUP_CHANNEL`
  sentinel. The opaque type for per-player dedup state (aim, cannon
  phantom, piece phantom).
- **`routes.ts`** — Server HTTP route constants (`API_ROOMS_PATH`,
  `HEALTH_PATH`, `WS_PLAY_PATH`).

**When to add here:** any type that crosses the network boundary, or
any shared structure used by both host and watcher code paths.

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
  CASTLE_BUILD / BALLOON_ANIM / SELECTION / STOPPED).
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
`shared/ui/`, `shared/net/`, or any domain. Pure platform detection
or generic helpers.

## File placement decision tree

When you're about to add a file to `shared/`, work through this:

1. **Does it know anything about game rules, state, or entities?**
   → `shared/core/`
2. **Does it cross the network?** (serialized message, wire format,
   session state, dedup channel, tick context)
   → `shared/net/`
3. **Is it UI state, render overlay, theme, or interaction?**
   → `shared/ui/`
4. **Is it a zero-dep generic utility?**
   → `shared/platform/`
5. **None of the above?**
   → Reconsider whether it belongs in `shared/` at all. It might
     belong in a specific domain (`game/`, `runtime/`, etc.). If it
     really is cross-domain but doesn't fit any category, the
     category is probably wrong — propose a new subfolder rather
     than dropping it at `shared/` root.

## Why four subfolders, not one flat directory

Before today's split, `shared/` had 38 loose files. After the split,
natural coupling (Louvain clustering) exactly matches the subfolder
boundaries for `ui/` (all 11 files cluster together) and `net/`
(all 5 files plus `router.ts`). `platform/` and `core/` scatter
across multiple clusters, which is expected and fine — those are
semantic groupings, not coupling-based. See
`skills/layer-graph-cleanup.md` for the full analysis from the split
session.

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

- **`shared/net/protocol.ts` is load-bearing.** Changes here cascade
  to host + watcher + server. Run `npm run test:sync` after any
  protocol change.

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
  `shared/ui/` and `shared/net/` are threaded through the runtime.
- **[src/online/README.md](../online/README.md)** — How
  `shared/net/` is the protocol seam.
- **[CLAUDE.md](../../CLAUDE.md)** — "Type file organization" and
  "Extension point registries" sections cover the pool pattern and
  subfolder conventions.
- **[skills/layer-graph-cleanup.md](../../skills/layer-graph-cleanup.md)**
  — Historical log of the shared/ refactor that produced this
  structure.
