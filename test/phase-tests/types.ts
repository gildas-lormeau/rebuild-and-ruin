/**
 * Phase-test fixture format (v1).
 *
 * A fixture describes the initial state for a phase-targeted AI test. The
 * loader applies it through the real runtime (same path production uses),
 * stopping at `entryPhase`, where the test then takes over.
 *
 * V1 is the minimum viable format: seed + mode + rounds + entryPhase. Future
 * slices grow this to carry tile overrides (post-seed map deltas), mid-game
 * scoring/zone state, and modern-mode upgrades/modifiers — without breaking
 * v1 fixtures (loader rejects unknown `version` values explicitly).
 */

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
   *  V1: runtime plays through prior phases (AI-driven) to reach this entry. */
  entryPhase: Phase;
  /** Round at which `entryPhase` should be reached. V1: round 1 only. */
  round: 1;
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
