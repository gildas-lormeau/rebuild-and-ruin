import {
  aliveCannons,
  isBalloonCannon,
} from "../../shared/core/battle-types.ts";
import { isCannonEnclosed } from "../../shared/core/board-occupancy.ts";
import { Phase } from "../../shared/core/game-phase.ts";
import { cannonCenter } from "../../shared/core/spatial.ts";
import { isSessionLive, type RuntimeState } from "../state.ts";

interface FacingState {
  displayed: number;
  target: number;
}

interface CannonAnimatorDeps {
  readonly runtimeState: RuntimeState;
}

interface CannonAnimator {
  /** Recompute each cannon's target facing from game state (battle aim
   *  toward the owning/capturing player's crosshair, else rest), then ease
   *  every displayed value toward its target by `dt` seconds. No-op if
   *  game state isn't ready (lobby, between-games). New cannons snap
   *  displayed to target so first-frame appearances don't animate in
   *  from 0. Eliminated/destroyed cannons have their entries pruned. */
  tick(dt: number): void;
  /** Eased displayed facing for the cannon at (col, row), or `undefined`
   *  if the animator has no entry (cannon was just placed and `tick`
   *  hasn't run yet — the renderer should fall back to `0`). */
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

  // Recompute each tracked cannon's `target` facing from current game state,
  // creating entries (snapped to target) for newly-placed cannons and
  // pruning entries for cannons that no longer exist. Mirrors the live-
  // cannon filter used by `buildCastleOverlay` so the animator's set of
  // tracked cannons matches what the renderer will paint. Shared by
  // `tick` (then ease) and `snapToRest` (then instant converge).
  //
  // Facing is purely cosmetic and computed here — it is NOT stored on the
  // cannon or serialized. During active battle a cannon points at its
  // controlling player's crosshair (the capturer's for a balloon-captured
  // cannon, else the owner's); otherwise it rests at `player.defaultFacing`.
  function syncTargets() {
    const { state } = runtimeState;
    const weaponsActive =
      state.phase === Phase.BATTLE &&
      (state.timer > 0 || state.cannonballs.length > 0);
    const crosshairs = runtimeState.frame.crosshairs;
    const capturerOf = new Map(
      state.capturedCannons.map((captured) => [
        captured.cannon,
        captured.capturerId,
      ]),
    );
    seen.clear();
    for (const player of state.players) {
      if (player.castleWallTiles.size === 0) continue;
      for (const cannon of aliveCannons(player.cannons)) {
        if (isBalloonCannon(cannon)) continue;
        const key = facingKey(cannon.col, cannon.row);
        seen.add(key);
        let target = player.defaultFacing;
        if (weaponsActive) {
          const capturerId = capturerOf.get(cannon);
          // Only cannons that can actually fire track the crosshair. An own
          // (non-captured) cannon must be enclosed — mirroring the fire gate
          // in `canFireOwnCannon`; an un-enclosed cannon stays at rest and
          // does not rotate during battle. A captured cannon fires from the
          // victim's position with no enclosure requirement (see
          // `canFireCapturedCannon`), so it always tracks its capturer.
          const canAim =
            capturerId !== undefined || isCannonEnclosed(cannon, player);
          if (canAim) {
            const controllerId = capturerId ?? player.id;
            const crosshair = crosshairs.find(
              (c) => c.playerId === controllerId,
            );
            if (crosshair) {
              const { x, y } = cannonCenter(cannon);
              target = Math.atan2(crosshair.x - x, -(crosshair.y - y));
            }
          }
        }
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
      // Re-sync targets first: at battle-end the weapons go inactive this
      // same substep, AFTER the animator's `tick` already ran — so the
      // existing entries still hold the old aim targets. Re-syncing now
      // recomputes them to the rest pose (`player.defaultFacing`) before we
      // snap displayed to target for the banner snapshot.
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
