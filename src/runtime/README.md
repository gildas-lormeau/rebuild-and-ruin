# `src/runtime/` — Game runtime orchestration

The **runtime** domain owns the per-frame game loop, all UI-facing
sub-systems (camera, render, banners, dialogs, input wiring), and the
composition root that assembles everything into a runnable game for both
local play and online play.

This domain is **almost entirely pure**: 27 of 31 files import only from
`shared/` and `game/`. Four files reach further, and each for a
narrow, documented reason:

- [runtime-composition.ts](./runtime-composition.ts) — the composition
  root — crosses into `input/`, `render/`, `ai/`, and `protocol/` to
  wire everything together. Exempt from purity via the roots-tier
  classification in `.import-layers.json`.
- [runtime-bootstrap.ts](./runtime-bootstrap.ts) — imports
  `controllers/controller-factory.ts` because its whole job is turning
  lobby settings into a controller set.
- [runtime-e2e-bridge.ts](./runtime-e2e-bridge.ts) — imports
  `render/render-layout.ts` (`computeLetterboxLayout`) so the
  Playwright bridge can convert canvas coordinates.
- [runtime-types.ts](./runtime-types.ts) — type-only imports from
  `protocol/` for `NetworkApi` / `BattleStartData` shapes.

The purity contract is enforced by `.domain-boundaries.json` plus the
tier classification in `.import-layers.json` (roots-tier files are
exempt from the cross-domain restriction).

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

### Composition root (1 file — the main wiring point)
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
| `runtime-haptics.ts` | Haptics | Vibration observer — gated by haptics setting, write-only test observer |
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
| `music-player.ts` | XMI MIDI playback, bg tracks, fanfares |
| `sfx-player.ts` | VOC sample playback, event-map dispatcher, snare crescendo |
| `music-assets.ts` | IndexedDB asset storage + RSC/XMI extraction |
| `music-synth-loader.ts` | WOPL synth worklet loader + gain envelope |
| `sound-modal.ts` | HTML modal for asset import (DOM UI) — standalone factory, not a sub-system; exposed to the options screen via a `showSoundModal` callback rather than the deps bag |

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
- **`runtime-contracts.ts`** — Sub-system interface aggregator:
  `UIContext`, `BannerState`, `BannerShow`, and every `XSystem` /
  `XDeps` type shared across the composition root. Also exports
  `createBannerState()` — a trivial factory intentionally placed here
  (not in `runtime-state.ts`) to keep `runtime-state.ts` at L6 in the
  layer graph. Don't "helpfully" move it. See
  [skills/layer-graph-cleanup.md](../../skills/layer-graph-cleanup.md).
- **`runtime-tick-context.ts`** — Shared tick-context types + the
  APPLY/TICK/CHECKPOINT mutation-phase doc. Extracted from
  `runtime-phase-ticks.ts` so `battle-ticks.ts` can depend on it
  without a peer dependency.
- **`runtime-life-lost-core.ts`** — Pure dialog state helpers for the
  life-lost system (separated from the factory for testability).
- **`runtime-upgrade-pick-core.ts`** — Same pattern for upgrade-pick.
- **`runtime-phase-machine.ts`** — Pure data-driven phase-transition
  state machine. The `TRANSITIONS` table declares each transition's
  mutate (host vs watcher), display steps (banner / score-overlay /
  life-lost-dialog / upgrade-pick), and postDisplay side-effects.
  `runTransition(id, ctx)` is the single entry point — captures the
  scene, runs mutate, walks the display, fires postDisplay. Both host
  ([`runtime-phase-ticks.ts`](runtime-phase-ticks.ts):`buildHostPhaseCtx`)
  and watcher
  ([`../online/online-phase-transitions.ts`](../online/online-phase-transitions.ts):`buildWatcherPhaseCtx`)
  build the `PhaseTransitionCtx`; the machine picks the role-specific
  fn off `ctx.role`.
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

- **`runtimeState.state` holds a placeholder before the game starts.**
  Use `safeState(runtimeState)` (returns `GameState | undefined`) or
  `isStateReady(runtimeState)` (boolean guard) for code that runs
  before `startGame()` — notably render, input, lobby. Writers assign
  via `setRuntimeGameState` so the readiness flag stays in sync.

- **`runtimeState.frameMeta` is populated by `computeFrameContext` inside
  `mainLoop`.** Code that runs before the first main-loop tick will see
  a placeholder. The composition root hydrates it via a warm-up tick
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
  {shared, game}` purity contract (with type-only exceptions for
  input/render and the roots-tier exemption for
  `runtime-composition.ts`).
- **[skills/layer-graph-cleanup.md](../../skills/layer-graph-cleanup.md)**
  — Historical log of past runtime refactors.
- **[test/runtime-headless.ts](../../test/runtime-headless.ts)** — The
  headless variant of `createGameRuntime` used by the test scenario
  API. Good reference for what deps the composition root expects.
