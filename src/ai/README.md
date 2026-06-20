# `src/ai/` — AI strategy + per-phase state machines

The **ai** domain implements computer-controlled players: per-phase
state machines (select/build/cannon/battle) and pluggable strategy
modules that make placement/fire decisions. The thin host wrapper
(`AiController`) that delegates to these lives in `src/controllers/`,
not here.

AI code is **separate from game rules**. Game rules live in
`src/game/` and say what IS legal; AI decides what the computer WANTS
to do. The AI imports from `game/` (to read the state, check
legality, execute intents) but game code never imports from `ai/`.

## The three-layer model

Each game phase the AI plays through is decomposed into three layers:

1. **Strategy** (`ai-strategy-*.ts`) — Decision functions that
   return placements, targets, or fire intents. No animation, no
   `GameState` mutation. Strategy DOES hold its own per-AI cache
   state (sticky enclosure target, shot counts, focus-fire target,
   phase-stable snapshots) and per-phase consumable flags
   (`CannonPlacementContext.pendingSuperGun`/`Rampart`/`Balloon`,
   each flipped to false the first time it's attempted). That's
   intentional — see the `DefaultStrategy` fields in
   `ai-strategy.ts` and the `CannonPlacementContext` JSDoc.
2. **Phase state machine** (`ai-phase-*.ts`) — Per-frame stateful
   tick that drives cursor animation, locks in decisions, and
   executes intents through the orchestrator. Holds the "where is
   the AI's cursor right now" state.
3. **Brain** (`ai-brain.ts`) — Aggregates the four phase machines
   plus the dialog auto-resolvers behind one `AiBrain` interface
   (`ai-brain-types.ts`). One brain instance per AI player. The
   controller (`src/controllers/controller-ai.ts`) owns cursor +
   trait state and delegates every phase tick to its injected brain.

This split lets strategy modules stay unit-testable (no animation,
no `GameState` writes — snapshot-in, decision-out from the caller's
perspective) while per-frame animation state lives in the phase
modules.

## Read these first

1. **[ai-strategy-types.ts](./ai-strategy-types.ts)** — The pluggable
   `AiStrategy` interface and its value types (`CannonPlacement`,
   `BattlePlan`, `BuildTickResult` / `CannonTickResult` /
   `BattleTickResult`, the per-phase `*Host` interfaces). Every AI
   decision goes through one of these methods:
   `chooseBestTower`, `pickPlacement`, `assessBuildEnd`,
   `initCannonPhase`, `nextCannonPlacement`, `planBattle`,
   `pickTarget`, `trackShot`, `onLifeLost`, `reset`. Low-layer file
   so phase modules + controllers can import without pulling in
   `DefaultStrategy`.

2. **[ai-strategy.ts](./ai-strategy.ts)** — `DefaultStrategy` —
   the concrete `AiStrategy` implementation plus `rollPersonality`
   (skill/trait dice at game start). The composition root wires this
   in; tests can swap for mocks against the interface.

3. **[ai-brain.ts](./ai-brain.ts)** — Aggregates the four phase
   machines + dialog auto-resolvers behind `AiBrain`
   (`ai-brain-types.ts`). One instance per AI-controlled slot,
   injected into
   [`src/controllers/controller-ai.ts`](../controllers/controller-ai.ts)
   which owns the cursor/trait state and forwards each tick.

4. **[ai-phase-build.ts](./ai-phase-build.ts)** — The most complex
   phase machine — piece placement with cursor animation and
   concurrent rotation. Read this to understand the
   "strategy plans → phase-machine animates → orchestrator executes"
   pattern.

## File categories

### Strategy interface + value types
- **`ai-strategy-types.ts`** — `AiStrategy` interface,
  `CannonPlacement` / `BattlePlan` / `*TickResult` / `*Host`
  interfaces. Imported by phase modules + controllers.
- **`ai-brain-types.ts`** — `AiBrain*` interfaces (per-phase brain
  contracts + `chooseLifeLost` / `tickUpgradePick`). The seam between
  `controller-ai.ts` and a concrete brain.

### Strategy (pure decision)
- **`ai-strategy.ts`** — `DefaultStrategy` class +
  `rollPersonality`.
- **`ai-strategy-build.ts`** — Build-phase piece placement
  orchestrator (`pickPlacement` impl).
- **`ai-strategy-cannon.ts`** — Cannon placement + tower selection.
- **`ai-strategy-battle.ts`** — Battle target selection + shot
  scoring + `trackShot` (post-fire observer) + `planBattle` chain
  planners.

### Per-phase state machines (tick-driven)
- **`ai-phase-select.ts`** — Initial castle selection. Browses
  towers, confirms.
- **`ai-phase-build.ts`** — Build phase. Animates cursor, rotates
  pieces, returns a `PlacePieceIntent` commit when cursor arrives.
- **`ai-phase-cannon.ts`** — Cannon phase. Cursor animation + mode
  switching + per-slot `PlaceCannonIntent` commits.
- **`ai-phase-battle.ts`** — Battle phase. Targeting, chain attacks,
  countdown orbit, fire timing — returns `FireIntent` commits.

### Build strategy sub-modules
The build-phase strategy is the most complex part of the AI, so it's
split into focused modules:
- **`ai-build-types.ts`** — Shared interfaces (`TargetContext`,
  `ScoringContext`, `AiPlacement`).
- **`ai-build-target.ts`** — Target tower ring selection.
- **`ai-build-score.ts`** — Scoring a candidate placement (territory
  gain, fat walls, pockets, ring distance).
- **`ai-build-shared.ts`** — Build-pipeline shared infra:
  `pickFallbackPlacement` (tower extension, ring distance fallback when
  scoring yields no gain), `createsSmallEnclosure` (small-pocket trap
  check shared with the scoring pipeline), and `memoize` (per-candidate
  predicate cache, placed here so closures may reference L≤10 symbols).
- **`ai-castle-rect.ts`** — Castle rectangle geometry and gap
  analysis.

### Dialog auto-resolvers (exposed via brain methods)
- **`ai-life-lost.ts`** — Decides life-lost dialog choices for AI
  players. Reached via `brain.chooseLifeLost(...)` from
  `controller.tickLifeLost(...)`; the runtime dialog subsystem
  invokes the controller method, not this file directly.
- **`ai-upgrade-pick.ts`** — Auto-resolves upgrade-pick dialog
  entries. Reached via `brain.tickUpgradePick(...)` from
  `controller.tickUpgradePick(...)`. Same dispatch shape.

### Shared helpers
- **`ai-constants.ts`** — Step sizes, eval intervals, animation
  timing, plus the `STEP` state-machine discriminant. Pure-data L0
  leaf (no imports, no helpers).
- **`ai-utils.ts`** — `secondsToTicks` (uses `SIM_TICK_DT` from
  shared/core/game-constants) and `traitLookup` (3-element
  skill-table accessor). Small L1 file split out so `ai-constants.ts`
  can stay a leaf module.
- **`ai-chain.ts`** — `ChainType` constants (`WALL`, `GRUNT`,
  `ICE_TRENCH`, `STRUCTURAL`, `POCKET`) returned in `BattlePlan`.
- **`ai-defaults.ts`** — Factory that bundles a `DefaultStrategy`
  with the default brain — single entry point for AI composition.

(`memoize` lives in `ai-build-shared.ts` at L10 rather than alongside
the other helpers — `lint:callback-inversion` needs the function's
declaration layer ≥ the layer of the symbols its closure references.)

## The seeding contract (load-bearing for determinism)

The AI's decisions must be deterministic from a seed. This requires
discipline about where RNG happens:

- **Strategy uses an injected `Rng`** — `AiStrategy.rng` (set at
  `DefaultStrategy` construction), not `Math.random()` and not
  `Date.now()`.
- **Online parity is mirror-simulation** — every peer runs the same
  AI tick against the synced `GameState` + `state.rng`. The wire
  carries only human input; AI outputs are recomputed on each peer.
- **Tie-breaking matters** — two candidate placements with identical
  scores must be resolved deterministically (e.g., by tile index).
  Introducing a set iteration order dependency will break determinism
  tests without any obvious symptom.
- **The probability-gate ladder in `planBattle` is order-sensitive** —
  each `rng.bool(prob)` and each plan call consumes from the shared
  stream. Adding or reordering chain branches shifts every following
  draw; re-record determinism fixtures when you do.

If you're adding a new strategy knob that uses randomness, thread it
through the existing `Rng` handle. The determinism fixtures
(`test/determinism-fixtures/`, replayed by
`npm run test:determinism`) will fail the next commit otherwise.

## The intent pattern (orchestrator executes, strategy returns)

AI modules follow the same "return intent, orchestrator executes"
contract as human controllers:

- **Cannon placement** is streamed, not batched:
  `strategy.initCannonPhase(player, count)` runs once at phase start
  and pre-rolls the super/rampart/balloon decisions; then
  `strategy.nextCannonPlacement(...)` is called each time the
  animation loop is ready for the next placement. The phase module
  (`ai-phase-cannon.ts`) returns each placement as a
  `PlaceCannonIntent` via `CannonTickResult.commit`; the controller
  forwards the intent to its commit transport.
- **Build phase**: `ai-phase-build.ts` calls `strategy.pickPlacement`,
  animates the cursor, and returns a `PlacePieceIntent` via
  `BuildTickResult.commit` when the cursor reaches the target. The
  controller commits and feeds the result back through
  `brain.build.onPlaceResult(success)` — that's how the
  blocked-retry semantics survive moving the commit out of the
  brain.
- **Battle phase** returns a `FireIntent` via `BattleTickResult.commit`.
  The controller commits through its port (`executeCannonFire` /
  `scheduleCannonFire`, which advance the GameState-owned
  `player.cannonRotationIdx`), then feeds the success/fail result to
  `brain.battle.onFireResult(...)` — preserves the
  `CANNON_RETRY_WAIT` semantics for "no cannon ready yet" by
  re-aiming the same crosshair on the next pass.

Do NOT mutate `GameState` from inside a strategy function. The
compiler won't catch it (JavaScript mutation is unrestricted) but
the architecture lint and determinism tests will. Mutating the
strategy's own caches (the `DefaultStrategy` `private` fields, the
`CannonPlacementContext` pending flags) is fine and expected — they
exist precisely to carry state across calls.

