# Runtime invariants manifest

The load-bearing invariants of the `src/runtime/` domain (the per-frame loop,
the phase-transition machine, the composition root, and the UI/observer
sub-systems), each tagged with **how it is guarded**.

## Why this file exists

A *global* runtime review is hard for an agent because runtime behaviour is
cross-cutting and dynamic — the bugs live in ordering, multi-tick state,
eliminated-player edges, and cross-peer parity, none of which sit in a single
file. An agent re-deriving "what must stay true" from scratch every review is
slow and shallow.

This manifest is the **finite worklist**. The model is *subtraction*:

| Tier | Meaning | What a reviewing agent does |
|---|---|---|
| 🟢 **lint** | A pre-commit lint guarantees it. It cannot land broken. | **Skip.** Trust the guard. |
| 🟡 **test** | A parity/scenario test pins it — but only catches the bug if that path is exercised. | **Spot-check** the path is covered; don't re-derive the invariant. |
| 🔴 **review** | No automation. A human or agent is the only guard. | **Review every time.** This is the real worklist. |

So a runtime review = verify the 🔴 set against the code (and a behaviour
trace), confirm the 🟡 set's paths are exercised, and ignore the 🟢 set.

**Maintenance rule (the lever):** every time an invariant moves 🔴 → 🟡 → 🟢
(someone writes a test or a lint for it), update its tier here. The long-term
goal is to shrink the 🔴 set toward empty. An invariant with no entry here is a
gap — add it. This file follows the project's *tools-not-rules* principle:
prefer building the guard over restating the rule, and record which rules still
lack a guard.

---

## 🟢 lint-guarded — skip these in review

These cannot land broken; the named lint runs in pre-commit.

| # | Invariant | Guard |
|---|---|---|
| E1 | **Runtime purity.** Runtime files import only from `shared/` + `game/` (plus `import type` from input/render/protocol; `composition.ts` + `bootstrap.ts` exempt via roots tier). | `lint-domain-boundaries.ts` + roots-tier in `.import-layers.json` |
| E2 | **Sub-system shape.** Every `subsystems/*.ts` exports a `create*`/`update*` factory taking a single deps param. Sub-systems never value-import each other (`import type` allowed); cross-wiring goes through `composition.ts`. A `create*System` at runtime root is rejected. | `lint-architecture.ts` |
| E3 | **Non-runtime subsystem boundaries.** Who may import internal game/online/input/render subsystem files. | `lint-architecture-non-runtime.ts` |
| E4 | **Single rAF chain.** `mainLoop` is scheduled from exactly two sites (self-reschedule in `main-loop.ts`, one kick in `composition.ts`). No parallel loops. | `lint-raf-mainloop.ts` |
| E5 | **Checkpoint completeness.** Every top-level `GameState`/`ModernState` field is wired into network serialization. | `lint-checkpoint-fields.ts` |
| E6 | **`setPhase` is barrelled.** Phase mutation imports `setPhase` only via `game/index.ts`, except two allowlisted `online/` checkpoint-replay sites. | `lint-restricted-imports.ts` |
| E7 | **AI/animation never reads `state.rng`.** AI uses `strategy.rng` (private for assisted-human). Direct `state.rng.` in AI/anim code breaks assisted-human parity. | `lint-ai-rng-isolation.ts` |
| E8 | **No raw entropy in sim.** No `Math.random`/`Date.now`/`new Date`/`performance.now` in `game/` or `ai/`. | `lint-entropy-sources.ts` |
| E9 | **No RNG draws in controller constructors** (lands on different Rngs across host/watcher). | `lint-controller-ctor-rng.ts` |
| E10 | **Modifier apply/clear symmetry.** Every `state.modern.X` written by `apply` is also written by `clear` — else it leaks through checkpoints. | `lint-modifier-lifecycle.ts` |
| E11 | **Tile mutators recompute zones.** Any file calling `setWater`/`setGrass` must call `recomputeMapZones`. | `lint-tile-mutators.ts` |
| E12 | **`applyAt` is wire-sourced.** Mutating wire handlers source `applyAt` from the message, never a local tick — else lockstep breaks. | `lint-applyat.ts` |
| E13 | **Intent-commit returns are not dropped.** Callers of `executePlaceCannon`/`executePlacePiece`/`schedule*Placement` must consume the falsy-on-reject return. | `lint-place-intent-return.ts` |
| E14 | **No callback layer-inversion.** Closures passed downward must not capture symbols from a higher layer. | `lint-callback-inversion.ts` |
| E15 | **Accessor helpers, not inlined deep lookups** (`getCannon`, `zoneAt`, …). | `lint-accessor-bypasses.ts` |
| E16 | **`\| undefined`, not `\| null = null`** for "not yet set" fields/locals. | `lint-null-init.ts` |
| E17 | **Banner subtitle constants** appear only in the canonical phase-transition files. | `lint-phase-transitions.ts` |

