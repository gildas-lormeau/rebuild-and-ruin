/**
 * Host-side crosshair networking — broadcasts local AI crosshairs and
 * merges remote human crosshairs into the frame. Remote crosshairs render
 * with linear interpolation toward the received target; local AI wobble
 * comes from the controller's getCrosshair() and is not on the wire.
 */

import { type GameMessage, MESSAGE } from "../protocol/protocol.ts";
import type { Crosshair } from "../shared/core/battle-types.ts";
import { isAiAnimatable } from "../shared/core/controller-guards.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import type { DedupChannel } from "../shared/core/phantom-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { ControllerIdentity } from "../shared/core/system-interfaces.ts";
import { formatAimDedupKey } from "./online-session.ts";

interface BroadcastDeps {
  lastSentAimTarget: DedupChannel;
  send: (msg: GameMessage) => void;
}

interface ExtendDeps {
  remoteCrosshairs: Map<number, PixelPos>;
  remotePlayerSlots: ReadonlySet<ValidPlayerId>;
  logThrottled: (key: string, msg: string) => void;
  /** Visual position for the remote crosshair this frame (interpolation +
   *  can-fire gate). Null = skip rendering for this slot. Caller binds
   *  the underlying tickRemoteCrosshair + state + cache here. */
  resolveRemoteTarget: (
    pid: ValidPlayerId,
    target: PixelPos,
    dt: number,
  ) => PixelPos | null;
  /** True when the remote player has a cannon ready to fire. Caller binds
   *  nextReadyCannon + state here. */
  hasReadyCannon: (pid: ValidPlayerId) => boolean;
}

/** Send aim_update for a local controller's crosshair (host only, deduped). */
export function broadcastLocalCrosshair(
  ctrl: ControllerIdentity,
  ch: { x: number; y: number },
  deps: BroadcastDeps,
): void {
  const target =
    (isAiAnimatable(ctrl) ? ctrl.getCrosshairTarget() : null) ?? ch;
  const key = formatAimDedupKey(target.x, target.y);
  if (!deps.lastSentAimTarget.shouldSend(ctrl.playerId, key)) return;
  deps.send({
    type: MESSAGE.AIM_UPDATE,
    playerId: ctrl.playerId,
    x: target.x,
    y: target.y,
  });
}

/** Collect interpolated remote-human crosshairs and return them merged with local ones. */
export function extendWithRemoteCrosshairs(
  crosshairs: readonly Crosshair[],
  dt: number,
  deps: ExtendDeps,
): Crosshair[] {
  deps.logThrottled(
    "host-ch-remote",
    `collectCrosshairs: localCh=${crosshairs.length} remoteCrosshairs keys=[${[...deps.remoteCrosshairs.keys()]}]`,
  );
  const remote: Crosshair[] = [];
  for (const [rawPid, target] of deps.remoteCrosshairs) {
    const pid = rawPid as ValidPlayerId;
    if (!deps.remotePlayerSlots.has(pid)) continue;
    const visualPos = deps.resolveRemoteTarget(pid, target, dt);
    if (!visualPos) continue;
    remote.push({
      x: visualPos.x,
      y: visualPos.y,
      playerId: pid,
      cannonReady: deps.hasReadyCannon(pid),
    });
  }
  return [...crosshairs, ...remote];
}
