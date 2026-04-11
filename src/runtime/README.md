# `src/runtime/` — Game runtime orchestration

The **runtime** domain owns the per-frame game loop, all UI-facing
sub-systems (camera, render, banners, dialogs, input wiring), and the
composition root that assembles everything into a runnable game for both
local play and online play.

This domain is **almost entirely pure**: 26 of 27 files import only from
`shared/`, `game/`, and `player/`. The one exception is
[runtime-composition.ts](./runtime-composition.ts) — the single
composition root — which crosses into `input/`, `render/`, `ai/`, and
`online/` to wire everything together. That file is the only part of
`runtime/` that's allowed to touch those domains. The purity contract is
enforced by `.domain-boundaries.json`'s `typeOnlyFrom` clause plus the
tier classification in `.import-layers.json` (roots-tier files are
exempt from the type-only restriction).

## Read these first (in order)

1. **[runtime-types.ts](./runtime-types.ts)** — Public interfaces:
   `RuntimeConfig`, `GameRuntime`, `NetworkApi`, `TimingApi`,
   `OnlinePhaseTicks`, the sub-system contracts. Also documents the
   `deps`-bag convention used by every `createXSystem(deps)` factory in
   this folder. **Start here — every other file makes more sense after
   this one.**

2. **[runtime-state.ts](./runtime-state.ts)** — The `RuntimeState` bag
   held by the composition root. This is the mutable state every
   sub-system reads and writes. Phase timers, UI dialog state, frame
   metadata, pointer-player cache, lobby state, options state. If
   you're wondering "where does X live?", the answer is usually
   somewhere in `runtimeState.*`.

