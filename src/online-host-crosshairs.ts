/**
 * Host-side crosshair networking — broadcasts local AI crosshairs and
 * merges remote human crosshairs into the frame.
 *
 * Extracted from online-client.ts to keep that file focused on wiring.
 */

import type { GameMessage } from "../server/protocol.ts";
import { MSG } from "../server/protocol.ts";
import {
  aimCannons,
  canPlayerFire,
  nextReadyCombined,
} from "./battle-system.ts";
import { isAiAnimatable } from "./controller-factory.ts";
import type { Crosshair, PlayerController } from "./controller-interfaces.ts";
import { CROSSHAIR_SPEED } from "./controller-interfaces.ts";
import type { PixelPos } from "./geometry-types.ts";
import { interpolateToward } from "./online-types.ts";
import type { GameState } from "./types.ts";

interface BroadcastDeps {
  lastSentAimTarget: Map<number, string>;
  send: (msg: GameMessage) => void;
}

interface ExtendDeps {
  remoteCrosshairs: Map<number, PixelPos>;
  crosshairPos: Map<number, PixelPos>;
  remoteHumanSlots: ReadonlySet<number>;
  logThrottled: (key: string, msg: string) => void;
}

/** Multiplier for remote crosshair interpolation speed (same as watcher). */
const REMOTE_CROSSHAIR_MULT = 2;

/** Send aim_update for a local controller's crosshair (host only, deduped). */
export function broadcastLocalCrosshair(
  ctrl: PlayerController,
  ch: { x: number; y: number },
  deps: BroadcastDeps,
): void {
  const target = (isAiAnimatable(ctrl) ? ctrl.getCrosshairTarget() : null) ?? ch;
  if (!target) return;
  const orbit = isAiAnimatable(ctrl) ? ctrl.getOrbitParams() : null;
  const key = `${Math.round(target.x)},${Math.round(target.y)},${orbit ? "o" : ""}`;
  if (deps.lastSentAimTarget.get(ctrl.playerId) === key) return;
  deps.lastSentAimTarget.set(ctrl.playerId, key);
  deps.send({
    type: MSG.AIM_UPDATE,
    playerId: ctrl.playerId,
    x: target.x,
    y: target.y,
    orbit: orbit ?? undefined,
  });
}

/** Append interpolated remote-human crosshairs to the local crosshair list. */
export function extendWithRemoteCrosshairs(
  crosshairs: Crosshair[],
  state: GameState,
  dt: number,
  deps: ExtendDeps,
): Crosshair[] {
  deps.logThrottled(
    "host-ch-remote",
    `collectCrosshairs: localCh=${crosshairs.length} remoteCrosshairs keys=[${[...deps.remoteCrosshairs.keys()]}] cannons=[${state.players.map((p, i) => `P${i}:${p.cannons.length}`).join(",")}]`,
  );
  for (const [pid, target] of deps.remoteCrosshairs) {
    if (!deps.remoteHumanSlots.has(pid)) continue;
    const player = state.players[pid];
    if (!player || player.eliminated) continue;
    if (!canPlayerFire(state, pid)) continue;
    const readyCannon = nextReadyCombined(state, pid);
    let vis = deps.crosshairPos.get(pid);
    if (!vis) {
      vis = { x: target.x, y: target.y };
      deps.crosshairPos.set(pid, vis);
    }
    interpolateToward(vis, target.x, target.y, CROSSHAIR_SPEED * REMOTE_CROSSHAIR_MULT, dt);
    crosshairs.push({
      x: vis.x,
      y: vis.y,
      playerId: pid,
      cannonReady: !!readyCannon,
    });
    aimCannons(state, pid, vis.x, vis.y, dt);
  }
  return crosshairs;
}
