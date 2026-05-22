# `src/runtime/` — Game runtime orchestration

The **runtime** domain owns the per-frame game loop, all UI-facing
sub-systems (camera, render, banners, dialogs, input wiring), and the
composition root that assembles everything into a runnable game for both
local play and online play.

This domain is **almost entirely pure**: nearly every file imports only
from `shared/` and `game/`. A few files reach further, each for a
narrow, documented reason:

- [composition.ts](./composition.ts) — the composition root — crosses
  into `input/`, `render/`, `ai/`, and `protocol/` to wire everything
  together. Exempt from purity via the roots-tier classification in
  `.import-layers.json`.
- [bootstrap.ts](./bootstrap.ts) — imports
  `controllers/controller-factory.ts` because its whole job is turning
  lobby settings into a controller set.
- [types.ts](./types.ts) — type-only imports from `protocol/` for
  `NetworkApi` / `BattleStartData` shapes.

The purity contract is enforced by `.domain-boundaries.json` plus the
tier classification in `.import-layers.json` (roots-tier files are
exempt from the cross-domain restriction).

## Read these first (in order)

1. **[types.ts](./types.ts)** — Public interfaces: `RuntimeConfig`,
   `GameRuntime`, `NetworkApi`, `TimingApi`, `OnlinePhaseTicks`, the
   sub-system contracts. Also documents the `deps`-bag convention used
   by every `createXSystem(deps)` factory in this folder. **Start here —
   every other file makes more sense after this one.**

2. **[state.ts](./state.ts)** — The `RuntimeState` bag held by the
   composition root. This is the mutable state every sub-system reads
   and writes. Phase timers, UI dialog state, frame metadata,
   pointer-player cache, lobby state, options state. If you're wondering
   "where does X live?", the answer is usually somewhere in
   `runtimeState.*`.