## Common operations

### Add a new AI heuristic for an existing phase
Strategy modules are the right home. Add the new scoring/target
logic to `ai-strategy-build.ts` / `ai-strategy-cannon.ts` /
`ai-strategy-battle.ts`. If it's build-specific and big, consider
splitting into an `ai-build-*.ts` sub-module like the existing ones.

### Add a new AI phase
Rare — usually phases are added to `game/` first and then the AI
gets a matching phase module. Pattern:
1. Create `ai-phase-<name>.ts` with the tick + state
2. Expose it on `AiBrain` (`ai-brain-types.ts` + `ai-brain.ts`)
3. Add strategy methods to `AiStrategy` if decision logic is needed
4. Wire the strategy impl in `ai-strategy.ts`
5. Override the matching `tick*` on `controllers/controller-ai.ts` to
   delegate to the new brain field

### Tune difficulty
Difficulty lives in strategy traits (`thinkingSpeed`, `cursorSkill`,
`spatialAwareness`) plus the constants in `ai-constants.ts`. The
controller derives `delayScale` / `boostThreshold` / etc. from those
traits — see `src/controllers/controller-ai.ts`. Higher difficulty
means more evaluation candidates, deeper lookahead, and better
tie-breaking — never "cheating" rule breaks.

### Debug AI behavior
The scenario API (`test/scenario.ts`) plays real games with real AI
and observes events via the bus. Log specific AI decisions via
`console.log` inside strategy functions, run `npm run
test:scenario`, and trace the output. Don't introduce debug state
on the AiController — it pollutes snapshots.