---

## 🟡 test-guarded — confirm coverage, don't re-derive

A test pins these, but the guarantee is only as good as the path the test
exercises. In review: check the relevant path is still covered, not that the
invariant holds in the abstract.

| # | Invariant | Pinned by |
|---|---|---|
| T1 | **Transition mutates run at the dispatch tick (lockstep).** Deferring a mutate behind per-peer rendered-frame camera convergence desyncs in-flight `applyAt` actions. | `test/camera-zoom-parity.test.ts` (3rd parity gate) |
| T2 | **Camera never affects the sim.** A touch peer with mobile auto-zoom must converge bit-for-bit with a desktop peer. Camera/pitch/zoom state is cosmetic and must not feed any gameplay decision. | `test/camera-zoom-parity.test.ts` |
| T3 | **Local and online paths stay in parity.** Shared game logic produces identical state under host/watcher and bidirectional drive. | `network-vs-local`, `network-bidirectional` parity gates |
| T4 | **Runtime is deterministic.** Same inputs → byte-identical bus-event log. | `test/determinism-fixtures/` replay (`test:determinism`) |

> Coverage caveat (from the closed migration reviews): the parity probes
> serialize and diff state, so anything **not serialized** is invisible to them
> — controller cursor, `lastTargetTowerIndex`, piece bags, `accum.grunt`. If
> your change touches those, the 🟡 tests will *not* catch a regression; treat
> it as 🔴.

---

## 🔴 review-only — the actual worklist

No automation guards these. Review every one against the code, and where noted,
against a behaviour trace (a headless per-tick state+event dump). Each entry
says **how to check it**.

### Phase machine & transitions

- **R1 — Phase entry routes through `enter*Phase`.** Runtime transitions in
  `phase-machine.ts` set phase + entry-time `state.timer` only via the
  `enter*Phase` helpers (`enterCannonPhase`, `enterModifierRevealPhase`,
  `enterBattlePhase`, `enterUpgradePickPhase`, `enterWallBuildPhase`,
  `enterSelectionPhase`) — never `setPhase` or `state.phase =` /
  `state.timer =` inline. (E6 only restricts the *import* of `setPhase`; the
  discipline of using the helper is unguarded.)
  *Check:* grep transition `mutate` bodies for `state.phase`/`state.timer`
  assignments; every one should be inside an `enter*Phase` call.

- **R2 — Intent-then-execute ordering.** Controllers compute a read-only intent
  (`FireIntent`, `PlacePieceIntent`) *before* the orchestrator mutates; no
  read of mutable `GameState` *after* a mutation within the same transition
  step (read-after-mutate is a parity hazard).
  *Check:* trace each transition's `mutate`; confirm reads precede writes and
  no controller method mutates state directly.

- **R3 — Eliminated-player handling.** Every transition `mutate` and phase-init
  path skips eliminated slots (lives = 0). Destructive clauses are gated on
  *which* case — true elimination vs. life-loss reset (towers **revive** on
  life-loss, are cleared on elimination). Round-1 takeover-race windows are
  where this bites.
  *Check:* for each destructive clause, ask "does this run for a life-losing
  player who will reselect?" Verify against the death-vs-life-loss distinction.

