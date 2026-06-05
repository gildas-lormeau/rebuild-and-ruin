# test/

Tests play the game through one primitive and observe it — they never hack
runtime state, construct subsystems in isolation, or skip phases.

- **Writing a test?** Skim the pattern catalogue ([patterns.md](patterns.md))
  for the ~5 shapes, then follow the end-to-end workflow in the
  [`/add-test`](../skills/add-test.md) skill.
- **Debugging a failure?** Use the [`/debug`](../skills/debug.md) skill
  (headless) or [`/debug-e2e`](../skills/debug-e2e.md) (spawns a worktree
  sub-agent). Never guess at causes.

This file maps the **support surface** — the helpers, observers, and diag
scripts that aren't tests themselves. The `*.test.ts` files are the tests; the
files below are what they import (or what you run by hand).

## The contract — import these

| File | Role |
| --- | --- |
| [scenario.ts](scenario.ts) | The one primitive. `createScenario({ seed, mode, rounds })` → `{ state, bus, input, runGame, tileAt, … }`. Headless, mock clock. |
| [e2e/scenario.ts](e2e/scenario.ts) | `createE2EScenario` — async Playwright mirror of the same shape. For **rendering** assertions via bridge snapshots, not game state. Needs `npm run dev`. |
| [seed-conditions.ts](seed-conditions.ts) | `loadSeed(name)` + `SEED_CONDITIONS` — drift-safe named seeds. Reach for this instead of hardcoding a seed for a game condition. |

[runtime-headless.ts](runtime-headless.ts) is the headless driver `scenario.ts`
wraps — **don't import it directly**; everything test-facing is on `scenario.ts`.

## Observers — test-imported analysis over the bus

Subscribe to a scenario's bus/TICK and accumulate a structured or human-readable
view. Pure reads, no mutation.

| File | Produces |
| --- | --- |
| [narrative-observer.ts](narrative-observer.ts) | Event stream → human-readable play-by-play (commentary, not a renderer). |
| [build-trace-observer.ts](build-trace-observer.ts) | One `(round, player)`'s AI build decisions as a relative-position play-by-play ("filled 1 of 3 south gaps"). |
| [battle-metrics-observer.ts](battle-metrics-observer.ts) | One metrics row per `(battle, player)` — shot economy / offense / defense / crosshair. Tracks, doesn't score. |
| [impact-classify.ts](impact-classify.ts) | Structured `{ kind, ownerId? }` for an impact tile (own-wall / enemy-wall / immune-tower / grunt / …). Used by the battle-metrics observer. |

## Standalone diag & run scripts — `deno run -A test/diag/<file>.ts`

Not `Deno.test`s — one-off investigation tools you invoke directly. Live in
[diag/](diag/).

| File | Use |
| --- | --- |
| [diag/lock-sec.ts](diag/lock-sec.ts) | Per-tick `selectTarget` trace for one stall round. `<seed> <round> <playerId>`. |
| [diag/winnability.ts](diag/winnability.ts) | Bag-coverage solver: is any placement sequence able to close a LATE_PLATEAU stall's ring gaps? |
| [diag/grunt-spawn-per-tower.ts](diag/grunt-spawn-per-tower.ts) | Per-`(zone, round, tower)` spawn-distribution table — checks spawns don't concentrate on one tower. |
| [diag/grunt-spawn-visual-run.ts](diag/grunt-spawn-visual-run.ts) | ASCII samples of WALL_BUILD across rounds 2–4 (visual spot-check). |
| [winnability-solver.ts](winnability-solver.ts) | The backtracking solver shared by `diag/winnability` and the survival runner — stays at root since both subfolders consume it. |

## AI build-survival harness — [survival/](survival/)

| File | Role |
| --- | --- |
| [survival/build-survival.test.ts](survival/build-survival.test.ts) | Entry — one `Deno.test` per seed, spawns the worker pool. `npm run test:survival`. |
| [survival/runner.ts](survival/runner.ts) | Shared engine — imported by both the test file and the worker. |
| [survival/worker.ts](survival/worker.ts) | Deno worker — runs one seed on a background thread; with `logDir` set, captures per-seed logs to `${logDir}/seed-{N}.log`. |

## DOM / env shims — side-effect or infra imports

| File | Why |
| --- | --- |
| [test-globals.ts](test-globals.ts) | DOM polyfills so the **real** keyboard/mouse/touch handlers run headless. |
| [stub-dom.ts](stub-dom.ts) | Shared canvas-host element stub (`clientWidth`, `classList`, `style.cursor`, …). |
| [online-dom-shim.ts](online-dom-shim.ts) | `document` shim so test files that transitively import online code don't crash on load. |
| [portrait-globals.ts](portrait-globals.ts) | **First** import in a file → grid swaps to 28×44 portrait (mobile-portrait repro). |

## Renderers & canvas mocks

| File | Role |
| --- | --- |
| [ascii-renderer.ts](ascii-renderer.ts) | `RendererInterface` as text grids via `renderer: "ascii"` — the basis of `asciiSnapshot`. |
| [recording-canvas.ts](recording-canvas.ts) | Duck-typed canvas that records 2D calls — assert on call **shape**, never pixels. |

## Online & E2E plumbing

| File | Role |
| --- | --- |
| [network-setup.ts](network-setup.ts) | Online scenario factories (`online: "host" \| "watcher"`) + `createNetworkedPair` two-runtime loopback. |
| [e2e/helpers.ts](e2e/helpers.ts) | Playwright wrappers — use `waitForPageFn` (raw `page.waitForFunction` is lint-forbidden outside this file). |
| [e2e/example.ts](e2e/example.ts) | Canonical E2E template — copy from here. |

## Bench & fixtures

| File | Role |
| --- | --- |
| [scenario.bench.ts](scenario.bench.ts) | `Deno.bench` full-game perf (classic + modern, 8 rounds). |
| [determinism-fixtures/](determinism-fixtures/) | Recorded bus-event logs replayed byte-for-byte by `npm run test:determinism`. Re-record only on intentional divergence. |
