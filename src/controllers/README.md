# `src/controllers/` — Player controllers (the input → intent seam)

The **controllers** domain wraps each player's input source — a human
at a keyboard/mouse/touch screen, or the AI brain — behind one
`PlayerController` interface. A controller's job is to translate that
source into **intents** (`FireIntent`, `PlacePieceIntent`,
`PlaceCannonIntent`) and to hold the per-player cursor/crosshair state
the renderer draws. It is the single seam between *who is playing* and
*the game*.

Controllers never mutate `GameState` directly. They return intents; the
orchestrator (runtime / online) executes them through the shared
executors in `src/game/game-actions.ts`. The human path runs intents
via `src/runtime/input-actions.ts`; the AI path runs them via a commit
port (below). Both end at the same executors — there is no parallel
mutation path.

## Two interface families, one object

Every controller is described from two angles, and reading the surface
means knowing which angle a member belongs to:

- **`PlayerController`** (`src/shared/core/system-interfaces.ts`) —
  consumed by `runtime/`, `input/`, `render/`, `online/`. Composed of
  phase-sliced sub-interfaces: `ControllerIdentity`, `BuildController`,
  `CannonController`, `BattleController`, `SelectionController`,
  `UpgradePickController`, `LifeLostController`, plus `InputReceiver`
  (human-only).
- **`*Host`** (`src/ai/ai-strategy-types.ts`) — the narrow slice the AI
  brain reads off its controller: cursor/crosshair state, the cursor
  steppers, and the `aim`/`fire` commit seam. Nothing else.

`AiController` satisfies both families; the static assertion
`_assertAiControllerSatisfiesAllHosts` in `controller-ai.ts` fails at
compile time if a `*Host` member stops being provided. The `*Host`
interfaces `Pick<>` their shared members from the `PlayerController`
sub-interfaces so the two can't silently drift.

## Read these first

1. **[controller-base.ts](./controller-base.ts)** — `BaseController`,
   the abstract class both real controllers extend. Owns the shared
   cursor/crosshair state, the cursor-clamp/move helpers, and the
   **template-method** lifecycle (see below). Start here.
2. **[controller-ai.ts](./controller-ai.ts)** — `AiController`, a thin
   host around a pluggable `AiBrain`. Owns cursor/crosshair state and
   the commit port; forwards every phase tick to the brain. The brain
   (in `src/ai/`) owns the decision strategy.
3. **[ai-commit-port.ts](./ai-commit-port.ts)** — `AiCommitPort`, the
   mutation seam for the three AI commits (place piece / place cannon /
   fire). The **only** place the `state as GameState` casts live.
4. **[controller-factory.ts](./controller-factory.ts)** — the canonical
   AI seam for non-AI code: owns all dynamic imports into `src/ai/` so
   human-only games stay slim and `runtime`/`online` never import `ai/`.

## The files

- **`controller-base.ts`** — `BaseController`. Cursor/crosshair state,
  shared movement/clamp helpers, the per-phase template methods
  (`startBuildPhase`, `finalizeBuildPhase`, `finalizeCannonPhase`,
  `initBattleState`) and their `on*` hooks, and the default no-op dialog
  resolvers. `fire()` builds a `FireIntent` from the crosshair;
  `forceUpgradePick()` is the deterministic max-timer fallback.
- **`controller-human.ts`** — `HumanController implements InputReceiver`.
  Keyboard key-map, held-key + analog d-pad crosshair movement, cannon
  mode cycling, and the `tryPlacePiece` / `tryPlaceCannon` intent
  builders. Pure input → intent; no game mutation.
- **`controller-ai.ts`** — `AiController`. Holds the `brain`, the
  `commit` port, and cursor/crosshair state. Each tick delegates to the
  brain and, when the brain returns a commit, runs it through the port.
  Keeps a **private** `strategy` reference only for its own
  cursor-jitter rng, the battle-orbit re-roll, and lifecycle reset — the
  brain owns strategy for decisions.
- **`controller-ai-assisted-human.ts`** — `AiAssistedHumanController`
  extends `AiController` but presents as `kind: "human"` and routes its
  commits over the wire (via a networked commit port + dialog senders).
  Lets AI play exercise the exact protocol path two humans on different
  machines would. Test/parity tooling only; `InputReceiver` methods are
  no-op stubs.