3. **[composition.ts](./composition.ts)** — The wiring. Creates every
   sub-system, threads their deps, and returns a `GameRuntime` handle.
   ~900 lines of factory calls in a deliberate order (one sub-system
   depends on another's exports). Read this last — it's easier to
   understand once you know what's being wired.

## Directory layout

```
src/runtime/
├── composition.ts          composition root
├── state.ts                RuntimeState bag
├── types.ts                public interfaces
├── handle.ts               GameRuntime return type
├── bootstrap.ts            lobby-settings → controllers + initial state
├── main-loop.ts            rAF loop, sub-stepping, frame context
├── phase-machine.ts        data-driven phase-transition state machine
├── ui-contracts.ts         shared UI/overlay/touch contracts
├── banner-state.ts         BannerState type + null-init constructor
├── banner-messages.ts      phase-transition banner string constants
├── battle-anim.ts          battle-event → render-anim translation
├── castle-build.ts         castle wall animation primitives
├── camera-projection.ts    camera-projection math
├── input-actions.ts        local-play action surface
├── tick-context.ts         shared tick-context types (APPLY/TICK/CHECKPOINT)
├── tick-consumers.ts       OnlinePhaseTicks consumer map
├── timer-accums.ts         phase-timer accumulator helpers
├── timing-api.ts           TimingApi type
│
├── browser/                browser bindings (entry-point only)
│   ├── dom.ts
│   └── timing.ts
│
├── dialogs/                modal-dialog primitives (pure helpers)
│   ├── dialog-tick.ts
│   ├── life-lost-core.ts
│   └── upgrade-pick-core.ts
│
├── modifier-effects/       modifier 3D-effect helper cluster
│   ├── registry.ts         ModifierId → effect-deriver
│   ├── ramp.ts             shared reveal ramp
│   ├── reveal-time.ts      banner-aware reveal-time scalar
│   ├── waved-ramp.ts       lerp + damped-sine helper (fog / rubble)
│   ├── bell-pulse.ts       bell envelope × pulse helper (sapper / grunt-surge)
│   ├── dust-storm.ts
│   ├── fog.ts
│   ├── frostbite.ts
│   ├── grunt-surge.ts
│   ├── rubble-clearing.ts
│   └── sapper.ts
│
├── audio/                  asset/synth primitives + 2 sub-system factories
│   ├── music-player.ts
│   ├── sfx-player.ts
│   ├── music-assets.ts
│   ├── music-synth-loader.ts
│   └── sound-modal.ts
│
└── subsystems/             one createXSystem(deps) factory per file
```

## File categories

### Composition root (1 file — the main wiring point)
- **`composition.ts`** — `createGameRuntime(config)` creates every
  sub-system and wires them together. Also exports
  `createBrowserRuntimeBindings(canvas)` and `createLocalNetworkApi()`
  as wiring primitives shared by all three callers (`src/main.ts`,
  `src/online/runtime/game.ts`, `test/runtime-headless.ts`).
  **Only edit this file if you need a new subsystem, a new cross-domain
  wire, or a new wiring primitive. Otherwise leave it alone.**

### State + types (3 files — start here if you're new)
- **`state.ts`** — The `RuntimeState` interface + factory.
- **`types.ts`** — `RuntimeConfig`, sub-system deps interfaces,
  `NetworkApi`, `TimingApi`, the modal dialog lifecycle contract.
- **`handle.ts`** — `GameRuntime`, the public composition return.
  Separated from `types.ts` because it sits ABOVE every subsystem in
  the import graph (one-way: handle imports types, not the reverse).

### Sub-system factories (`subsystems/` — one `createXSystem(deps)` each)
**Every file in `src/runtime/subsystems/` is a sub-system.** Each exports
a `createXSystem(deps)` factory that takes a deps object and returns a
handle with methods. They are wired by `composition.ts`, never imported
by each other. Directory membership is the contract: if you want to add
a sub-system, the file goes in `subsystems/`; if you put a
`create*System(deps)` factory at `runtime/` root, `lint-architecture.ts`
(Check 5) will reject it.

For the current list, run `ls src/runtime/subsystems/` — the directory
listing IS the table. Naming convention: bare kebab-case (no prefix —
location implies "subsystem").

### Audio cluster (primitives + two sub-system factories)
The audio files form a cohesive primitive cluster rather than independent
sub-systems — they share asset storage, a synth loader, and a modal, so
they import from each other. The "sub-systems MUST NOT import from each
other" rule applies to the top-level `createXSystem(deps)` sub-systems
listed above; internal cluster imports (music-player → music-assets +
music-synth-loader; sfx-player → music-assets) are expected. Only
`createMusicSubsystem` and `createSfxSubsystem` are wired through the
composition root's deps object.

| File | Purpose |
|---|---|
| `audio/music-player.ts` | XMI MIDI playback, bg tracks, fanfares |
| `audio/sfx-player.ts` | VOC sample playback, event-map dispatcher, snare crescendo |
| `audio/music-assets.ts` | IndexedDB asset storage + RSC/XMI extraction |
| `audio/music-synth-loader.ts` | WOPL synth worklet loader + gain envelope |
| `audio/sound-modal.ts` | HTML modal for asset import (DOM UI) — standalone factory, not a sub-system; exposed to the options screen via a `showSoundModal` callback rather than the deps bag |

### Modifier-effect cluster (`modifier-effects/`)
Parallel structure to the audio cluster: registry + shared helpers +
one file per modifier deriver. Single external consumer
(`subsystems/render.ts`). Internal cross-imports between these files
are legitimate.

| File | Purpose |
|---|---|
| `modifier-effects/registry.ts` | `ModifierId` → effect-deriver dispatch |
| `modifier-effects/reveal-time.ts` | banner-aware `revealTimeMs` scalar |
| `modifier-effects/ramp.ts` | shared reveal-ramp driver |
| `modifier-effects/{dust-storm,fog,frostbite,grunt-surge,sapper}.ts` | per-modifier derivers |
| `modifier-effects/rubble-clearing.ts` | rubble-clearing overlay (cannon-mode tie-in) |

### Dialog primitives (`dialogs/`)
Pure state helpers for modal dialogs, split from their sub-system
factories so the helpers can be tested in isolation. Consumed by
`subsystems/life-lost.ts` and `subsystems/upgrade-pick.ts`.

| File | Purpose |
|---|---|
| `dialogs/life-lost-core.ts` | life-lost dialog state helpers |
| `dialogs/upgrade-pick-core.ts` | upgrade-pick dialog state helpers |
| `dialogs/dialog-tick.ts` | shared auto-resolve + force-resolve loop |

### Browser bindings (`browser/`)
Browser-API wrappers used only by entry points (`src/main.ts`,
`src/online-client.ts`). Sub-systems should not depend on these
directly — they receive a `TimingApi` via deps.

| File | Purpose |
|---|---|
| `browser/dom.ts` | DOM/visibility/listener helpers |
| `browser/timing.ts` | `createBrowserTimingApi()` — wraps `requestAnimationFrame` etc. |

### Other primitives / helpers (NOT sub-systems)
- **`bootstrap.ts`** — `bootstrapNewGameFromSettings()` — builds
  controllers + initial game state from lobby settings.
- **`castle-build.ts`** — Castle wall animation primitives
  (consumed by selection).
- **`ui-contracts.ts`** — Sub-system interface aggregator: `UIContext`,
  `BannerState`, `BannerShow`, and every `XSystem` / `XDeps` type
  shared across the composition root. Also exports
  `createBannerState()` — a trivial factory intentionally placed here
  (not in `state.ts`) to keep `state.ts` at L6 in the layer graph.
  Don't "helpfully" move it. See
  [skills/layer-graph-cleanup.md](../../skills/layer-graph-cleanup.md).
- **`tick-context.ts`** — Shared tick-context types + the
  APPLY/TICK/CHECKPOINT mutation-phase doc. Extracted from
  `subsystems/phase-ticks.ts` so `battle-ticks.ts` can depend on it
  without a peer dependency.
- **`phase-machine.ts`** — Pure data-driven phase-transition state
  machine. The `TRANSITIONS` table declares each transition's mutate,
  display steps (banner / score-overlay / life-lost-dialog /
  upgrade-pick), and postDisplay side-effects. `runTransition(id, ctx)`
  is the single entry point — captures the scene, runs mutate, walks
  the display, fires postDisplay. The actual model is clone-everywhere:
  the only `PhaseTransitionCtx` builder is `buildHostPhaseCtx` in
  [`subsystems/phase-ticks.ts`](subsystems/phase-ticks.ts), used on every
  peer; role differences (host has wire `broadcast`, watcher doesn't)
  live in optional `ctx` fields populated only where they apply, not in
  a separate watcher builder. `online/online-phase-transitions.ts` is
  a thin GAME_OVER receiver, not a watcher ctx factory.
- **`main-loop.ts`** — `createRuntimeLoop(deps)`: the rAF main loop,
  sub-stepping, frame-context derivation. Called once by the
  composition root.

### Dev tools (excluded from non-dev builds by `IS_DEV`)
Dev tooling lives in [`dev/`](../../dev/) at the repo root
(`dev-console.ts`, `dev-console-grid.ts`, `e2e-bridge.ts`) — NOT inside
`src/runtime/`. The composition root references them via dynamic-import-
style wiring guarded by `IS_DEV`.

## The sub-system deps convention (the thing that trips new readers)

Every `createXSystem(deps)` factory follows this pattern:

```ts
interface FooDeps {
  readonly runtimeState: RuntimeState;
  // frequently-used deps destructured at the factory top:
  readonly log: (msg: string) => void;
  readonly render: () => void;
  // rare or late-bound deps accessed inline as deps.X:
  readonly getSomething: () => SomethingType;
  // ...
}

export function createFooSystem(deps: FooDeps): FooSystem {
  const { runtimeState, log, render } = deps;
  // ... returns { doThing, tick, ... }
}
```

Key points that confuse first-time readers:

- **The `deps` object is a late-binding bag.** Some fields are static
  values, some are getters (`getState: () => GameState`), some are
  callbacks the composition root fills in *after* this factory runs
  (because two sub-systems depend on each other's exports). The
  composition root orders factory calls carefully — read
  `composition.ts` top-to-bottom to see the dependency chain.

- **Sub-systems MUST NOT import from each other.** They can only import
  from `types.ts`, `state.ts`, the runtime-root primitive allowlist
  (see `ALLOWED_RUNTIME_BASENAMES` in `scripts/lint-architecture.ts`),
  and the approved sub-folders (`browser/`, `dialogs/`,
  `modifier-effects/`, `audio/`). All cross-subsystem wiring happens in
  the composition root via the `deps` object. This is enforced by
  `lint-architecture.ts`.

  **The "no cross-imports" rule is about CODE, not STATE.** Sub-systems
  share state via the `runtimeState` bag by design — every sub-system
  reads fields owned by others (render reads `dialogs.lifeLost`,
  main-loop reads `scoreDisplay.deltas`, input reads `dialogs.upgradePick`,
  …). Reads are unrestricted; **writes are owned** (one sub-system per
  field, identifiable by name). For type-narrowed targeted reads,
  prefer the owning subsystem's `get()` handle method
  (e.g. `lifeLost.get()`); use the bag directly when aggregating many
  fields. See the `RuntimeState` docstring in `state.ts`.

- **Destructuring is intentionally non-uniform.** Each factory
  destructures only what it uses frequently; rare deps stay as
  `deps.X`. Don't try to normalize this — it reflects actual usage.

- **Getters for late binding, not plain values.** If a sub-system
  reads `runtime.render()`, it's because `render` is created AFTER
  this sub-system — the factory captures a callback that resolves the
  reference when called, not at construction time. Same for
  `getState()`, `getCtx()`, etc.

## Common operations

### Add a new sub-system
1. Create `src/runtime/subsystems/<name>.ts` with a `createXSystem(deps)` factory.
2. Define the `XDeps` and `XSystem` interfaces in the same file (or in `types.ts` if consumed elsewhere).
3. Add to `composition.ts` in dependency order (after its deps are created, before its consumers).
4. If other sub-systems need to call yours, add the handle to their deps via the composition root.
5. Run `deno run -A scripts/lint-architecture.ts` — it enforces the factory shape and the `subsystems/`-only rule (Check 5 rejects sub-systems placed at `runtime/` root).

### Add a new dialog lifecycle (modal UI)
Look at `subsystems/life-lost.ts` or `subsystems/upgrade-pick.ts` for the
pattern: dialog state lives in `runtimeState`, the `dialogs/<name>-core.ts`
file has pure state helpers, the factory wires tick/show/resolve +
sound/haptics. The modal dialog contract is documented in `types.ts`.

### Add a new phase tick
Look at `subsystems/phase-ticks.ts`. Per-phase tick logic lives in there.
If the new phase logic is pure game code, put it in `src/game/` first
and call it from `subsystems/phase-ticks.ts`.

### Add a new dev tool command
`dev/dev-console.ts`. Guarded by `IS_DEV`, so no production cost.

## Gotchas

- **`composition.ts` is NOT a sub-system.** It's the composition
  root. Everything else in this folder must stay pure (no imports from
  input/render/ai/online beyond type-only).

- **Don't import directly between sub-systems.** The architecture lint
  will reject it. Cross-sub-system wiring goes through `composition.ts`
  via the deps bag.

- **`runtimeState.state` holds a placeholder before the game starts.**
  Two predicates carve the lifecycle:
  - `isStateInstalled(runtimeState)` — sticky-once-true bootstrap guard.
    Use only for paths that legitimately read frozen state outside an
    active session (game-over render, dev console, E2E bridge).
  - `isSessionLive(runtimeState)` — true only while a game session is
    in progress (state installed AND in a gameplay mode). The right
    guard for every per-tick presentational signal, animator, or
    state-derived computation that should stop at `returnToLobby`.

  `safeState(runtimeState)` returns `GameState | undefined` for the
  bootstrap meaning. Writers assign via `setRuntimeGameState` so
  `stateInstalled` stays in sync.

- **`runtimeState.frameMeta` is populated by `computeFrameContext` inside
  `mainLoop`.** Code that runs before the first main-loop tick will see
  a placeholder. The composition root hydrates it via a warm-up tick
  before `startGame()` in headless mode.

- **The `roots` tier exemption is load-bearing for `composition.ts`.**
  If a refactor ever tries to reclassify it to a non-roots tier, the
  `typeOnlyFrom` lint will fire on every render/input import. See
  `.import-layers.json` — `composition.ts` must stay in the
  "composition roots" tier.

## Related reading

- **`scripts/lint-architecture.ts`** — Enforces the sub-system factory
  shape (one factory per file, single deps parameter, no cross-imports).
- **`scripts/lint-domain-boundaries.ts`** — Enforces the `runtime →
  {shared, game}` purity contract (with type-only exceptions for
  input/render and the roots-tier exemption for `composition.ts`).
- **[skills/layer-graph-cleanup.md](../../skills/layer-graph-cleanup.md)**
  — Historical log of past runtime refactors.
- **[test/runtime-headless.ts](../../test/runtime-headless.ts)** — The
  headless variant of `createGameRuntime` used by the test scenario
  API. Good reference for what deps the composition root expects.
