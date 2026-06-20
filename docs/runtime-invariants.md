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
gives **how to check it**, the **current enforcing fact** (what satisfies the
invariant today), and an **Anchor** to where that fact lives.

> **Anchors are `file › symbol`, not `file:line`** — symbol anchors survive
> line shifts, are greppable, and are verifiable by `comment-refs --symbols`.
> All anchors below were verified present on 2026-06-14 (dogfood review). If a
> symbol moves or is renamed, update the anchor; if the fact it pins changes,
> the invariant changed — re-review, don't just re-anchor.

### Phase machine & transitions

- **R1 — Phase entry routes through `enter*Phase`.** Runtime transitions in
  `phase-machine.ts` set phase + entry-time `state.timer` only via the
  `enter*Phase` helpers (`enterCannonPhase`, `enterModifierRevealPhase`,
  `enterBattlePhase`, `enterUpgradePickPhase`, `enterWallBuildPhase`,
  `enterSelectionPhase`) — never `setPhase` or `state.phase =` /
  `state.timer =` inline. (E6 only restricts the *import* of `setPhase`; the
  discipline of using the helper is unguarded.)
  *Fact:* every `enter*Phase` is the sole `setPhase` caller for its phase and
  primes that phase's entry timer; prep transitions flip nothing (they route).
  *Anchor:* `game/phase-entry.ts › enter*Phase`;
  [runtime-phase-graph.md](runtime-phase-graph.md) "enters phase" column.
  *Check:* grep transition `mutate` bodies for `state.phase`/`state.timer`
  assignments; every one should be inside an `enter*Phase` call.

- **R2 — Intent-then-execute ordering.** Controllers compute a read-only intent
  (`FireIntent`, `PlacePieceIntent`) *before* the orchestrator mutates; no
  read of mutable `GameState` *after* a mutation within the same transition
  step (read-after-mutate is a parity hazard).
  *Fact:* controllers never mutate `ctx.state` inside the machine — the
  orchestrator applies all mutations via engine calls; dialog subsystems
  *produce* resolutions, the machine *applies* them (`applyUpgradePicks`,
  `eliminatePlayers`). `ROUND_END` reads `peekGameOverOutcome` *before*
  `state.round++` (load-bearing — peek must see the closing round).
  *Anchor:* `runtime/phase-machine.ts › ROUND_END`, `› finishUpgradePick`.
  *Check:* trace each transition's `mutate`; confirm reads precede writes and
  no controller method mutates state directly.

- **R3 — Eliminated-player handling.** Every transition `mutate` and phase-init
  path skips eliminated slots (lives = 0). Destructive clauses are gated on
  *which* case — true elimination vs. life-loss reset (towers **revive** on
  life-loss, are cleared on elimination). Round-1 takeover-race windows are
  where this bites.
  *Fact:* `applyLifePenalties` splits on `lives <= 0` *after* the decrement
  (death → `eliminatePlayer`; life-loss → `needsReselect`), skipping
  already-dead slots. `resetZoneState` sets `towerAlive[i] = true` for **both**
  cases — the only behavioural difference is the `ownerEliminated` arg gating
  cross-zone grunt eviction. Win-eligibility filters via `isPlayerAlive`.
  RNG-consuming new-round seeding skips unseated slots (`prepareNextRound`).
  *Anchor:* `game/phase-setup.ts › applyLifePenalties`, `› resetZoneState`;
  `game/game-over.ts › peekGameOverOutcome`. **(R3's substance lives in the
  engine, not the machine — the graph's "engine ops" list is the index, these
  anchors are the destinations.)**
  *Check:* for each destructive clause, ask "does this run for a life-losing
  player who will reselect?" Verify against the death-vs-life-loss distinction.

