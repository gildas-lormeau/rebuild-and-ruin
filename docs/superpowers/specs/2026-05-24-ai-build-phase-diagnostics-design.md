# AI Build-Phase Diagnostics — Design Spec

**Date:** 2026-05-24
**Status:** approved, pending implementation plan
**Scope:** diagnostic instrumentation only — no behavior change to AI or game

## Problem

The AI build-survival suite (`test/ai-build-survival.test.ts`) currently surfaces ~71 stalls / 1168 rounds / 6 passes across 40 seeds. Per `project_ai_build_stall_investigation`, ~98% of stalls fall into three architectural patterns (LOCK STRAT_RECT, LOCK SEC, HYBRID). Five recent "obviously correct" fix attempts (v4-B, v4-C, Lever A, Lever C, NEAR_MISS bypass) all regressed because per-tick gates turn out to be churn-vs-commitment balances, not pure optimizations.

The investigation has identified three open diagnostic directions that the existing runner can't answer:

1. **Where do fallback walls actually land?** — when `canFillAfterPlugging` rejects all target gaps and `pickFallbackPlacement` scatters, are walls clustering predictably or dispersing randomly?
2. **Are NEAR_MISS rings solvable by the current piece bag?** — the 22 NEAR_MISS stalls (31%) may be "AI was within 5 gaps then no piece could fit" rather than "AI abandoned a closable ring"
3. **Which gates are binding per stall?** — the memory has cataloged the candidate gates (`canFillAfterPlugging`, `hasManageableGaps`, `MANAGEABLE_GAP_LIMIT` bypass, `effectiveSkipHome`) but no per-stall count tells us which one fires for each pattern

Without this data, fix attempts continue to be guesses against an opaque cost landscape.

## Goals

- Capture three new diagnostic angles in the existing survival runner: wall-placement classification, piece-shape coverage on stuck rings, gate-rejection counts + target-flip causality
- Always-on per-stall extended log lines + always-on suite-aggregate report sections
- Zero behavior change in production code paths
- Production cost ≤ ~7 branches per AI build tick when no diagnostic hook is set
- Diagnostics surface as plain text in the suite output (stderr), formatted for human eyeball-diff across runs

## Non-goals

- No fix attempts. This spec lands diagnostics only; fixes are scoped separately once the data identifies a binding constraint.
- No new sweep-behavior diagnostics (rejected during scoping — only 3 of 4 candidate angles selected).
- No external dashboard, JSON export, or analysis-script split. The runner is the single consumption surface.
- No determinism-fixture re-recording. If a diagnostic callsite breaks byte-match, that's the bug.
- No scenario test changes beyond a single smoke test in Commit 3.

## Architecture

### Hook contract

New file `src/ai/ai-build-diag.ts` — low-layer (L1–L3), type-only + slot/setter. Lives separately because all three diagnostic angles need to import it; bundling into `ai-build-target.ts` would force `ai-phase-build.ts` to import a target-selection module for diagnostic types.

```ts
// Rect bounds for diagnostic serialization. The runner derives its existing
// `rectKey` string (`${top},${left}-${bottom},${right}`) from these bounds,
// matching the format used by the path-hook trajectory rows. AI domain emits
// raw bounds; rectKey string format is a runner-internal concern.
type DiagRectBounds = { top: number; left: number; bottom: number; right: number };

export type AiBuildDiagEvent =
  | {
      kind: "target-selected";
      playerId: ValidPlayerId;
      round: number;
      path: "HOME" | "SEC" | "EXP" | "STRAT_RECT" | "STRAT_NONE";
      result: TargetResult;
      gateReasons: readonly GateReason[];
      currentPieceShapeName: string; // PieceShape.name from src/shared/core/pieces.ts
    }
  | {
      kind: "wall-placed";
      playerId: ValidPlayerId;
      round: number;
      cells: readonly TileKey[];
      targetGaps: ReadonlySet<TileKey>;
      targetRect: DiagRectBounds | null;
      pieceShapeName: string;
    }
  | {
      kind: "build-phase-end";
      playerId: ValidPlayerId;
      round: number;
      finalRect: DiagRectBounds | null;
      finalGaps: ReadonlySet<TileKey>;
      finalSubMode: "stuck" | "progressing" | "no-target";
    };

export type GateReason =
  | { gate: "canPieceFillAnyGap"; passed: boolean; site: "home" | "expand" }
  | { gate: "canFillAfterPlugging"; passed: boolean; site: "home" | "sec" | "expand"; towerIdx?: TowerIdx }
  | { gate: "manageableGapLimitBypass"; site: "sec"; gapCount: number; towerIdx: TowerIdx }
  | { gate: "effectiveSkipHome"; reason: "home-dead" | "home-enclosed" | "home-gap-overflow" }
  | { gate: "strategicFallbackInvoked"; resultPath: "STRAT_RECT" | "STRAT_NONE" };

export type AiBuildDiagHook = (event: AiBuildDiagEvent) => void;

let diagHook: AiBuildDiagHook | undefined;
export function setAiBuildDiagHook(hook: AiBuildDiagHook | undefined): void { diagHook = hook; }
export function emitDiag(event: AiBuildDiagEvent): void { diagHook?.(event); }
```

