/**
 * Phase-test fixture format (v1).
 *
 * A fixture describes the initial state for a phase-targeted AI test. The
 * loader applies it through the real runtime (same path production uses),
 * stopping at `entryPhase`, where the test then takes over.
 *
 * Two entry paths:
 *   - Round 1: the loader boots a fresh runtime and AI-drives it to
 *     `entryPhase`. No serialized state required.
 *   - Round ≥ 2: the fixture carries a `checkpoint` (a captured
 *     `FullStateMessage`). The loader boots a fresh runtime, then applies
 *     the snapshot via `applyMidGameCheckpoint` so the runtime can continue
 *     ticking from that moment.
 */

import type { FullStateMessage } from "../../src/protocol/protocol.ts";
import type { Phase } from "../../src/shared/core/game-phase.ts";

export type FixtureMode = "classic" | "modern";

export interface FixtureFile {
  /** Format version. Always 1 in v1; loader rejects unknown values. */
  version: 1;
  /** Map seed — feeds the terrain generator and the AI/RNG streams. */
  seed: number;
  /** Game mode. */
  mode: FixtureMode;
  /** Match length in rounds. */
  rounds: number;
  /** Phase the loader stops at before handing the scenario to the test.
   *  Without `checkpoint`: runtime plays through prior phases (AI-driven)
   *  to reach this entry. With `checkpoint`: the captured snapshot decides
   *  the phase; this field must match `checkpoint.phase`. */
  entryPhase: Phase;
  /** Round at which `entryPhase` should be reached. 1 when authored as a
   *  fresh boot; >1 requires a `checkpoint` (no support for AI-replaying
   *  multiple rounds before hand-off — too slow to be useful in tests). */
  round: number;
  /** Captured mid-game state. When present, the loader applies it via
   *  `applyMidGameCheckpoint` instead of AI-driving from round 1. Required
   *  for `round > 1`. The checkpoint's `round` / `phase` must match the
   *  fixture's `round` / `entryPhase`. */
  checkpoint?: FullStateMessage;
  /** House additions applied on top of the seed-generated map, after the
   *  runtime has played through to `entryPhase`. Each entry is validated
   *  for in-bounds row/col, grass tile, no tower overlap, and no duplicate
   *  position. Future slices add `walls`. */
  houses?: HouseOverride[];
  /** Bonus-square additions, applied after `houses`. Same validation
   *  rules. */
  bonusSquares?: BonusSquareOverride[];
  /** Wall additions, applied after bonus squares. Each wall is owned by a
   *  specific player slot. Isolated walls are allowed — the game produces
   *  them often during normal play. The loader does NOT recompute
   *  derived state (interior, ownedTowers, …); the editor/agent is
   *  responsible for either running `recomputeFixtureDerivedState` or
   *  using `scripts/fixture-check.ts` to validate. */
  walls?: WallOverride[];
  /** Grunt additions, applied after walls. `targetTowerIdx` is locked on
   *  the next `moveGrunts` pass (build phase only); fixtures don't author
   *  it. Position must be on grass, in bounds, and off any wall / tower /
   *  existing grunt. */
  grunts?: GruntOverride[];
  /** Free-form, ignored at runtime. Surfaced in the editor for context. */
  notes?: string;
}

export interface HouseOverride {
  row: number;
  col: number;
}

export interface BonusSquareOverride {
  row: number;
  col: number;
}

export interface WallOverride {
  row: number;
  col: number;
  /** Player slot index (0..state.players.length-1) that owns the wall. */
  ownerId: number;
}

export interface GruntOverride {
  row: number;
  col: number;
  /** Optional — overrides the victim derived from zone ownership at
   *  (row, col). Useful when authoring a cross-zone grunt (e.g. one that
   *  spawned in zone A but is hunting a tower in zone B because A's
   *  player is eliminated). Defaults to the zone owner. */
  victimPlayerId?: number;
}