## Gotchas

- **Strategy functions take `ViewState`, not `GameState`.**
  `BuildViewState`, `CannonViewState`, `BattleViewState` are
  narrowed per-phase. This forces you to state exactly which fields
  your strategy reads. Widening to `GameState` is a smell.

- **`pickPlacement` can return null.** The build phase machine
  gracefully handles "no good placement" by skipping the turn. If
  you're refactoring, don't assume a non-null return.

- **`trackShot` is called after every fire.** It's the hook for
  learning/adaptation — currently used lightly but the signature is
  load-bearing for future targeting improvements. Don't delete
  existing call sites.

- **`ai-brain.ts` is the ONLY place that instantiates AI-internal
  state.** Don't scatter `new XxxState()` calls through
  `ai-phase-*.ts`; construct in the brain and pass references down
  via the host interfaces.

- **AI for eliminated players must be gated.** Several places check
  `isPlayerEliminated(player)` before running strategy. Eliminated
  players shouldn't generate decisions — add the guard when you
  introduce new strategy entry points.

- **Upgrade pick / life-lost auto-resolve are reached through the
  controller, not through deps-bag callbacks.** Runtime dialog
  subsystems call `controller.tickUpgradePick(...)` /
  `controller.tickLifeLost(...)`; AI overrides delegate to
  `brain.tickUpgradePick` / `brain.chooseLifeLost`. Runtime never
  imports from `ai/` (the layer lint forbids it). If you need a new
  auto-resolver, add a brain method + controller override.

## Related reading

- **[src/game/README.md](../game/README.md)** — The rules the AI
  plays against. `game-actions.ts` is where intents get executed.
- **[src/shared/core/system-interfaces.ts](../shared/core/system-interfaces.ts)**
  — `PlayerController`, `BuildViewState`, etc. The contracts AI
  controllers implement.
- **[test/scenario.ts](../../test/scenario.ts)** — The test API
  plays real games with real AI. Use it to verify AI changes
  end-to-end.
- **Memory: [project_mortar_upgrade_design.md](../../.claude/projects/-Users-gildas-Desktop-Dev-project-castles-99/memory/project_mortar_upgrade_design.md)**
  — Example of an AI design decision tied to a specific upgrade.