The existing `SelectTargetPathHook` / `setSelectTargetPathHook` in `ai-build-target.ts` is **deleted** — `target-selected` events subsume its function. The runner's existing handler is rewritten as a switch arm on `event.kind === "target-selected"`.

### Fire sites

Three production-code emit sites + one runner-internal synthesis. Allocation guards (`if (diagHook) { ... }`) wrap every event-object construction so production has zero allocation overhead.

**Site 1: `selectTarget` in `ai-build-target.ts`**
- One `target-selected` event per `selectTarget` call, with accumulated `GateReason[]` from the 4 sub-helpers
- Sub-helpers (`tryRepairHomeCastle`, `trySecondaryTower`, `tryExpandTerritory`, `strategicFallbackTarget`) take an optional `reasons: GateReason[]` accumulator parameter; ~12 push sites total across the four helpers
- Allocation guard at top of `selectTarget`: `const reasons = diagHook ? [] : undefined;` — no array allocation in production
- Replaces all 5 existing `setSelectTargetPathHook?.(...)` callsites

**Site 2: Wall-placement intent emission in `ai-phase-build.ts`**
- After a `PlacePieceIntent` is chosen, emit `wall-placed` with the piece's cells + active `targetGaps` + rectKey of the active target
- One emit per placement intent
- `targetGaps` and the target rect are already in scope at this site

**Site 3: `AiBrainBuild.finalize()` in `DefaultStrategy`**
- DefaultStrategy's existing `finalize(host, state)` (called by the controller at end of build phase per [`ai-brain-types.ts:49`](../../../src/ai/ai-brain-types.ts#L49)) emits `build-phase-end` with the AI's last computed target rect + remaining gaps
- No new interface surface on `AiBrainBuild` — uses an existing lifecycle method
- If the AI is eliminated mid-phase and never reaches `finalize`, no event fires; the runner's `endRect` stays null and aggregates skip the row

### Runner accumulation

`RoundRow` in `test/ai-build-survival-runner.ts` gains four new fields:

```ts
interface RoundRow {
  // existing: walls, enclosures, unownedAliveZoneTowers, livesAtRoundEnd,
  //           lostLifeThisRound, pathCounts, trajectory

  placements: PlacementRecord[];
  gateFires: GateFireCounts;
  flipEvents: FlipEvent[];
  endRect: { rectKey: string | null; gaps: ReadonlySet<TileKey> } | null; // derived in runner
}

interface PlacementRecord {
  tick: number;
  cells: readonly TileKey[];
  hitTargetGap: boolean;        // any cell in targetGaps
  cellsInGap: number;           // count of cells that hit a gap
  adjToExistingWall: boolean;   // any cell 4-adj to an existing AI wall
  isolated: boolean;            // no AI wall neighbors AND no target-gap neighbors (4-dir)
  rectKey: string | null;       // derived in runner from event.targetRect bounds
  pieceShapeName: string;
}

interface GateFireCounts {
  canPieceFillAnyGap_passed: number;
  canPieceFillAnyGap_failed: number;
  canFillAfterPlugging_passed: number;
  canFillAfterPlugging_failed: number;
  manageableGapBypass: number;
  effectiveSkipHome_dead: number;
  effectiveSkipHome_enclosed: number;
  effectiveSkipHome_gapOverflow: number;
  strategicFallback_rect: number;
  strategicFallback_none: number;
}

type FlipCause = "piece-changed" | "cache-miss" | "score-rerank" | "phase-switch" | "unknown";
interface FlipEvent { tick: number; cause: FlipCause; from: string | null; to: string | null; }
```

### Wall-placement classification