- **R4 — `score-deltas {0,0} homeTower fallback is reachable — do not delete.**
  A reselect-queued player with a positive delta hits it (seed 0 classic, first
  reselect). A past review wrongly called it dead and removing it threw.
  *Check:* if a review flags this as unreachable, it is wrong; leave it.

### Migration / parity seams (highest-risk, mostly invisible to 🟡 tests)

- **R5 — serialize-first/draw-after (the migration keystone).** At host
  migration and rejoin-into-started-room, **every** peer serializes the
  snapshot *first*, then replays the *same* post-serialize `state.rng` draws.
  A **targeted** resync (snapshot to one peer) forks — it re-primes on that
  peer alone and advances its rng past the others. Rejoin must reuse the
  **broadcast** path (`rebroadcastFullStateForResync`), never a targeted send.
  *Check:* any new resync/re-prime path — confirm it is broadcast and that
  post-serialize rng draws are identical on all peers. `promote.ts` is canonical.

- **R6 — `runtimeState` writes are owned; reads are free.** Each
  `runtimeState.*` field is *written* by exactly one sub-system (identifiable
  by name); any sub-system may read. A second writer is the bug.
  *Check:* for a touched field, grep all assignment sites; they must all live
  in one sub-system. (Reads are unrestricted — don't flag those.)

- **R7 — Unserialized-by-design state is re-derived on adopt, not serialized.**
  Controller cursor + `lastTargetTowerIndex` (`ctrl.reset()`), piece bags
  (`redealPlayerBagsForAdoption`), `accum.grunt` (rides
  `FullStateMessage.gruntAccum`). Adding new per-peer-only state means adding
  its re-derivation to the adopt path.
  *Check:* new ephemeral controller/animation state — is it re-derived on
  migration adopt? If not, it forks silently (🟡 tests won't see it — R-tier).

### Observer & lifecycle discipline

- **R8 — The bus is observers-only.** Sound, haptics, and other observers react
  to bus events; runtime control flow must remain correct with the bus removed.
  No control-flow decision may depend on a bus emission.
  *Check:* new `bus.emit`/`bus.on` — is the emitter's correctness independent
  of whether anyone listens? Observers must not feed back into the sim.

- **R9 — Correct lifecycle guard.** Per-tick presentational signals, animators,
  and state-derived computations use `isSessionLive(runtimeState)` (stops at
  `returnToLobby`). `isStateInstalled` / `safeState` is only for paths that
  legitimately read frozen state outside a session (game-over render, dev
  console, E2E bridge).
  *Check:* a new per-tick read guarded by `isStateInstalled` is likely wrong —
  it should be `isSessionLive`.

- **R10 — Animation state is owned by the runtime; the renderer only paints.**
  No gameplay/animation state originates in `render/`; the renderer reads
  runtime-owned state and draws. Serialize-first/draw-after: serialize the
  snapshot before any draw on a migration frame.
  *Check:* new mutable state in a render path — should it live in `runtimeState`
  and be passed down instead?

### Wiring conventions (cheap to check, easy to drift)

- **R11 — DI pattern matches context.** Subsystem → deps object; online message
  handler → closure/late-binding getter; global online state → module singleton
  (never for game state); controller mutation → intent + execute callback.
  *Check:* new wiring — does it match the pattern of its neighbours? (See
  `docs`/the DI conventions; runtime `README.md` §"deps convention".)

- **R12 — Late-binding deps are getters, not values.** A dep read *after* the
  consuming sub-system is constructed (because the producer is created later)
  must be a getter (`getState: () => …`), not a captured value.
  *Check:* a plain-value dep that resolves a later-created sub-system is a
  construction-order bug waiting to happen.

---

## Using this with a fan-out review

Slice the review **by seam, not by file** — the sub-system isolation (E1–E3)
makes each seam reviewable alone:

1. One agent per **observer sub-system** (audio, haptics, render-paint,
   score-deltas) — shallow; the contracts isolate them. Anchor to R8–R10.
2. One agent per **🔴 cluster above** (phase machine R1–R4, migration R5–R7,
   lifecycle R8–R10, wiring R11–R12).
3. Feed each agent a **behaviour trace** (headless per-tick state+event dump
   from a determinism fixture) alongside the code — the dynamic invariants
   (R2, R3, R5) are checkable against the trace, not from static reading.

See `src/runtime/README.md` for orientation (read `types.ts` → `state.ts` →
`composition.ts` first) and `reference_runtime_migration_invariants` (memory)
for the full migration-seam residue. For the phase flow specifically,
[runtime-phase-graph.md](runtime-phase-graph.md) is a generated map of every
transition (guard / enters-phase / engine ops / broadcasts / routing) — the
artifact to check R1 and R3 against.
