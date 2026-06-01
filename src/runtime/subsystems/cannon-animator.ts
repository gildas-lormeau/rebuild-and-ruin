import {
  isBalloonCannon,
  isCannonAlive,
} from "../../shared/core/battle-types.ts";
import { isSessionLive, type RuntimeState } from "../state.ts";

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
  /** Snap every displayed facing instantly to its (freshly re-synced)
   *  target. Called at battle-end so the build banner's prev-scene
   *  snapshot captures cannons at their rest facing without the battle-
   *  done transition having to wait on the cosmetic ease. */
  snapToRest(): void;
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

  // Sync each tracked cannon's `target` from current game-state facing,
  // creating entries (snapped to target) for newly-placed cannons and
  // pruning entries for cannons that no longer exist. Mirrors the live-
  // cannon filter used by `buildCastleOverlay` so the animator's set of
  // tracked cannons matches what the renderer will paint. Shared by
  // `tick` (then ease) and `snapToRest` (then instant converge).
  function syncTargets() {
    seen.clear();
    for (const player of runtimeState.state.players) {
      if (player.castleWallTiles.size === 0) continue;
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
    for (const key of facings.keys()) {
      if (!seen.has(key)) facings.delete(key);
    }
  }

  return {
    tick(dt) {
      if (!isSessionLive(runtimeState)) return;
      syncTargets();
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

    snapToRest() {
      if (!isSessionLive(runtimeState)) return;
      // Re-sync targets first: `resetCannonFacings` rewrote `cannon.facing`
      // to the rest pose in this same substep, AFTER the animator's `tick`
      // already ran — so the existing entries still hold the old aim
      // targets. Pull the fresh rest targets before snapping.
      syncTargets();
      for (const entry of facings.values()) {
        entry.displayed = entry.target;
      }
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