Computed in the `wall-placed` handler. The handler captures `sc.state` via closure when the runner installs the hook, so it can read the player's current walls synchronously during the AI tick:
- `hitTargetGap` / `cellsInGap`: set membership against `event.targetGaps`
- `adjToExistingWall`: 4-neighbor check against `sc.state.players[event.playerId].walls` (read at handler-call time — synchronous with the AI tick)
- `isolated`: no neighboring AI walls AND no neighboring target-gap cells — the "scattered into nowhere" classifier

**Relationship with existing `WALL_PLACED` bus event:** the bus event already fires on every wall placement and the runner already listens for it (counts `row.walls`). The diag hook is NOT a duplicate — it adds the AI-internal context (`targetGaps`, `targetRect`, `pieceShapeName`) the bus can't carry without coupling the bus to AI state. The bus stays observation-only per `feedback_bus_observation_only`.

### Flip-cause derivation

Computed in the `target-selected` handler, comparing to prev tick's row:

```
prevTick.path === "STRAT_NONE" || curTick.path === "STRAT_NONE"  → "phase-switch"
prevTick.rectKey === curTick.rectKey                              → no flip (skip)
prevTick.pieceShape !== curTick.pieceShape                        → "piece-changed"
manageableGapBypass differs between prev and cur ticks             → "cache-miss"
otherwise                                                          → "score-rerank"
```

Ordering matters — `piece-changed` dominates because it's the most common upstream trigger. The `score-rerank` fallthrough is the residual where neither piece nor cache state changed but the chosen rect did, which is the canonical Mode #2 churn pattern.

### Piece-shape coverage

Computed in the `build-phase-end` handler for stalls only (all stall sub-modes, not just NEAR_MISS):

```ts
interface PieceShapeCoverage {
  gapCount: number;                          // |endRect.gaps|
  fittingShapeNames: string[];               // shapes with ≥1 valid placement
  totalShapes: number;
  rarestFittingShapeBagFreq: number | null;  // null if no shapes fit
}
```

For each piece shape × rotation, try placing the shape anchored at each gap cell. Mark "fits" if any rotation × any anchor yields a legal placement (in-bounds, all cells on grass, no overlap) that fills at least one gap cell.

**Catalog source:** the piece registry is at [`src/shared/core/pieces.ts`](../../../src/shared/core/pieces.ts) — `PieceShape` interface (name + offsets + width/height + pivot) and the weighted bag in the same file. Build-system uses `canPlacePiece` (or similar) from [`src/game/build-system.ts`](../../../src/game/build-system.ts); reuse that helper if its signature matches our coverage check, otherwise implement a runner-local geometry check.

**Bag-frequency field:** the bag is weighted by tier (early-round vs late-round weights — see `PieceWeight` in `pieces.ts`). `rarestFittingShapeBagFreq` surfaces the rarest fitting shape's individual bag frequency at the stall's round, which is the actionable signal for "are NEAR_MISS rings only solvable by rare pieces?"

Cost: O(7 shapes × ~4 rotations × |gaps| × ~4 cells) per stall × ~70 stalls = sub-millisecond per run. Skip for non-stall rounds entirely.

### Output format

**Per-stall log line** — existing line unchanged, plus a continuation line indented underneath:

```
seed=42 r13 BLUE: 35 walls placed, ... | sub-mode LATE_PLATEAU (10t@5g)
  diag: walls 60%/25%/15% (gap/adj/iso) | flips 4 (piece=3 cache=1 rerank=0) | gates cFAP-=8 hMG-=12 sFB=3 skipHome=overflow×2 | end-rect [21,1-26,7] g=5 piece-cov 2/7 (S,T)
```

The `  diag:` prefix is grep-friendly. Fields in fixed order so suite-diff tooling can column-extract.

**Suite-aggregate report** — printed once after all seeds complete, five sections + one summary line:

1. Wall-placement distribution by sub-mode (median % gap-hits, adj-wall, isolated per stall sub-mode)
2. Piece-shape coverage distribution by sub-mode (median fitting-shape count + min/max)
3. Gate-fire histogram by sub-mode (which gates fired most per stall)
4. Flip cadence by sub-mode (median flips per stall + median cause breakdown)
5. Cross-cutting hot table — top 10 seeds by per-stall diagnostic outlier (highest isolated-wall %, lowest piece-cov %, most rerank flips)

Each row formatted fixed-width for column-comparable eyeball diff across runs.

**Final summary line** (single-line, last output):

