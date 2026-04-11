# `src/player/` — Controller factory + human controller

The **player** domain is small (3 files) but load-bearing: it contains
the `HumanController` implementation, the `BaseController` abstract
class that both `HumanController` and `AiController` extend, and the
controller factory that creates the right kind of controller for each
slot.

Controllers are the **per-player input handlers** that translate
user intent (keyboard / mouse / touch / AI decision) into game
actions. Every player — human or AI — has a controller. The game
loop ticks every active player's controller each frame.

## File inventory

There are only three files — no categories needed.

- **[controller-types.ts](./controller-types.ts)** — `BaseController`
  abstract class. The shared behavior every controller inherits:
  piece bag management, cursor clamping, placement preview computation,
  reset/advance helpers. Extended by `HumanController`
  (here) and `AiController` (in `src/ai/controller-ai.ts`).

- **[controller-human.ts](./controller-human.ts)** — `HumanController`
  concrete class. Input-driven controller: cursor position driven by
  mouse/touch/keyboard events, piece rotation on key press, confirm
  on click/tap. Returns `PlacePieceIntent` / `FireIntent` objects —
  does NOT mutate state directly.

- **[controller-factory.ts](./controller-factory.ts)** —
  `createController(id, isAi, keyBindings, seed, difficulty)` factory.
  Given slot config, returns either a `HumanController` or an
  `AiController`. Called once per slot during game bootstrap.

## The intent contract (load-bearing)

Controllers **return intents, never mutate state directly**. This is a
deliberate architectural choice:

```ts
// BAD (old pattern, was phased out):
class HumanController {
  tryPlacePiece(state: GameState): boolean {
    // ... reads + writes state directly
    state.players[this.playerId].walls.add(tile); // ← forbidden
    return true;
  }
}

// GOOD (current pattern):
class HumanController {
  tryPlacePiece(state: BuildViewState): PlacePieceIntent | null {
    // ... reads state (narrowed to BuildViewState)
    if (!canPlace) return null;
    return { kind: "placePiece", playerId, piece, pos };
    // Orchestrator (runtime/online/AI tick) calls
    // executePlacePiece(state, intent, controller) afterwards.
  }
}
```

Why this matters:

- **Separation of concerns:** Controllers decide *what* to do;
  `src/game/game-actions.ts` decides *how* (with mutable state +
  bookkeeping).
- **View-state narrowing:** Controllers take per-phase ViewStates
  (`BuildViewState`, `CannonViewState`, `BattleViewState`) rather
  than full `GameState`. This makes it explicit which fields each
  method actually reads.
- **Orchestrator-driven execution:** The runtime, online client,
  and AI tick each call `executePlacePiece()` / `executeCannonFire()`
  against the real mutable state. Controllers never have to reason
  about mutation side effects.

Don't reintroduce direct state mutation from controllers. The
architecture lint + layer lint won't catch it (it compiles), but it
will silently break the "intents are inspectable" invariant that
tests rely on.

## The piece bag

Every build-phase controller holds a `BagState` — a deterministic
sequence of upcoming pieces. The bag is shuffled once at game start,
then consumed in order. Key rules:

- **Bag advance happens AFTER placement confirmation, not during
  cursor preview.** `tryPlacePiece` returns an intent; only once the
  orchestrator has executed it does `advanceBag(true)` run. Peek via
  `peekNextPiece()`.
- **Rotation does NOT consume the bag.** It mutates the current
  piece's rotation field.
- **Bag state is per-controller, not shared.** Each player has their
  own bag seeded from the game seed + slot index.
- **Reseeding happens at game reset / host promotion.** Don't hold
  `BagState` references across a reset — the reference becomes
  stale.

## Common operations

### Add a new controller input method
The base class already handles cursor clamping, placement preview,
and bag management. To add a new input (e.g., gamepad), subclass
`BaseController` or extend `HumanController` with new event
subscribers. Register the subscriber in the relevant input subsystem
(`src/input/input-keyboard.ts` etc.) and thread events through to
the controller.

### Add a new controller type
Create a new class extending `BaseController`, implement the
abstract methods (`tryPlacePiece`, `fire`, `advanceBag`, etc.),
and add a branch in `controller-factory.ts` for when to
instantiate it.

### Debug a "my click didn't land" bug
Start in `src/runtime/runtime-input.ts` — that's where pointer
events get routed to the pointer-player's controller. From there
step into `controller-human.ts` to see what intent (if any) the
controller returns. If the intent is non-null but nothing happens,
the bug is in `executePlacePiece()` / `game-actions.ts`, not here.

## Gotchas

- **Human and AI controllers look similar but diverge at
  `trackShot`.** Only AI controllers use `trackShot` for
  targeting adaptation. HumanController's implementation is a no-op.
  If you add a new shared method, verify both subclasses handle it
  sensibly.

- **`keyBindings` is slot-specific.** Each player has their own
  key bindings (it's a shared-screen game). The factory takes a
  `KeyBindings` object; mutations to one player's bindings
  shouldn't leak into another's.

- **`difficulty` is AI-only.** Passed to the factory but only used
  if the controller kind is AI. Human controllers ignore it.

- **`seed` is also AI-only** — used to seed the AI strategy's RNG.
  Human controllers don't consume it.

- **`BaseController` is abstract but not marked `abstract` in TS
  for all methods.** Some methods have base implementations that
  subclasses extend; others throw if not overridden. Read the
  existing controllers before assuming a method is free to override.

- **Placement preview state lives on the controller, not
  `runtimeState`.** This is on purpose: preview is per-player and
  doesn't need to persist across ticks. Don't try to move it into
  shared state.

## Related reading

- **[src/game/game-actions.ts](../game/game-actions.ts)** — The
  `executePlacePiece` / `executeCannonFire` functions that consume
  the intents controllers return. This is the "orchestrator mutates"
  half of the contract.
- **[src/shared/core/system-interfaces.ts](../shared/core/system-interfaces.ts)**
  — `PlayerController`, `BuildController`, `CannonController`,
  `BattleController`, `FireIntent`, `PlacePieceIntent`. The interface
  these controllers implement.
- **[src/ai/controller-ai.ts](../ai/controller-ai.ts)** — The AI
  controller, same `BaseController` subclass pattern but delegates
  each phase to `ai-phase-*.ts` state machines.
- **[src/runtime/runtime-input.ts](../runtime/runtime-input.ts)** —
  Where human controllers are wired to keyboard/mouse/touch events.
