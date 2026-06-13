/**
 * Remote-crosshair handling — each peer broadcasts its local human's
 * crosshair (deduped, pixel-rounded) and merges interpolated remote ones
 * into the frame. Only human crosshairs hit the wire: AI controllers tick
 * on every peer, so AI crosshairs are derived locally. Remotes lerp toward
 * the latest received position to mask dedup-cadence staleness; crosshairs
 * are the only remote-driven entity needing such smoothing.
 */

import { canPlayerFire, nextReadyCannon } from "../game/index.ts";
import { type GameMessage, MESSAGE } from "../protocol/protocol.ts";
import type { Crosshair } from "../shared/core/battle-types.ts";
import { CROSSHAIR_SPEED } from "../shared/core/game-constants.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import type { DedupChannel } from "../shared/core/phantom-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import type {
  BattleViewState,
  ControllerIdentity,
} from "../shared/core/system-interfaces.ts";
import { formatAimDedupKey } from "./online-session.ts";

interface BroadcastDeps {
  lastSentAimTarget: DedupChannel;
  send: (msg: GameMessage) => void;
}

interface ExtendDeps {
  state: BattleViewState;
  presence: {
    remoteCrosshairs: Map<ValidPlayerId, PixelPos>;
    smoothedCrosshairPos: Map<ValidPlayerId, PixelPos>;
  };
  remotePlayerSlots: ReadonlySet<ValidPlayerId>;
  logThrottled: (key: string, msg: string) => void;
}

/** Remote crosshairs lerp at this multiple of base speed to mask wire-rate
 *  staleness — local controllers update every frame, remote targets arrive
 *  at the dedup cadence. */
const REMOTE_CROSSHAIR_MULTIPLIER = 2;
const REMOTE_CROSSHAIR_SPEED = CROSSHAIR_SPEED * REMOTE_CROSSHAIR_MULTIPLIER;

/** Send aim_update for the local human's crosshair — on any peer (host or
 *  watcher alike; the caller gates by ownership), deduped. */
export function broadcastLocalCrosshair(
  ctrl: ControllerIdentity,
  ch: { x: number; y: number },
  deps: BroadcastDeps,
): void {
  const key = formatAimDedupKey(ch.x, ch.y);
  if (!deps.lastSentAimTarget.shouldSend(ctrl.playerId, key)) return;
  deps.send({
    type: MESSAGE.AIM_UPDATE,
    playerId: ctrl.playerId,
    x: ch.x,
    y: ch.y,
  });
}

/** Collect interpolated remote-human crosshairs and return them merged with local ones. */
export function extendWithRemoteCrosshairs(
  crosshairs: readonly Crosshair[],
  dt: number,
  deps: ExtendDeps,
): Crosshair[] {
  const { state, presence, remotePlayerSlots, logThrottled } = deps;
  logThrottled(
    "host-ch-remote",
    `collectCrosshairs: localCh=${crosshairs.length} remoteCrosshairs keys=[${[...presence.remoteCrosshairs.keys()]}]`,
  );
  const remote: Crosshair[] = [];
  for (const [pid, target] of presence.remoteCrosshairs) {
    if (!remotePlayerSlots.has(pid)) continue;
    const visualPos = tickRemoteCrosshair(
      pid,
      target,
      state,
      dt,
      presence.smoothedCrosshairPos,
    );
    if (!visualPos) continue;
    remote.push({
      x: visualPos.x,
      y: visualPos.y,
      playerId: pid,
      cannonReady: !!nextReadyCannon(state, pid),
    });
  }
  return [...crosshairs, ...remote];
}

/** Per-frame visual interpolation for one remote crosshair: eligibility check
 *  and lerp the cached visual position toward the target. The interpolated
 *  point is published as a crosshair entry by the caller; the cannon-animator
 *  computes the player's cannon facing from it. Mutates `visualPosCache` in
 *  place (lazy-init on first frame for a given pid). Returns null when the
 *  slot should be skipped (eliminated, can't fire). */
function tickRemoteCrosshair(
  pid: ValidPlayerId,
  target: PixelPos,
  state: BattleViewState,
  dt: number,
  visualPosCache: Map<ValidPlayerId, PixelPos>,
): PixelPos | null {
  if (isPlayerEliminated(state.players[pid])) return null;
  if (!canPlayerFire(state, pid)) return null;

  let visualPos = visualPosCache.get(pid);
  if (!visualPos) {
    visualPos = { x: target.x, y: target.y };
    visualPosCache.set(pid, visualPos);
  }
  interpolateToward(visualPos, target.x, target.y, REMOTE_CROSSHAIR_SPEED, dt);
  return visualPos;
}

/** Move `vis` toward `(tx, ty)` at `speed` pixels/s. Mutates `vis` in place. */
function interpolateToward(
  vis: PixelPos,
  tx: number,
  ty: number,
  speed: number,
  dt: number,
): void {
  const dx = tx - vis.x;
  const dy = ty - vis.y;
  const dist = Math.hypot(dx, dy);
  const move = speed * dt;
  if (dist <= move) {
    vis.x = tx;
    vis.y = ty;
  } else {
    vis.x += (dx / dist) * move;
    vis.y += (dy / dist) * move;
  }
}