```
DIAG SUMMARY: 71 stalls / 1168 rounds / 6 passes | wall-gap-hit median 58% | piece-cov median 3/7 | top stalls: 7082653(8) 9974133(5) ...
```

This is the headline diff target — humans / future agents compare this line to a baseline before committing or reverting a fix.

## Constraints

- **Production cost ceiling:** ~7 branches per AI build tick when `diagHook === undefined`. No allocations.
- **Determinism preservation:** `npm run test:determinism` must continue to byte-match. The hook is read-only — receives events, never mutates state.
- **Network parity preservation:** the 61 network-parity tests must pass without re-recording. The hook is test-only infrastructure.
- **Layer compliance:** `ai-build-diag.ts` must land at a layer all consumers can import from. Run `deno run -A scripts/generate-import-layers.ts` after creating it; if `--check` fails post-implementation, regenerate cells per `feedback_layer_names_are_contract`.
- **Pre-commit clean:** all 11+ pre-commit lanes pass on each commit. No new lint lanes added.

## Commit plan

Five commits, each independently green (build + scenario + determinism + network parity pass):

1. **`ai-build-diag.ts` skeleton + replace `setSelectTargetPathHook`** — `target-selected` arm only, mechanical migration. Verification: survival suite per-stall path-mix identical to prior baseline.
2. **`GateReason` plumbing through selectTarget pipeline** — accumulator param + ~12 push sites + runner aggregation + gate-fire histogram section. Verification: histogram non-trivial, `canFillAfterPlugging_failed` high on LOCK SEC stalls per memory.
3. **Wall-placement hook + classification** — `wall-placed` arm + `ai-phase-build.ts` emit + runner classification + distribution section + single scenario smoke test asserting `placements.length > 0`. Verification: every tracked stall has placements; percentages sum to 100%.
4. **`finalize` build-phase-end emit + piece-shape coverage** — `build-phase-end` arm + `DefaultStrategy.finalize` emit + runner coverage computation + coverage section. Verification: `piece-cov median` matches manual inspection of 2 NEAR_MISS rings.
5. **Flip-cause derivation + cross-cutting hot table + summary line** — pure runner-side, no production code change. Verification: flip cadence on `555555 BLUE r12-15` (known Mode #2 seed) shows non-trivial `piece-changed` count.

Each commit is mechanically narrow and produces visible diagnostic signal on its own. If a commit reveals the design is wrong (e.g. `GateReason` granularity too coarse), we stop and adjust without unwinding dependent work.

## Testing

- **Survival suite (existing):** the runner IS the consumer. A green run with non-zero `placements.length` per tracked stall demonstrates the hooks fire.
- **One new scenario smoke test (Commit 3):** 1-seed runner invocation asserting `RoundRow.placements.length > 0` for an arbitrary build round. This catches accidental hook-wiring breakage without re-recording fixtures.
- **Determinism fixtures (existing):** must byte-match. Failure indicates a hook callsite accidentally mutated state — fail-loud, not "re-record."
- **Network parity (existing):** 61 tests must pass. The hook is test-only; production never sets it.

## Open questions resolved during brainstorming

- **Hook architecture:** single discriminated-union hook (B) chosen over multiple narrow hooks (A) and per-tick accumulator (C). Reasoning: generalizes existing pattern, keeps production cost unchanged, makes future diagnostic additions cheap.
- **Build-phase-end emit site:** option (a) — emit from AI domain via existing `finalize` lifecycle method — chosen over runner-side synthesis. Reasoning: no new interface surface needed, AI knows its committed target at end of phase.
- **Run mode:** always-on per-stall + aggregates. No env-var gating.
- **Diagnostic angles:** wall-placement classification + piece-shape coverage + gate-rejection + target-flip causality. End-of-build sweep accounting excluded during scoping.
- **Piece-shape coverage scope:** all stall sub-modes, not just NEAR_MISS. Cost is trivial; surfaces unsolvable-ring signal for LATE_PLATEAU too.

## References

- `project_ai_build_stall_investigation` memory — 4 months of fix-attempt landscape
- `project_ai_outer_ring_perf_gate` memory — why per-tick gates are load-bearing
- `feedback_counter_before_theory` memory — diagnostic-first principle
- `test/ai-build-survival-runner.ts` — existing classifier + `setSelectTargetPathHook` pattern
- `src/ai/ai-build-target.ts` — `selectTarget` pipeline + existing hook callsites
- `src/ai/ai-brain-types.ts` — `AiBrainBuild.finalize` lifecycle method
