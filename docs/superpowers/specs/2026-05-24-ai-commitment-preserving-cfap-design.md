# AI Commitment-Preserving `canFillAfterPlugging` — Design Spec

**Date:** 2026-05-24
**Status:** REFUTED 2026-05-24 — implementation attempted and reverted, see
"Empirical refutation" section. Spec kept as a record of what was tried.
**Scope:** AI build-phase target-selection behavior. No game-rules change, no
new feature, no protocol change.

## Empirical refutation

Three variants of the proposed fix were implemented and measured against the
40-seed survival suite. None reduced stall counts; two regressed.

| Variant | Stall count | LOCK SEC | LOCK STRAT_RECT | Notes |
|---|---|---|---|---|
| Baseline (strict everywhere) | 68 | 20 | 13 | Pre-fix |
| V1: persistence-cache read relaxed | 74 | 21 | 16 | Trapped AI on cached target when fresh-pick had a better one |
| V2: last-resort relaxed (ring-landing check) | 68 | 20 | 13 | Relaxed gate fired 26× but always rejected — piece couldn't land on ring either |
| V3: last-resort unconditional accept | 78 | 47 | 8 | Strict-cFAP rejection isn't catastrophic — strategic fallback was already preserving commitment |

The actual signal in the diag was misread when writing this spec:

1. **The 1415 `cFAP-` count in LATE_PLATEAU is not "the gate rejects too
   aggressively."** It's "the fresh-pick loop iterates all towers per tick,
   and each tower's gate decision is one count." With ~3 towers × 13 ticks =
   ~40 calls per stall, the 9:1 reject:pass ratio actually means most ticks
   succeed at finding *some* tower the strict gate accepts.
2. **Strategic fallback was not "scatter."** It returns the home castle rect
   (or top-scored secondary) with raw gaps — effectively "stay committed
   without checking piece fit." V3's unconditional last-resort accept was a
   slight reshape of the same logic, hence the small regression rather than
   the catastrophic one V1 produced.
3. **LOCK STRAT_RECT gap-hit of 45% is not "fallback misses gaps."** It's
   "the cases where every gate rejected are precisely the cases where no
   placement hits a gap perfectly, because the piece bag is misaligned with
   the ring shape." That 45% is the ceiling for those cases, not a
   correctable behavior.

The binding constraint on build-phase stalls is therefore not
target-selection or gate strictness. It is *placement productivity given a
piece-bag/ring-shape mismatch* — the AI keeps a stable target (median
rerank-flips = 0), pieces land on the ring (gap-hit 89% in LOCK SEC), and
the ring still doesn't close because the current bag rotation can't shape
the remaining 1–5 gaps.

Plausible directions worth investigating (separate spec needed for each):

- **Interior-extending placements.** Today's gate requires placements to
  land on the ring perimeter. When the ring is dense and the piece can't fit,
  the AI scatters. Allowing piece-cells *inside* the rect (with strict
  zone/wall-adjacency) might extend the ring inward toward the tower.
- **Bag-aware target selection.** The diag already shows piece-cov 13/13 on
  every NEAR_MISS — the bag *can* solve the ring eventually. The AI doesn't
  reason about bag composition, only the next piece. A target-selection
  pass that looks at the next 2–3 pieces in the bag could pick rings the
  *bag* (not the current piece) can close.
- **Ring-shape simplification.** When a ring has 1–3 gaps and no current
  piece can fit, the AI could *intentionally place a piece interior* to
  reduce the ring to a simpler shape (smaller perimeter) the next piece
  can close. This is the opposite of today's "extend outward" strategy.

The diag instrumentation will continue to be useful for evaluating these
directions, but the fix shape in this spec is not the right lever.

---

## Original spec follows (kept for reference)

## Problem

Build-phase diagnostics (run 2026-05-24, 40 seeds × 30 rounds) classified 68
stalls into three sub-modes:

| Sub-mode | Count | Share |
|---|---|---|
| LATE_PLATEAU | 37 | 54% |
| NEAR_MISS | 22 | 32% |
| PLATEAU + others | 9 | 14% |

The dominant signal across both top sub-modes is **`canFillAfterPlugging`
rejecting at a 9:1 ratio in LATE_PLATEAU stalls** (1415 rejects / 160
passes) and 3:1 in NEAR_MISS (330 / 119). NEAR_MISS pieces are always
solvable — every one of the 22 NEAR_MISS stalls has piece-cov 13/13 (the
piece bag *can* fill the remaining ring). LATE_PLATEAU is not score-rerank
churn — only 10/37 stalls show any rerank flip; median is 0 — the AI keeps
the same target across ticks, but rejects most incoming pieces against it.

The mechanism is in [src/ai/ai-build-target.ts](src/ai/ai-build-target.ts):

