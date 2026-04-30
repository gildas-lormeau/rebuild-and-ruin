/**
 * Cannon facing animator — owns the eased "displayed" rotation for every
 * live cannon. Reads authoritative `cannon.facing` from game state each
 * frame, sets that as the target, and eases the displayed value toward
 * it so abrupt facing changes (post-fire aim shifts, post-battle reset)
 * render as a rotation rather than a snap.
 *
 * Lives in the runtime (not the renderer) so the runtime's battle-end
 * gate can poll `allSettled()` without crossing into renderer-owned
 * state. Renderers read `getDisplayed(col, row)` per cannon when
 * painting — they observe the animator, they don't own its state.
 *
 * Same pattern as the score-delta / banner / castle-build animators:
 * closure-stored, ticked unconditionally each frame from `assembly.ts`,
 * reset on rematch teardown.
 */

import { isBalloonCannon, isCannonAlive } from "../shared/core/spatial.ts";
import { isStateReady, type RuntimeState } from "./runtime-state.ts";

interface FacingState {
  displayed: number;
  target: number;
}

interface CannonAnimatorDeps {
  readonly runtimeState: RuntimeState;
}

interface CannonAnimator {
  /** Sync targets from `state.players[*].cannons[*].facing`, then ease
   *  every displayed value toward its target by `dt` seconds. No-op if
   *  game state isn't ready (lobby, between-games). New cannons snap
   *  displayed to target so first-frame appearances don't animate in
   *  from 0. Eliminated/destroyed cannons have their entries pruned. */
  tick(dt: number): void;
  /** Eased displayed facing for the cannon at (col, row), or `undefined`
   *  if the animator has no entry (cannon was just placed and `tick`
   *  hasn't run yet — the renderer should fall back to `cannon.facing`). */
  getDisplayed(col: number, row: number): number | undefined;
  /** True when every displayed facing has converged to its target. The
   *  battle-end gate in `tickBattlePhase` polls this before transitioning
   *  to battle-done — frame-synced with the visual ease. */
  allSettled(): boolean;
  /** Drop all state — for game teardown / rematch bootstrap. */
  reset(): void;
}

/** Ease rate per second. Tuned so a 180° flip settles in ~300 ms. */
const FACING_EASE_PER_SEC = 12;
/** Below this absolute delta (radians) between displayed and target the
 *  facing is considered settled. */
const FACING_REST_EPSILON = 1e-4;

export function createCannonAnimator(deps: CannonAnimatorDeps): CannonAnimator {
  const { runtimeState } = deps;
  const facings = new Map<string, FacingState>();
  const seen = new Set<string>();

  return {
    tick(dt) {
      if (!isStateReady(runtimeState)) return;
      // Sync targets from current game state. Mirrors the live-cannon
      // filter used by `buildCastleOverlay` so the animator's set of
      // tracked cannons matches what the renderer will paint.
      seen.clear();
      for (const player of runtimeState.state.players) {
        if (!player.castle) continue;
        for (const cannon of player.cannons) {
          if (!isCannonAlive(cannon)) continue;
          if (isBalloonCannon(cannon)) continue;
          const key = facingKey(cannon.col, cannon.row);
          seen.add(key);
          const target = cannon.facing ?? 0;
          const existing = facings.get(key);
          if (existing === undefined) {
            facings.set(key, { displayed: target, target });
          } else {
            existing.target = target;
          }
        }
      }
      // Prune entries for cannons that no longer exist.
      for (const key of facings.keys()) {
        if (!seen.has(key)) facings.delete(key);
      }
      // Ease toward each target via the shortest angular path.
      if (dt <= 0) return;
      const step = Math.min(1, FACING_EASE_PER_SEC * dt);
      for (const entry of facings.values()) {
        const delta = shortestAngleDelta(entry.displayed, entry.target);
        if (Math.abs(delta) < FACING_REST_EPSILON) {
          entry.displayed = entry.target;
        } else {
          entry.displayed += delta * step;
        }
      }
    },

    getDisplayed(col, row) {
      return facings.get(facingKey(col, row))?.displayed;
    },

    allSettled() {
      for (const entry of facings.values()) {
        if (entry.displayed !== entry.target) return false;
      }
      return true;
    },

    reset() {
      facings.clear();
    },
  };
}

function facingKey(col: number, row: number): string {
  return `${col}:${row}`;
}

/** Signed shortest angular delta `target - from`, wrapped to `(-π, π]`
 *  so a flip across ±π rotates the short way. */
function shortestAngleDelta(from: number, target: number): number {
  const TAU = Math.PI * 2;
  let delta = (((target - from) % TAU) + TAU) % TAU;
  if (delta > Math.PI) delta -= TAU;
  return delta;
}
