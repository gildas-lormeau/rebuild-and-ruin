# AI Build-Phase Diag — Round-2 Extensions

**Date:** 2026-05-24
**Status:** draft, pending implementation
**Scope:** Extensions to the build-phase diagnostic hook landed by the
five-commit series (efd38df7..1a3fdb4c). No production behavior change,
no game-rules change, no fix. Diagnostics only.

## Problem

The round-1 diag (gate reasons, wall-placed events, build-phase-end,
flip-cause derivation, per-seed summary) successfully captured *what
decisions the AI made* per tick. But the four refuted gate-relaxation
fixes (v4-C, Lever A, NEAR_MISS bypass, commitment-preserving cFAP — see
[[project-ai-build-stall-investigation]]) all proceeded from a misread of
the existing aggregates. Two specific misreads recur:

1. **`cFAP-=1415` was interpreted as "the gate rejects too aggressively."**
   It is actually the sum of all callsite invocations across the
   `trySecondaryTower` fresh-pick loop (~3 towers × ~13 ticks × multiple
   call sites per stall). Most ticks succeed at finding *some* tower —
   the high count is iteration cost, not rejection bias.
2. **`STRAT_RECT 90%` was interpreted as "the AI is on the fallback path."**
   It is the *most-recently-chosen* path. The strategic-fallback target
   bucket lumps together "fallback chose home" and "fallback chose
   top-secondary" — different fix shapes need different attribution.

Beyond preventing future misreads, the three plausible new fix directions
identified by the commitment-preserving cFAP refutation
([[project-ai-build-stall-investigation]]) need data the diag doesn't
currently capture:

3. **Bag-aware target selection** needs per-tick "can the next N pieces in
   the bag fill the current target?" data. Today's piece-cov 13/13
   only measures the END-OF-BUILD piece set, not the per-tick window.
4. **Interior-extending placements** and **ring-shape simplification** need
   to distinguish placements landing on the rect's wall-ring perimeter
   from placements landing off it. Today's gap/adj/iso classification
   conflates "wall-adjacent on the ring" with "wall-adjacent in the
   interior or far from the ring."

## Goals

- Capture four new aggregates in the existing survival runner output:
  per-tick gate-decision flag, strategic-fallback tower attribution,
  next-N-pieces × target fillability, and on-ring vs. off-ring placement
  split.
- Zero behavior change in production AI code.
- Production cost ≤ ~3 additional branches per AI build tick when no
  diagnostic hook is set (the existing `isAiBuildDiagHookActive` guard
  pattern stays load-bearing).
- All four signals surface in the existing per-stall continuation log line
  + per-seed `DIAG` summary line. No new output file, no JSON export.

## Non-goals

- No fix attempts. This spec lands diagnostics only.
- No new sub-mode classification rules. The existing PLATEAU /
  LATE_PLATEAU / NEAR_MISS / SWITCH / PROGRESS / OTHER taxonomy stays.
- No piece-bag prediction beyond reading the AI's already-determined bag
  order. The bag is RNG-deterministic per round; the runner can peek
  without divergence risk.
- No cross-seed aggregate hot table (deferred from round 1 for the same
  reason — worker-pool architecture).
- No new diag event KIND. The four extensions piggyback on the existing
  three (`target-selected`, `wall-placed`, `build-phase-end`).

## Architecture

### Extension 1 — Per-tick gate-decision flag

**Problem this fixes:** today `cFAP-=1415` counts every callsite firing.
The signal that actually matters is "how many ticks had *zero* gate
passes" — those are the ticks that bail to strategic fallback.

**Surface change:** `target-selected` event gains one field:

```ts
{
  // existing fields ...
  anyGatePassed: boolean;
}
```

Set in `selectTarget` after the four phase calls: `true` if any
`GateReason` with a `passed` discriminator was `passed: true`, OR if
`tryRepairOuterRing` returned a target (no GateReason emitted but a
target is real). `false` if the only `GateReason` with a verdict was
`{ gate: "strategicFallbackInvoked" }` (whose `resultPath` covers both
sub-cases).

**Runner aggregation:** new `RoundRow` counter `ticksWithNoGatePass:
number`. Per-stall continuation line gains `no-gate-ticks=N/T` (N ticks
with no gate pass, out of T total ticks). Per-seed DIAG line gains the
median across stalls.

**Why this resolves the misread:** if the median is 0 or 1 per stall,
the gate isn't the binding constraint (most ticks find a target). If the
median is 5-10 per stall, the gate IS over-rejecting in a per-tick sense.
Today neither signal is visible.

### Extension 2 — Strategic-fallback tower attribution

**Problem this fixes:** `strategicFallbackInvoked` records only
`STRAT_RECT` / `STRAT_NONE`, not which tower the fallback picked.
LOCK STRAT_RECT vs LOCK SEC may be the *same target* through different
code paths.

**Surface change:** the `strategicFallbackInvoked` GateReason variant
gains a `chosenTowerIdx` field:

```ts
| {
    gate: "strategicFallbackInvoked";
    resultPath: "STRAT_RECT" | "STRAT_NONE";
    chosenTowerIdx: TowerIdx | "home" | null;
  }
```

`"home"` when the fallback returned `castle` (home tower); `TowerIdx`
when it returned a secondary; `null` when `resultPath === "STRAT_NONE"`.
Filled in by `strategicFallbackTarget` at the existing return sites
(lines 151 and 187 of `ai-build-target.ts`).

**Runner aggregation:** new `RoundRow` field
`fallbackTowerHits: Map<TowerIdx | "home" | "none", number>`. Per-stall
continuation line gains `fb=home:X,sec5:Y,sec6:Z` when fallback fires.
Helps confirm or refute "the AI is committing to a different tower than
the cached one" hypotheses.

**Why this is cheap:** the data is already in scope at the return
sites; only the GateReason union widens.

### Extension 3 — Next-N-pieces × target fillability

**Problem this fixes:** `piece-cov 13/13` proves "all piece shapes can
fill the remaining gaps eventually." It doesn't say "the NEXT pieces in
the bag, in order, can fill the current target." That's the NEAR_MISS
mechanism we couldn't observe.

**Surface change:** `target-selected` event gains:

```ts
{
  // existing fields ...
  /** Next N pieces in the AI's bag (excluding current piece). N is
   *  configurable runner-side; default 3 covers ~2-3 ticks of lookahead.
   *  Empty when bag-peek isn't available (test-only API). */
  upcomingPieces: readonly string[];  // PieceShape.name values
  /** For each upcomingPieces entry, true if at least one orientation
   *  could fill at least one of the current `targetGaps` set. Pre-
   *  computed in the diag emit site to keep the hook async-free. */
  upcomingPieceFitsTarget: readonly boolean[];
}
```

Computed in `selectTarget` after the target is chosen, only when
`isAiBuildDiagHookActive()` returns true. Uses the existing
`canAnyRotationFillGap` helper against each upcoming piece (one-off
allocation per upcoming piece, no caching).

**Runner aggregation:** new `RoundRow` field `upcomingFitFraction: number`
— average across all per-tick `upcomingPieceFitsTarget` arrays of the
ratio (fits / total). Per-stall continuation line gains `bag-fit=42%`
(stall-level average). DIAG line gains median across stalls.

**Why this answers the bag-vs-ring question:** if NEAR_MISS stalls show
`bag-fit < 30%` consistently while non-NEAR_MISS stalls show > 60%, the
bag-mismatch hypothesis is supported and a bag-aware fix is the right
direction. If both are ~50%, bag composition isn't the binding constraint
and we look elsewhere.

**Open implementation question (decision below):** the AI's bag peek
requires access to the future-piece queue. This data lives in
`state.players[playerId].pieceBag` (or equivalent — verify during
implementation). Pure read access, no mutation, deterministic.

**Resolved:** read directly from `state.players[playerId]` in the
selectTarget callsite. No new API surface on the AI side. If the field
isn't called `pieceBag` after implementation grep, this section gets
updated; the semantic is "the N pieces the AI will receive next."

### Extension 4 — On-ring vs. off-ring placement split

**Problem this fixes:** today's gap-hit/adj/iso classification doesn't
say where the placement sat relative to the target rect's wall-ring
perimeter. The interior-extending and ring-shape-simplification fix
directions both need this split.

**Surface change:** `wall-placed` event gains:

```ts
{
  // existing fields ...
  /** Count of placement cells that lie on the target rect's wall-ring
   *  perimeter (top-1, bottom+1, left-1, right+1). 0 when targetRect
   *  is null. */
  cellsOnRingPerimeter: number;
}
```

Computed in `emitWallPlacedDiag` (or its callsite) from the placement
cells + `targetRect` bounds. Cheap — at most 4 cells per piece, one
comparison each.

**Runner aggregation:** `PlacementRecord` gains
`onRingPerimeter: boolean` (true if any cell on perimeter). Per-stall
continuation line existing `walls X%/Y%/Z%` split becomes
`walls X%/Y%/Z% (gap/adj/iso) | on-ring=N%` — keeps backward compat
for diff comparisons.

**Why this answers the interior-extending question:** if LATE_PLATEAU
stalls show high `on-ring=` (e.g. >70%) but rings still don't close,
extending placements inward is unlikely to help (the AI is already on
the ring). If `on-ring=` is low (<30%), interior-extending may not be
the right framing — the placements aren't on the ring at all, so it's
scoring or fallback scatter, not "placement landed wrong."

### Files touched