- The persistence short-circuit at line 363 (`lastTargetTowerIndex`) already
  recognizes that a target should persist across ticks. It was added to fight
  Mode #2 cursor-driven churn.
- But the same path *still* runs `canFillAfterPlugging(ctx, cachedGaps,
  cachedRect)` against the new piece every tick (line 385). When the gate
  rejects, the AI falls through to fresh-pick scoring and from there often to
  `strategicFallback`. Strategic fallback walls don't preserve the committed
  ring — gap-hit drops from 89% (LOCK SEC) to 45% (LOCK STRAT_RECT).

So the AI has a stable target but no stable plan: every tick is a
binary "is this exact piece an exact fit?" decision against a target that
won't change anyway.

Five prior gate-relaxation attempts (v4-B, v4-C, Lever A, Lever C, NEAR_MISS
bypass — see [project_ai_build_stall_investigation](memory/project_ai_build_stall_investigation.md))
regressed because they relaxed the gate for *fresh* target picks too,
re-introducing Mode #1 (preempting a closeable home for an unreachable
secondary) and Mode #3 (locking on a structurally unfillable rect).

## Goals

- Eliminate the 1415-call `cFAP-` rejection cycle in LATE_PLATEAU stalls by
  giving committed targets a different question than fresh targets.
- Preserve strict rejection on *first* commit to a target (Modes #1, #3, #4
  guards stay intact).
- Reduce `strategicFallback` invocation rate on committed-target ticks
  (median 19/round in LOCK STRAT_RECT stalls today).
- Survival suite: ≥30% reduction in LATE_PLATEAU + NEAR_MISS stall counts
  with zero new stalls in any sub-mode that was at 0 in the baseline.
- Zero behavior change in scenario tests, determinism fixtures, and network
  parity tests.

## Non-goals

- LOCK STRAT_RECT scatter (sFB=19/round, gap-hit 45%) — addressed
  separately if commitment fix doesn't already collapse it.
- The 10 rerank-flip stalls (Mode #2 residual) — out of scope; that path
  needs scoring-side hysteresis, a different fix shape.
- `canPieceFillAnyGap` semantics — unchanged.
- `MANAGEABLE_GAP_LIMIT` threshold — unchanged.
- Outer-ring repair's no-gate path (line 303) — unchanged.

## Architecture

### Concept: strict vs commitment-preserving variants

`canFillAfterPlugging` has 7 callsites in `ai-build-target.ts`. They split
into two semantic categories:

| Callsite | Line | Semantic |
|---|---|---|
| `tryRepairHomeCastle` | 256 | strict (home is always "fresh" each tick — no persistence cache for home) |
| `trySecondaryTower` persistence-cache hit | 385 | **commitment-preserving** |
| `trySecondaryTower` fresh-pick from scored towers | 442 | strict |
| `trySecondaryTower` map-edge plug synthesis | 492 | strict |
| `tryExpandTerritory` | 681 | strict |

Only line 385 changes. The other six keep strict semantics.

### The commitment-preserving check

Today, `canFillAfterPlugging(ctx, gaps, rect)` answers:
> "Can the current piece, in some orientation, fill at least one gap of
> `gaps`, possibly after plugging unreachable diagonals?"

For a *committed* target (we've already chosen this rect on a prior tick
and the AI is now persisting), the right question is:
> "Will placing this piece anywhere on `rect`'s wall ring make the
> remaining ring *less closeable* by the piece bag?"

The dominant cause of false rejection is that the current piece doesn't
exactly fill a gap, so the gate rejects. But placing that piece on any
wall-adjacent cell of the ring extends the structure and leaves the same
13/13 piece-cov for future ticks.

The relaxed check accepts the persistence-path target iff:
1. The committed rect still has ≥1 placement cell that is wall-adjacent or
   gap-adjacent on the rect's wall ring, AND
2. Placing the piece there doesn't isolate a gap (no gap becomes structurally
   unfillable per `isGapFillableByAnyShape`).

Condition (1) is computed from `player.walls` ∩ `rect`-ring + the piece's
candidate placements. Condition (2) is the existing
`plugUnreachableGaps` machinery, but evaluated *post-hypothetical-placement*
rather than against the current ring state.

This is materially weaker than today's gate (no requirement that the current
piece exactly fits a gap) but stronger than `manageableGapLimitBypass`
(which accepts unconditionally — and is the Mode #8 amplifier per existing
comments at lines 451–453).

### Cache invariants stay strict