- **R4 — `score-deltas {0,0} homeTower fallback is reachable — do not delete.**
  A reselect-queued player with a positive delta hits it (seed 0 classic, first
  reselect): the life penalty nulls `homeTower` while territory scoring already
  produced a positive delta. A past review wrongly called it dead and removing
  it threw.
  *Anchor:* `runtime/subsystems/score-deltas.ts` (`homeTower ? … : { x: 0, y: 0 }`).
  *Check:* if a review flags this as unreachable, it is wrong; leave it.

### Migration / parity seams (highest-risk, mostly invisible to 🟡 tests)

- **R5 — serialize-first/draw-after (the migration keystone).** At host
  migration and rejoin-into-started-room, **every** peer serializes the
  snapshot *first*, then replays the *same* post-serialize `state.rng` draws.
  A **targeted** resync (snapshot to one peer) forks — it re-primes on that
  peer alone and advances its rng past the others. Rejoin must reuse the
  **broadcast** path (`rebroadcastFullStateForResync`), never a targeted send.
  *Fact:* the only two `createFullStateMessage` send-sites are both broadcast;
  `forPlayerId` carries only the *request*, which parks a room-wide deferred
  resync fired to everyone. Adopters restore `state.rng` in place, then replay
  the identical draws (redeal bags → reprime AI) in controller-array order.
  *Anchor:* `online/runtime/promote.ts` + `online/online-resync-defer.ts ›
  rebroadcastFullStateForResync` (producers); `online/online-host-promotion.ts ›
  reprimeAiControllersForPhase` (draw-symmetry contract). **(`promote.ts` lives
  under `online/runtime/`, not `online/`.)**
  *Check:* any new resync/re-prime path — confirm it is broadcast and that
  post-serialize rng draws are identical on all peers.

- **R5b — Shared-`state.rng` draw COUNTS must be board-independent.** R5 demands
  the same draws in the same order; this is the prerequisite that makes that
  possible. A draw whose *number* of consumptions depends on volatile board
  state (wall / interior / grunt / cannon occupancy) turns **any** cross-peer
  board difference — skew past the SAFETY buffer, real-world jitter, a momentary
  desync the buffer *should* absorb — into a **permanent, total** fork of the
  shared stream: the cursor goes off-by-N and every later AI / modifier / battle
  draw lands shifted. It is also **silent** — a single stale stamp is under the
  lag detector's 5-in-2s disconnect threshold — and the **zero-skew parity gates
  cannot catch it** (`network-bidirectional` / `network-vs-local` run identical
  boards → identical counts → no fork).
  *Status — FIXED 2026-06-20.* Every board-dependent-count `state.rng` draw now
  runs on a **private `Rng`** seeded by `deriveBoardLocalSeed(state.rng.seed,
  round, BOARD_LOCAL_SITE.*, key)` (`shared/core/ai-seed.ts`). Reading
  `state.rng.seed` does NOT advance the cursor, so these sites advance the shared
  cursor by **zero** — a transient board diff stays a small *local* diff instead
  of forking the stream. Proven by `test/skew-repro.test.ts`: across a constant
  wire-delay sweep of 4–20 (the 8-tick SAFETY buffer breached by up to 12 ticks),
  the shared cursor **never** forks; only small bounded board diffs remain, and no
  peer is eliminated-on-one-side. Determinism fixtures + both zero-skew parity
  gates stay green.
  *Converted sites* (`BOARD_LOCAL_SITE` tag → location): HOUSE_REFILL
  (`castle-generation › spawnHousesInZone`), CATAPULT_KIND + GRUNT_WALL_ATTACK +
  GRUNT_SPAWN_JITTER (`grunt-system`), ENCLOSED_GRUNT_RESPAWN + BONUS_REFILL
  (`build-system`), BATTLE_HOUSE_GRUNT + CAPTURED_CANNON_PICK (`battle-system`),
  WILDFIRE_SPREAD (`modifiers/fire`), SINKHOLE_PLACEMENT (`modifiers/sinkhole`),
  LOW_WATER_RIVERBED (`modifiers/low-water`), MORTAR_ELECTION (`upgrades/mortar`),
  RICOCHET_SCATTER (`upgrades/ricochet`), CONSCRIPTION_RESPAWN
  (`upgrades/conscription`), PIECE_BAG (`shared/sim/player-bag › initPlayerBag`),
  CASTLE_CLUMSY (`phase-setup › prepareCastleWallsForPlayer`). The original trace
  (headless three-humans, `dumpRngTraceDivergence`) caught `spawnHousesInZone` +
  the `applyPiecePlacement → addGrunt` house-destruction spawn first; the bag and
  castle clumsy-builder draws were the higher-frequency amplifiers found via the
  skew sweep.
  *Anchor:* `shared/core/ai-seed.ts › deriveBoardLocalSeed` + `BOARD_LOCAL_SITE`.
  *Check:* a new `state.rng.{shuffle,pick,int,bool}` whose iteration count derives
  from board occupancy (a shuffle over a board-derived list, or a per-grunt /
  per-house / per-tile loop, or a single draw in a fn *called* a board-dependent
  number of times) MUST instead draw from a private `Rng` via
  `deriveBoardLocalSeed` with a fresh `BOARD_LOCAL_SITE` tag. A single
  `int`/`bool`/`pick` whose *count* is fixed (one per round, one per fixed slot)
  is fine even if its *result* is board-dependent — only the draw COUNT matters.

- **R6 — `runtimeState` writes are owned; reads are free.** Each
  *persistent* `runtimeState.*` field is *written* by exactly one sub-system
  (identifiable by name); any sub-system may read. A second writer is the bug.
  *Carve-out:* `runtimeState.frame.*` is a **per-substep scratchpad**, rebuilt
  wholesale every substep by `freshFrame`/`clearFrameData` — it is
  *recomputed*, not *owned*, so its many writers (e.g. `frame.announcement`)
  are expected and **not** an R6 violation. The one-writer rule applies to
  persistent bag fields, not `frame.*`.
  *Anchor:* `runtime/state.ts › setMode` (model owned-write example);
  `runtime/main-loop.ts › clearFrameData` (the `frame.*` scratchpad rebuild).
  *Check:* for a touched **persistent** field, grep all assignment sites; they
  must all live in one sub-system. (Reads unrestricted; `frame.*` exempt.)

- **R7 — Unserialized-by-design state is re-derived on adopt, not serialized.**
  Controller cursor + `lastTargetTowerIndex` (`ctrl.reset()`), piece bags
  (`redealPlayerBagsForAdoption`), `accum.grunt` (rides
  `FullStateMessage.gruntAccum`). Adding new per-peer-only state means adding
  its re-derivation to the adopt path.
  *Fact:* sim-gating ephemeral state is re-derived in the apply path
  (controller reset, bag redeal, accum sync, `castleBuilds` requeue,
  `battleAnim.flights` overwrite); render-only effect lists self-purge by age
  and are deliberately *not* re-derived (at most a 1-frame stale visual).
  *Anchor:* `online/online-host-promotion.ts › redealPlayerBagsForAdoption`,
  `› primeAiControllerForPhase`.
  *Check:* new ephemeral controller/animation state — does it **gate dispatch**?
  If yes it must be re-derived on adopt (🟡 tests won't see it — R-tier); if
  it's purely presentational, leaving it stale ~1 frame is fine.

### Observer & lifecycle discipline

- **R8 — The bus is observers-only.** Sound, haptics, and other observers react
  to bus events; runtime control flow must remain correct with the bus removed.
  No control-flow decision may depend on a bus emission.
  *Fact:* the **only** three bus consumers (`.on/bind(GAME_EVENT…)`) in all of
  `src/` are `audio/music-player.ts`, `audio/sfx-player.ts`, and
  `subsystems/haptics.ts` — all observers. A consumer anywhere else is the bug.
  *Anchor:* `runtime/audio/music-player.ts`, `runtime/audio/sfx-player.ts`,
  `runtime/subsystems/haptics.ts` (the complete consumer set).
  *Check:* `grep -rl '\.on(GAME_EVENT\|bind(GAME_EVENT' src/` should return
  exactly those three files; a new emitter's correctness must not depend on a
  listener.

- **R9 — Correct lifecycle guard.** Per-tick presentational signals, animators,
  and state-derived computations use `isSessionLive(runtimeState)` (stops at
  `returnToLobby`). `isStateInstalled` / `safeState` is only for paths that
  legitimately read frozen state outside a session.
  *Fact:* the **sole** sanctioned per-tick `isStateInstalled` read is
  `render.ts` painting the **`Mode.STOPPED`** board — the game-over screen
  (there is **no `Mode.GAME_OVER`**; `endGame` calls `setMode(Mode.STOPPED)`,
  where state lingers installed but `isSessionLive` is false). Everything else
  per-tick (animators in `cannon-animator.ts`, `pointer-player.ts`, the main
  loop) uses `isSessionLive`. Other `isStateInstalled` uses: dev console,
  E2E bridge, banner-snapshot capture.
  *Anchor:* `runtime/subsystems/render.ts` (the `isStateInstalled` early-return);
  `runtime/subsystems/game-lifecycle.ts › endGame` (`setMode(Mode.STOPPED)`);
  `shared/ui/ui-mode.ts › Mode`.
  *Check:* a new per-tick read guarded by `isStateInstalled` is likely wrong
  unless it specifically must paint the `STOPPED` frozen board — else
  `isSessionLive`.

- **R10 — Animation state is owned by the runtime; the renderer only paints.**
  No gameplay/animation state originates in `render/`; the renderer reads
  runtime-owned state via an injected provider and draws. Serialize-first/
  draw-after: serialize the snapshot before any draw on a migration frame.
  *Fact:* the one genuinely gameplay-derived animation (cannon facing) is
  runtime-owned in `cannonAnimator` and reaches the renderer as a *provider
  callback*, never as held state — the canonical "runtime owns, renderer gets
  a provider" wire. `render/` module-level `let`s are GPU resources, draw
  counters, dirty-check memo, and cosmetic wobble only.
  *Anchor:* `runtime/subsystems/cannon-animator.ts › facings` (owner) →
  `runtime/composition.ts › setCannonFacingProvider` (the wire).
  *Check:* new mutable state in a render path — should it live in `runtimeState`
  and be passed down (provider/value) instead?

### Wiring conventions (cheap to *drift*, NOT cheap to *check*)

> R11/R12's check is "reconstruct the composition order and diff every
> forward-reference against it" — O(subsystems × refs). A plain-value dep is
> only a bug if it resolves a *later*-created subsystem; a plain value for an
> *earlier* one is correct. So you cannot flag on "value vs getter" alone — you
> must know the order. This is the cluster most wanting a generated artifact
> (a composition-order table, the way the phase-graph serves R1/R3).

- **R11 — DI pattern matches context.** Subsystem → deps object; online message
  handler → closure/late-binding getter; global online state → module singleton
  (never for game state); controller mutation → intent + execute callback.
  *Fact:* the only module-level online singleton is `_handler` (the message-
  handler closure, **not** game state); every runtime read in the online deps
  builders is a getter (`getState: () => …`, `get joined()`), correct because
  `runtimeState` is volatile across migration.
  *Anchor:* `online/runtime/deps.ts › createMessageHandler` (`_handler`
  singleton + getter reads); runtime `README.md` §"deps convention".
  *Check:* new wiring — does it match the pattern of its neighbours?

- **R12 — Late-binding deps are getters, not values.** A dep that resolves a
  sub-system created *later* in composition order must be a getter
  (`getState: () => …`), not a captured value. A plain value for an *earlier*
  sub-system is fine — order is the discriminator, not the syntax.
  *Fact (today):* every forward-reference is thunked — e.g. `lifecycle`
  (created before `lifeLost`/`upgradePick`) reaches them via
  `getLifeLost: () => lifeLost`; `render` reaches later lobby/options/dialogs
  via thunks, while its plain-value deps (`pointerPlayer`, `camera`) are all
  created earlier. No `↑later`-as-value dep found.
  *Anchor:* `runtime/composition.ts` (the construction order IS the contract —
  read it top-to-bottom).
  *Check:* for a plain-value dep, confirm its producer appears *above* the
  consumer in `composition.ts`; a `↑later`-as-value is the bug.

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
transition (guard / enters-phase / engine ops / broadcasts / routing). It is
**complete for R1** (the routing IS the data it generates) but only an **index
for R3** — R3's substance is in the engine ops the graph names but doesn't
reach; follow them to the R3 anchors above (`applyLifePenalties` et al.).