| File | Change |
|---|---|
| `src/ai/ai-build-diag.ts` | Widen `strategicFallbackInvoked` variant; add `anyGatePassed`, `upcomingPieces`, `upcomingPieceFitsTarget` to `target-selected`; add `cellsOnRingPerimeter` to `wall-placed`. Update emit-helpers' parameter lists. |
| `src/ai/ai-build-target.ts` | Emit `chosenTowerIdx` in `strategicFallbackTarget`'s reasons push; compute `anyGatePassed` + upcoming-pieces lookups in `selectTarget`'s diag emit. |
| `src/ai/ai-phase-build.ts` (or wherever `emitWallPlacedDiag` is called) | Compute and pass `cellsOnRingPerimeter` in the emit. |
| `test/ai-build-survival-runner.ts` | Add `ticksWithNoGatePass`, `fallbackTowerHits`, `upcomingFitFraction` to `RoundRow`; extend `accumulateGateReason`; extend per-stall continuation line + per-seed `DIAG` line. |

No new file. No new exports beyond the widened type unions.

## Verification plan

### Pre-implementation baseline (already captured)

The post-fix-attempt 2026-05-24 run (71 stalls, 40 seeds) is the baseline
for the new metrics. Once the extensions land, a fresh run produces the
first measurement of `no-gate-ticks`, `bag-fit`, `on-ring=`, and
`fb=...` per stall.

### Acceptance

1. `npm run test:scenario` + `npm run test:determinism` green (no behavior
   change outside the diag emit sites).
2. Network parity gate (`test/network-vs-local.test.ts`) green.
3. Survival suite stall count delta of zero (this is diagnostics only —
   a behavioral delta would indicate a production-path bug in the new
   emit code).
4. Per-stall continuation log line successfully renders the four new
   signals; per-seed `DIAG` line renders the medians.

### What the new signals should reveal (testable claims)

- **`no-gate-ticks` median**: should be ≤ 2 across baseline stalls. If
  it's higher than expected, the "gate is fine, fallback was already
  acting as commitment" interpretation from the refuted spec needs
  revisiting.
- **`fb=` distribution**: should show fallback choosing `home` for the
  majority of LOCK STRAT_RECT stalls (confirming the "fallback returns
  the home rect with raw gaps" assertion in the refuted spec). If
  fallback often chooses a secondary, the analysis is more nuanced.
- **`bag-fit`**: NEAR_MISS stalls should show distinctly lower bag-fit
  than non-NEAR_MISS stalls. If they don't, the bag-mismatch hypothesis
  is weakened and the next fix shape moves to (iii) ring-shape
  simplification instead of (ii) bag-aware selection.
- **`on-ring=`**: LATE_PLATEAU stalls should show high on-ring (>60%).
  If on-ring is low, the placement scorer is failing to reward ring
  placements correctly — different fix layer.

Each of these is a testable claim that the round-2 diag will either
confirm or refute, narrowing the search for the real binding constraint.

## Risks

- **Bag-peek API drift.** Extension 3 assumes the AI's piece bag is
  readable from `state.players[playerId]`. If the bag lives elsewhere or
  has a non-trivial access pattern, this extension grows to two files.
  Implementation should verify with grep before assuming the shape.
- **Production cost creep.** The new `upcomingPieceFitsTarget` allocation
  + 3 × `canAnyRotationFillGap` calls per tick costs more than the
  round-1 budget. Mitigated by gating behind `isAiBuildDiagHookActive()`,
  but worth a benchmark check that the no-hook path stays at the
  documented ~7-branch overhead.
- **Determinism risk on upcoming-pieces peek.** If the bag-peek mutates
  state or advances the RNG, the determinism fixtures break. The
  implementation MUST use a read-only access pattern. If the bag isn't
  cleanly read-only, the extension is downgraded to "log bag position
  index only" with the fit computation done post-hoc in the runner.

## Resolved design decisions

1. **`upcomingPieces` default N = 3.** Covers the typical 2-3 ticks
   between piece arrivals in a build phase. Runner-side override via env
   var (`AI_DIAG_LOOKAHEAD`) deferred — wire when needed.
2. **`cellsOnRingPerimeter` counts perimeter cells, not boolean.**
   Cheaper than computing "majority on ring" downstream; runner threshold
   (e.g. ≥1 cell on ring) is a presentation choice, not a data choice.
3. **`anyGatePassed` is a derived flag on `target-selected`, not a new
   event KIND.** Avoids fan-out in the event union.
4. **Strategic-fallback tower attribution rides on the existing
   `GateReason` variant.** No new GateReason kind — the variant already
   has the natural slot.

## Open implementation notes (resolve during coding, not in spec)

- Grep for the AI's piece bag field name. Likely `pieceBag` on the
  player state, but verify. If the bag is on the AI strategy (not in
  game state), the access path threads through `ctx`.
- The lint:registries check on `BATTLE_EVENT_CONSUMERS` etc. doesn't
  apply here (no new registry entries). The lint:checkpoint-fields
  check applies if any of the new fields are accidentally serialized —
  they shouldn't be (diag events are test-only).
- Confirm `target-selected` event size after the additions is still
  manageable; if not, consider lazy-evaluation of `upcomingPieceFitsTarget`
  via a runner-side recomputation from `upcomingPieces` + the live
  state at receive time.