3. **[runtime-composition.ts](./runtime-composition.ts)** — The wiring.
   Creates every sub-system, threads their deps, and returns a
   `GameRuntime` handle. ~680 lines of factory calls in a deliberate
   order (one sub-system depends on another's exports). Read this
   last — it's easier to understand once you know what's being wired.

## File categories

### Composition root (1 file — the ONE impure file)
- **`runtime-composition.ts`** — `createGameRuntime(config)` creates
  every sub-system and wires them together. Also exports
  `createBrowserRuntimeBindings(canvas)` and `createLocalNetworkApi()`
  as wiring primitives shared by all three callers (`src/main.ts`,
  `src/online/online-runtime-game.ts`, `test/runtime-headless.ts`).
  **Only edit this file if you need a new subsystem, a new cross-domain
  wire, or a new wiring primitive. Otherwise leave it alone.**

### State + types (2 files — start here if you're new)
- **`runtime-state.ts`** — The `RuntimeState` interface + factory.
- **`runtime-types.ts`** — `RuntimeConfig`, `GameRuntime`, sub-system
  deps interfaces, `NetworkApi`, `TimingApi`, the modal dialog lifecycle
  contract.

### Sub-system factories (one `createXSystem(deps)` each)
Each of these exports a `createXSystem(deps)` factory that takes a
deps object and returns a handle with methods. They are wired by
`runtime-composition.ts`, never imported by each other.

| File | System | What it owns |
|---|---|---|
| `runtime-banner.ts` | Banner | Phase transition banner show/tick |
| `runtime-camera.ts` | Camera | Viewport, zoom, auto-zoom, lerp |
| `runtime-game-lifecycle.ts` | Lifecycle | startGame, rematch, endGame, returnToLobby |
| `runtime-human.ts` | PointerPlayer | Cached pointer-player lookup (touch vs. desktop) |
| `runtime-input.ts` | Input | Keyboard/mouse/touch event registration + dispatch |
| `runtime-life-lost.ts` | LifeLost | Life-lost dialog lifecycle (show/tick/resolve) |
| `runtime-lobby.ts` | Lobby | Lobby UI state + render + slot joining |
| `runtime-options.ts` | Options | Options/controls screens, keybinding UI, seed input |
| `runtime-phase-ticks.ts` | PhaseTicks | Per-frame dispatch for cannon/build/battle phases |
| `runtime-render.ts` | Render | Per-frame overlay build + drawFrame + touch controls update |
| `runtime-score-deltas.ts` | ScoreDelta | Animated score delta display after build phase |
| `runtime-selection.ts` | Selection | Castle selection phase (initial + reselect) |
| `runtime-upgrade-pick.ts` | UpgradePick | Upgrade-pick dialog lifecycle (show/tick/resolve) |

### Primitives / helpers (NOT sub-systems)
These are pure functions or small factories consumed by the sub-systems
above. They don't follow the `createXSystem(deps)` contract and are
exempt from the "sub-systems must not import from each other" rule.
- **`runtime-bootstrap.ts`** — `bootstrapNewGameFromSettings()` — builds
  controllers + initial game state from lobby settings. Consumed by
  the game-lifecycle system.
- **`runtime-browser-timing.ts`** — `createBrowserTimingApi()` wraps
  browser globals into a `TimingApi`. Entry-point binding only.
- **`runtime-castle-build.ts`** — Castle wall animation primitives
  (consumed by selection).
- **`runtime-life-lost-core.ts`** — Pure dialog state helpers for the
  life-lost system (separated from the factory for testability).
- **`runtime-upgrade-pick-core.ts`** — Same pattern for upgrade-pick.
- **`runtime-transition-steps.ts`** — Reusable step functions for phase
  transitions (shared between local and online paths).
- **`banner-messages.ts`** — Phase transition banner string constants.
- **`assembly.ts`** — `createRuntimeLoop(deps)` + input adapter wiring.
  Called once by the composition root.

### Dev tools (3 files, excluded from non-dev builds by `IS_DEV`)
- **`dev-console.ts`** — Exposes dev commands to the browser console
  (F12). Wired only in dev builds.
- **`dev-console-grid.ts`** — Grid rendering helpers for the dev
  console.
- **`runtime-e2e-bridge.ts`** — Exposes structured game state on
  `window.__e2e` for Playwright-based E2E tests.

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
  `runtime-composition.ts` top-to-bottom to see the dependency chain.

- **Sub-systems MUST NOT import from each other.** They can only import
  from `runtime-types.ts`, `runtime-state.ts`, and a few approved
  primitive files (see `scripts/lint-architecture.ts`
  `ALLOWED_RUNTIME_IMPORTS`). All cross-subsystem wiring happens in
  the composition root via the `deps` object. This is enforced by
  `lint-architecture.ts`.

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
1. Create `src/runtime/runtime-<name>.ts` with a `createXSystem(deps)` factory.
2. Define the `XDeps` and `XSystem` interfaces in the same file (or in `runtime-types.ts` if consumed elsewhere).
3. Add to `runtime-composition.ts` in dependency order (after its deps are created, before its consumers).
4. If other sub-systems need to call yours, add the handle to their deps via the composition root.
5. Run `deno run -A scripts/lint-architecture.ts` — it enforces the factory shape.

### Add a new dialog lifecycle (modal UI)
Look at `runtime-life-lost.ts` or `runtime-upgrade-pick.ts` for the
pattern: dialog state lives in `runtimeState`, the `core.ts` file has
pure state helpers, the factory wires tick/show/resolve + sound/haptics.
The modal dialog contract is documented in `runtime-types.ts`.

### Add a new phase tick
Look at `runtime-phase-ticks.ts`. Per-phase tick logic lives in there.
If the new phase logic is pure game code, put it in `src/game/` first
and call it from `runtime-phase-ticks.ts`.

### Add a new dev tool command
`dev-console.ts`. Guarded by `IS_DEV`, so no production cost.

## Gotchas

- **`runtime-composition.ts` is NOT a sub-system.** It's the composition
  root. Everything else in this folder must stay pure (no imports from
  input/render/ai/online beyond type-only).

- **Don't import directly between sub-systems.** The architecture lint
  will reject it. Cross-sub-system wiring goes through
  `runtime-composition.ts` via the deps bag.

- **`runtimeState.state` can be a sentinel before the game starts.**
  Use `safeState(runtimeState)` (returns `GameState | undefined`) or
  `isStateReady(runtimeState)` (boolean guard) for code that runs
  before `startGame()` — notably render, input, lobby.

- **`runtimeState.frameMeta` is populated by `computeFrameContext` inside
  `mainLoop`.** Code that runs before the first main-loop tick will see
  the sentinel. The composition root hydrates it via a warm-up tick
  before `startGame()` in headless mode.

- **The `roots` tier exemption is load-bearing for
  `runtime-composition.ts`.** If a refactor ever tries to reclassify
  it to a non-roots tier, the `typeOnlyFrom` lint will fire on every
  render/input import. See `.import-layers.json` — `runtime-composition.ts`
  must stay in the "composition roots" tier.

## Related reading

- **`scripts/lint-architecture.ts`** — Enforces the sub-system factory
  shape (one factory per file, single deps parameter, no cross-imports).
- **`scripts/lint-domain-boundaries.ts`** — Enforces the `runtime →
  {shared, game, player}` purity contract (with type-only exceptions
  for input/render and the roots-tier exemption for
  `runtime-composition.ts`).
- **[skills/layer-graph-cleanup.md](../../skills/layer-graph-cleanup.md)**
  — Historical log of past runtime refactors.
- **[test/runtime-headless.ts](../../test/runtime-headless.ts)** — The
  headless variant of `createGameRuntime` used by the test scenario
  API. Good reference for what deps the composition root expects.