The persistence cache write at lines 467–468 must still gate on strict
`canFillAfterPlugging`. The relaxation applies only to *reading* a cached
target — once we're committed, stay committed. Writing the cache
(initial commitment) remains strict to prevent caching unsealable rings
(the Mode #3/#4 guard).

This is the asymmetry that makes the fix safe: strict-write + relaxed-read.

### Diag instrumentation

`GateReason` gets a new variant for tracking the relaxed-path decision so
post-fix diag runs can confirm:

```ts
| { gate: "canFillAfterPluggingRelaxed"; passed: boolean; towerIdx: TowerIdx }
```

Aggregated counts of `cFAP-` (strict reject) should drop in LATE_PLATEAU
stalls; counts of `cFAPR+` (relaxed pass) should account for the
difference. If we see `cFAPR-` (relaxed reject) firing heavily, that's
the signal that the relaxation isn't strong enough — surface for tuning.

### Files touched

| File | Change |
|---|---|
| `src/ai/ai-build-target.ts` | Add `canFillAfterPluggingCommitted` helper; route line 385 callsite to it |
| `src/ai/ai-build-diag.ts` | Add `cFAPR` variant to `GateReason` union |
| `test/ai-build-survival-runner.ts` | Recognize `cFAPR` in gate-summary aggregation |

No other files. No new exports beyond the diag variant.

## Verification plan

### Pre-fix baseline (captured 2026-05-24)

- 30 / 40 seeds fail with 71 stalls total
- 68 stall+diag pairs parsed; sub-mode shares above
- LATE_PLATEAU `cFAP-` total: 1415
- LOCK STRAT_RECT `sFB` median: 19/round, gap-hit median: 45%

### Post-fix acceptance

1. `npm run test:scenario` + `npm run test:determinism` green (no behavior
   change outside the targeted path).
2. Network parity gate (`test/network-vs-local.test.ts`) green.
3. Survival suite re-run:
   - Total stall count drops by ≥30% (target: ≤50 stalls, down from 71)
   - LATE_PLATEAU `cFAP-` drops by ≥50%
   - No sub-mode that was 0 in baseline appears post-fix
   - LOCK STRAT_RECT `sFB` median drops (gate stops bailing to fallback so
     often when committed)
4. The two known-failing phase tests (cluster-merging GOLD r1 seed 574812,
   post-demolition outer-ring repair) — at minimum, status doesn't worsen;
   ideal, one or both flip green.

### Regression guardrails

Five prior fixes regressed by relaxing the wrong path. The strict-write +
relaxed-read asymmetry above is the load-bearing invariant. The CI smoke is:

- A scenario test that drives the AI through a Mode #1 setup (closeable home
  + tempting secondary) and asserts the AI doesn't preempt home. This test
  exists implicitly in the survival suite but should be lifted into
  `test/ai-build-survival.test.ts` as an explicit named seed if not already.

## Risks

- **The fix collapses LATE_PLATEAU but uncovers a different stall mode.**
  Likely: LOCK STRAT_RECT stops being the fallback dumping ground, so its
  count drops, but seeds where the relaxed check still can't make progress
  surface as MID_PLATEAU. Acceptable per the goal "no new stall mode at >0"
  — MID_PLATEAU was at 1 already.
- **Relaxed check accepts a placement that isolates a gap one tick later
  when a different piece arrives.** Mitigated by condition (2) above
  (`isGapFillableByAnyShape` against post-placement state).
- **The persistence cache itself is too sticky.** If a committed target
  becomes objectively unsolvable mid-phase (e.g. a grunt kills a tower
  inside the rect), the strict cache-invalidation at line 467 still fires.
  No change there.

## Resolved design decisions

1. **Home-tower relaxation is out of scope.** Home doesn't persist across
   ticks today (every tick recomputes from scratch), so applying the same
   relaxation requires also adding home persistence — a separate fix shape
   with its own invalidation logic (castle-rect drift, modifier projection).
   Bundling both fixes makes survival-suite deltas ambiguous. Ship
   secondary-tower commitment first; if the 12 home-involved stalls
   (9 LATE_PLATEAU + 3 NEAR_MISS + 1 MID_PLATEAU on HYBRID/HOME) survive,
   schedule a follow-up.
2. **Relaxed-reject evicts the persistence cache.** When the relaxed gate
   rejects on a previously-committed target, the cache entry is cleared so
   the next tick falls through to fresh-pick scoring. This preserves the
   "no new sub-mode at >0" acceptance criterion — without eviction, we'd
   trade LATE_PLATEAU for a new "committed-but-unmovable" stall mode.
3. **Condition (1) uses wall-adjacent OR gap-adjacent.** The looser variant
   is the actual relaxation. Gap-adjacent-only retains the bulk of the 9:1
   rejection ratio — current pieces frequently can't fit a gap directly but
   *can* extend the ring toward one. Condition (2) (`isGapFillableByAnyShape`
   post-placement) is the safety rail that prevents the looser rule from
   accepting placements that strand gaps.