- **`controller-factory.ts`** — `createController(...)` +
  `ensureAiModulesLoaded()` + `rollAiPersonality(...)`. Lazily imports
  the AI chunks, rolls personality off the shared RNG at bootstrap, and
  constructs the right controller for each slot.
- **`ai-commit-port.ts`** — `AiCommitPort` with two implementations:
  `DIRECT_COMMIT_PORT` (offline — mutate `GameState` in place via the
  executors) and `networkedCommitPort(...)` (assisted-human — schedule
  on the lockstep queue + broadcast). Isolating the casts here keeps the
  rest of the domain `GameState`-free.

## The intent pattern (controllers decide, the orchestrator executes)

A controller never writes `GameState`. It returns an intent and the
orchestrator applies it:

- **Human** — `input-dispatch` calls `tryPlacePiece` / `tryPlaceCannon`
  / `fire`; `runtime/input-actions.ts` executes the returned intent via
  `executePlacePiece` / `executePlaceCannon` / `executeCannonFire`.
- **AI** — the brain's per-phase `tick` returns a commit; `AiController`
  forwards it to `this.commit.{placePiece,placeCannon,fire}(...)`. The
  `DIRECT` port calls the same executors; the networked port schedules +
  broadcasts instead.

Because both localities funnel through the same `game-actions.ts`
executors, there is exactly one place game state changes for a given
action — which is what keeps host/watcher in lockstep.

## The template-method pattern (don't override the public method)

`BaseController`'s public lifecycle methods run shared init, then call a
protected `on*` hook. Subclasses **override the hook, never the public
method** — overriding the public one skips base init.

| Public (`@final`)      | Hook to override         |
| ---------------------- | ------------------------ |
| `startBuildPhase`      | `onStartBuildPhase`      |
| `finalizeBuildPhase`   | `onFinalizeBuildPhase`   |
| `initBattleState`      | `onResetBattle`          |
| `finalizeCannonPhase`  | `flushCannons` / `initCannons` |

## Parity (load-bearing)

AI controllers are **mirror-simulated**: every peer ticks the same AI
slot against the synced `GameState` + `state.rng`, so the wire carries
only human input. This constrains the domain:

- **No controller-local state may gate a synced RNG draw.** Round-robin
  fire selection (`player.cannonRotationIdx`) and piece bags live on
  `GameState`, not the controller, precisely so every peer advances them
  identically.
- **The brain's decision memory is reset-then-rederived at adoption
  boundaries**, never serialized — see the host-promotion path in
  `src/online/`. Don't move that transient state into the checkpoint.
- **The assisted-human commit port exists to test this**: its commits
  ride the lockstep queue exactly like a human's.

## Gotchas

- **`currentBuildPhantoms` / `currentCannonPhantom` are a render
  mailbox.** For remote-controlled slots the inbound `OPPONENT_PHANTOM`
  network handler writes them; the controller for that slot never ticks.
  They're public-mutable by design — render and broadcast read from
  here.
- **`crosshair` is a public field, but read it via `getCrosshair()`.**
  The field must be public to satisfy `BattleHost` (the brain mutates it
  for the aim glide); the runtime read-path goes through `getCrosshair()`
  because that tags the position with `playerId` for the per-player
  `frame.crosshairs` list.
- **`aim()` differs by controller.** The human snaps the crosshair onto
  the resolved point immediately; the AI resolves-only and glides via
  `stepCrosshairToward`. Both go through the injected `AimResolver` so
  neither can aim where a human pointer couldn't.
- **Phase entry is owned by `game/`, not here.** Controllers return
  intents and animate cursors; they never write `state.phase`.
- **`controller-factory.ts` is the only file that imports `src/ai/`
  runtime code.** Everything else uses the type-only `*-types.ts`. Keep
  it that way — the layer lint forbids `runtime`/`online` from importing
  `ai/`.

## Related reading

- **[src/shared/core/system-interfaces.ts](../shared/core/system-interfaces.ts)**
  — the `PlayerController` family, the per-phase `*ViewState` slices, and
  the `*Intent` shapes.
- **[src/ai/README.md](../ai/README.md)** — the brain/strategy the AI
  controller delegates to, and the seeding contract behind parity.
- **[src/game/game-actions.ts](../game/game-actions.ts)** — the
  executors every intent (human and AI) funnels through.
