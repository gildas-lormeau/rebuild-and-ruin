/**
 * Host-side crosshair networking — broadcasts local AI crosshairs and
 * merges remote human crosshairs into the frame.
 *
 * Both host and watcher render remote crosshairs with simple linear
 * interpolation toward the received target. Local AI crosshairs wobble
 * natively via the controller's getCrosshair(); the wire format does not
 * carry orbit params.
 *
 * Extracted from online-client.ts to keep that file focused on wiring.
 */

import { nextReadyCombined } from "../game/index.ts";
import { type GameMessage, MESSAGE } from "../protocol/protocol.ts";
import { tickRemoteCrosshair } from "../runtime/runtime-crosshair-anim.ts";
import { isRemotePlayer } from "../runtime/runtime-tick-context.ts";
import type { Crosshair } from "../shared/core/battle-types.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import type { DedupChannel } from "../shared/core/phantom-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  type BattleViewState,
  type ControllerIdentity,
  isAiAnimatable,
} from "../shared/core/system-interfaces.ts";
import { formatAimDedupKey } from "./online-session.ts";

interface BroadcastDeps {
  lastSentAimTarget: DedupChannel;
  send: (msg: GameMessage) => void;
}

interface ExtendDeps {
  remoteCrosshairs: Map<number, PixelPos>;
  smoothedCrosshairPos: Map<number, PixelPos>;
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>;
  logThrottled: (key: string, msg: string) => void;
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
  state: BattleViewState,
  dt: number,
  deps: ExtendDeps,
): Crosshair[] {
  deps.logThrottled(
    "host-ch-remote",
    `collectCrosshairs: localCh=${crosshairs.length} remoteCrosshairs keys=[${[...deps.remoteCrosshairs.keys()]}] cannons=[${state.players.map((player, i) => `P${i}:${player.cannons.length}`).join(",")}]`,
  );
  const remote: Crosshair[] = [];
  for (const [rawPid, target] of deps.remoteCrosshairs) {
    const pid = rawPid as ValidPlayerSlot;
    if (!isRemotePlayer(pid, deps.remotePlayerSlots)) continue;
    const visualPos = tickRemoteCrosshair(
      pid,
      target,
      state,
      dt,
      deps.smoothedCrosshairPos,
    );
    if (!visualPos) continue;
    remote.push({
      x: visualPos.x,
      y: visualPos.y,
      playerId: pid,
      cannonReady: !!nextReadyCombined(state, pid),
    });
  }
  return [...crosshairs, ...remote];
}
