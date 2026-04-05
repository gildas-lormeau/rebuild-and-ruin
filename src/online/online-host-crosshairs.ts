/**
 * Host-side crosshair networking — broadcasts local AI crosshairs and
 * merges remote human crosshairs into the frame.
 *
 * Host uses simple linear interpolation for remote crosshairs (interpolateToward).
 * Watcher adds orbital wobble for idle AI crosshairs — see online-watcher-battle.ts
 * updateOrbitCrosshair(). Do not add orbital wobble here.
 *
 * Extracted from online-client.ts to keep that file focused on wiring.
 */

import { type GameMessage, MESSAGE } from "../../server/protocol.ts";
import {
  aimCannons,
  canPlayerFire,
  nextReadyCombined,
} from "../game/battle-system.ts";
import type { Crosshair, PixelPos } from "../shared/geometry-types.ts";
import type { DedupChannel } from "../shared/phantom-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { isPlayerAlive } from "../shared/player-types.ts";
import {
  type ControllerIdentity,
  isAiAnimatable,
} from "../shared/system-interfaces.ts";
import { isRemoteHuman } from "../shared/tick-context.ts";
import type { GameState } from "../shared/types.ts";
import { interpolateToward, REMOTE_CROSSHAIR_SPEED } from "./online-types.ts";

interface BroadcastDeps {
  lastSentAimTarget: DedupChannel;
  send: (msg: GameMessage) => void;
}

interface ExtendDeps {
  remoteCrosshairs: Map<number, PixelPos>;
  watcherCrosshairPos: Map<number, PixelPos>;
  remoteHumanSlots: ReadonlySet<number>;
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
  const orbit = isAiAnimatable(ctrl) ? ctrl.getOrbitParams() : null;
  const key = makeCrosshairDedupKey(target, orbit);
  if (!deps.lastSentAimTarget.shouldSend(ctrl.playerId, key)) return;
  deps.send({
    type: MESSAGE.AIM_UPDATE,
    playerId: ctrl.playerId,
    x: target.x,
    y: target.y,
    orbit: orbit ?? undefined,
  });
}

/** Collect interpolated remote-human crosshairs and return them merged with local ones. */
export function extendWithRemoteCrosshairs(
  crosshairs: readonly Crosshair[],
  state: GameState,
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
    if (!isRemoteHuman(pid, deps.remoteHumanSlots)) continue;
    const player = state.players[pid];
    if (!isPlayerAlive(player)) continue;
    if (!canPlayerFire(state, pid)) continue;
    const readyCannon = nextReadyCombined(state, pid);
    let visualPos = deps.watcherCrosshairPos.get(pid);
    if (!visualPos) {
      visualPos = { x: target.x, y: target.y };
      deps.watcherCrosshairPos.set(pid, visualPos);
    }
    interpolateToward(
      visualPos,
      target.x,
      target.y,
      REMOTE_CROSSHAIR_SPEED,
      dt,
    );
    remote.push({
      x: visualPos.x,
      y: visualPos.y,
      playerId: pid,
      cannonReady: !!readyCannon,
    });
    aimCannons(state, pid, visualPos.x, visualPos.y, dt);
  }
  return [...crosshairs, ...remote];
}

/**
 * Build dedup key for crosshair network sends.
 * Format: "roundedX,roundedY,orbitFlag" — field order is load-bearing for dedup.
 * Crosshairs use DedupChannel's atomic shouldSend() mechanism (no array rebuild).
 * Contrast with phantoms in online-server-events.ts which use explicit filter+push.
 */
function makeCrosshairDedupKey(
  target: { x: number; y: number },
  orbit: unknown,
): string {
  return `${Math.round(target.x)},${Math.round(target.y)},${orbit ? "o" : ""}`;
}
