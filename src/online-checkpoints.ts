import { MESSAGE, type ServerMessage } from "../server/protocol.ts";
import { snapshotAllWalls } from "./board-occupancy.ts";
import { resetCannonFacings } from "./cannon-system.ts";
import type { OrbitParams } from "./controller-interfaces.ts";
import type { PixelPos } from "./geometry-types.ts";
import {
  applyGruntsCheckpoint,
  applyHousesCheckpoint,
  applyPlayersCheckpoint,
} from "./online-serialize.ts";
import { towerCenterPx } from "./spatial.ts";
import { BATTLE_TIMER, type GameState } from "./types.ts";

export interface CheckpointBattleAnim {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: readonly {
    flight: { startX: number; startY: number; endX: number; endY: number };
    progress: number;
  }[];
  impacts: { row: number; col: number; age: number }[];
}

export interface CheckpointAccums {
  battle: number;
  cannon: number;
  select: number;
  build: number;
  grunt: number;
}

export interface CheckpointDeps {
  state: GameState;
  battleAnim: CheckpointBattleAnim;
  accum: CheckpointAccums;
  remoteCrosshairs: Map<number, PixelPos>;
  watcherCrosshairPos: Map<number, PixelPos>;
  watcherOrbitParams: Map<number, OrbitParams>;
  watcherIdlePhases: Map<number, number>;
  snapshotTerritory: () => Set<number>[];
}

export function applyCannonStartCheckpoint(
  msg: ServerMessage,
  deps: CheckpointDeps,
): void {
  if (msg.type !== MESSAGE.CANNON_START) return;
  applyPlayersCheckpoint(deps.state, msg.players);
  applyGruntsCheckpoint(deps.state, msg.grunts);
  applyHousesCheckpoint(deps.state, msg.houses);
  deps.state.bonusSquares = msg.bonusSquares;
  deps.state.towerAlive = msg.towerAlive;
  deps.state.burningPits = msg.burningPits;
  deps.state.cannonLimits = msg.limits;
  deps.state.timer = msg.timer;
  resetBattleState(deps);
  resetWatcherCrosshairs(deps);
  resetCannonFacings(deps.state);
}

export function applyBattleStartCheckpoint(
  msg: ServerMessage,
  deps: CheckpointDeps,
): void {
  if (msg.type !== MESSAGE.BATTLE_START) return;
  applyPlayersCheckpoint(deps.state, msg.players);
  applyGruntsCheckpoint(deps.state, msg.grunts);
  deps.state.burningPits = msg.burningPits;
  deps.state.towerAlive = msg.towerAlive;
  deps.battleAnim.territory = deps.snapshotTerritory();
  deps.battleAnim.walls = snapshotAllWalls(deps.state);

  deps.state.capturedCannons = [];
  if (msg.capturedCannons) {
    for (const cc of msg.capturedCannons) {
      const victim = deps.state.players[cc.victimId];
      if (victim && cc.cannonIdx >= 0 && cc.cannonIdx < victim.cannons.length) {
        deps.state.capturedCannons.push({
          cannon: victim.cannons[cc.cannonIdx]!,
          cannonIdx: cc.cannonIdx,
          victimId: cc.victimId,
          capturerId: cc.capturerId,
        });
      }
    }
  }

  resetBattleState(deps);
  deps.state.timer = BATTLE_TIMER;
  resetWatcherCrosshairs(deps);
  for (const p of deps.state.players) {
    if (p.eliminated || !p.homeTower) continue;
    deps.watcherCrosshairPos.set(p.id, towerCenterPx(p.homeTower));
  }
}

export function applyBuildStartCheckpoint(
  msg: ServerMessage,
  deps: CheckpointDeps,
): void {
  if (msg.type !== MESSAGE.BUILD_START) return;
  applyPlayersCheckpoint(deps.state, msg.players);
  applyGruntsCheckpoint(deps.state, msg.grunts);
  applyHousesCheckpoint(deps.state, msg.houses);
  deps.state.bonusSquares = msg.bonusSquares;
  deps.state.towerAlive = msg.towerAlive;
  deps.state.burningPits = msg.burningPits;
  deps.state.round = msg.round;
  deps.state.timer = msg.timer;
  resetBattleState(deps);
  deps.accum.grunt = 0;
  resetCannonFacings(deps.state);
}

/** Clear in-flight cannonballs and visual impacts. */
function resetBattleState(deps: CheckpointDeps): void {
  deps.state.cannonballs = [];
  deps.battleAnim.impacts = [];
}

/** Clear all watcher crosshair/orbit tracking maps. */
function resetWatcherCrosshairs(deps: CheckpointDeps): void {
  deps.remoteCrosshairs.clear();
  deps.watcherCrosshairPos.clear();
  deps.watcherOrbitParams.clear();
  deps.watcherIdlePhases.clear();
}
