# `src/ai/` — AI strategy + per-phase state machines

The **ai** domain implements computer-controlled players: per-phase
state machines (select/build/cannon/battle), pluggable strategy
modules that make placement/fire decisions, and the top-level
`AiController` that dispatches to them.

AI code is **separate from game rules**. Game rules live in
`src/game/` and say what IS legal; AI decides what the computer WANTS
to do. The AI imports from `game/` (to read the state, check
legality, execute intents) but game code never imports from `ai/`.

## The three-layer model

Each game phase the AI plays through is decomposed into three layers:

1. **Strategy** (`ai-strategy-*.ts`) — Pure decision functions that
   return placements, targets, or fire intents. No animation, no
   state, no side effects. Given a snapshot, return a decision.
2. **Phase state machine** (`ai-phase-*.ts`) — Per-frame stateful
   tick that drives cursor animation, locks in decisions, and
   executes intents through the orchestrator. Holds the "where is
   the AI's cursor right now" state.
3. **Controller dispatcher** (`controller-ai.ts`) — One thin shim per
   player. Owns the mutable `BagState` (piece bag) and forwards each
   phase tick to the matching `ai-phase-*.ts` module.

This split lets strategy modules stay pure + unit-testable while
per-frame animation state lives in the phase modules.

## Read these first

1. **[ai-strategy.ts](./ai-strategy.ts)** — The pluggable `AiStrategy`
   interface: `pickPlacement`, `placeCannons`, `planBattle`,
   `pickTarget`, `trackShot`, `assessBuildEnd`. Every AI decision
   goes through one of these methods. The composition root wires
   in a default strategy; tests can swap for mocks.

2. **[controller-ai.ts](./controller-ai.ts)** — `AiController` class.
   One instance per AI-controlled slot. Dispatches each phase's tick
   to its matching `ai-phase-*.ts` module and threads the strategy
   handle through.

3. **[ai-phase-build.ts](./ai-phase-build.ts)** — The most complex
   phase machine — piece placement with cursor animation and
   concurrent rotation. Read this to understand the
   "strategy plans → phase-machine animates → orchestrator executes"
   pattern.

## File categories

### Strategy (pure decision)
- **`ai-strategy.ts`** — The `AiStrategy` interface.
- **`ai-strategy-build.ts`** — Build-phase piece placement orchestrator.
- **`ai-strategy-cannon.ts`** — Cannon placement + tower selection.
- **`ai-strategy-battle.ts`** — Battle target selection + shot
  scoring + trackShot (post-fire observer).

### Per-phase state machines (tick-driven)
- **`ai-phase-select.ts`** — Initial castle selection. Browses towers,
  confirms.
- **`ai-phase-build.ts`** — Build phase. Animates cursor, rotates
  pieces, places piece when cursor arrives.
- **`ai-phase-cannon.ts`** — Cannon phase. Cursor animation + mode
  switching.
- **`ai-phase-battle.ts`** — Battle phase. Targeting, chain attacks,
  countdown orbit, fire timing.

### Build strategy sub-modules
The build-phase strategy is the most complex part of the AI, so it's
split into focused modules:
- **`ai-build-types.ts`** — Shared interfaces (`TargetContext`,
  `ScoringContext`).
- **`ai-build-target.ts`** — Target tower ring selection.
- **`ai-build-score.ts`** — Scoring a candidate placement (territory
  gain, fat walls, pockets, ring distance).
- **`ai-build-fallback.ts`** — Fallback when scoring yields no gain
  (tower extension, ring distance).
- **`ai-castle-rect.ts`** — Castle rectangle geometry and gap
  analysis.

### Dialog auto-resolvers (called by runtime subsystems)
- **`ai-life-lost.ts`** — Auto-resolves life-lost dialog entries for
  AI players. Consumed by `runtime-life-lost.ts` via a callback in
  the deps bag.
- **`ai-upgrade-pick.ts`** — Auto-resolves upgrade-pick dialog
  entries. Consumed by `runtime-upgrade-pick.ts` the same way.

### Shared helpers
- **`ai-constants.ts`** — Step sizes, eval intervals, animation
  timing. Zero imports, leaf module.
- **`controller-ai.ts`** — `AiController` — the public entry point.

## The seeding contract (load-bearing for determinism)

The AI's decisions must be deterministic from a seed. This requires
discipline about where RNG happens:

- **Strategy modules use an injected `Rng`** — received via the
  strategy handle's state, not via `Math.random()`.
- **Seeding happens at game start + host promotion** — the
  composition root seeds the strategy deterministically from
  `state.round` / player seed. See the seeding contract doc
  referenced in `skills/` and the memory entry about it.
- **Tie-breaking matters** — two candidate placements with identical
  scores must be resolved deterministically (e.g., by tile index).
  Introducing a set iteration order dependency will break determinism
  tests without any obvious symptom.

If you're adding a new strategy knob that uses randomness, thread it
through the existing `Rng` handle. Do NOT introduce a new
`Math.random()` call — the determinism fixtures will fail the next
commit.

## The intent pattern (orchestrator executes, strategy returns)

AI modules follow the same "return intent, orchestrator executes"
contract as human controllers:

- **`placeCannons(state, rng)`** returns a list of `CannonPlacement`
  intents. The orchestrator applies them via `applyCannonPlacement`.
- **Battle phase** returns `FireIntent` via a callback —
  `controller-ai.ts` builds a `fireExecutor` closure that calls
  `fireNextReadyCannon` with mutable state, and passes it into
  `ai-phase-battle.ts`.
- **`pickPlacement`** (build phase) returns a piece placement choice;
  `ai-phase-build.ts` animates the cursor there, then calls
  `tryPlacePiece()` via the orchestrator.

Do NOT mutate `GameState` from inside a strategy function. The
compiler won't catch it (JavaScript mutation is unrestricted) but
the architecture lint and determinism tests will.

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
2. Add an entry in `controller-ai.ts` to dispatch to it
3. Add strategy methods to `AiStrategy` if decision logic is needed
4. Wire the strategy impl in `ai-strategy.ts`

### Tune difficulty
Difficulty lives in constants + early-exit logic. See
`ai-constants.ts` and the `difficulty` check in `controller-ai.ts`.
Higher difficulty means more evaluation candidates, deeper lookahead,
and better tie-breaking — never "cheating" rule breaks.

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

- **`controller-ai.ts` is the ONLY file that instantiates
  AI-internal state.** Don't scatter `new XxxState()` calls through
  `ai-phase-*.ts`; construct in the controller and pass references
  down.

- **AI for eliminated players must be gated.** Several places check
  `isPlayerEliminated(player)` before running strategy. Eliminated
  players shouldn't generate decisions — add the guard when you
  introduce new strategy entry points.

- **Upgrade pick / life-lost auto-resolve are wired via callbacks
  in the composition root.** They're not imported by the runtime
  dialog modules directly (would create a `runtime → ai` dependency
  the lint forbids). Instead, `runtime-composition.ts` imports
  from `ai/` and passes the functions through `deps` bags. If you
  need a new auto-resolver, follow the same pattern.

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
