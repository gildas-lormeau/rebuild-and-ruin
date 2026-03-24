import { MSG, type ServerMessage } from "../server/protocol.ts";
import { resetCannonFacings } from "./game-engine.ts";
import type { PixelPos } from "./geometry-types.ts";
import { TILE_SIZE } from "./grid.ts";
import {
  applyGruntsCheckpoint,
  applyHousesCheckpoint,
  applyPlayersCheckpoint,
} from "./online-serialize.ts";
import type { OrbitParams } from "./player-controller.ts";
import type { GameState } from "./types.ts";
import { BATTLE_TIMER } from "./types.ts";

export interface CheckpointBattleAnim {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: { flight: { startX: number; startY: number; endX: number; endY: number }; progress: number }[];
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
  if (msg.type !== MSG.CANNON_START) return;
  applyPlayersCheckpoint(deps.state, msg.players);
  applyGruntsCheckpoint(deps.state, msg.grunts);
  applyHousesCheckpoint(deps.state, msg.houses);
  deps.state.bonusSquares = msg.bonusSquares;
  deps.state.towerAlive = msg.towerAlive;
  deps.state.burningPits = msg.burningPits;
  deps.state.cannonLimits = msg.limits;
  deps.state.timer = msg.timer;
  deps.state.cannonballs = [];
  deps.battleAnim.impacts = [];
  deps.remoteCrosshairs.clear();
  deps.watcherCrosshairPos.clear();
  deps.watcherOrbitParams.clear();
  deps.watcherIdlePhases.clear();
  resetCannonFacings(deps.state);
}
export function applyBattleStartCheckpoint(
  msg: ServerMessage,
  deps: CheckpointDeps,
): void {
  if (msg.type !== MSG.BATTLE_START) return;
  applyPlayersCheckpoint(deps.state, msg.players);
  applyGruntsCheckpoint(deps.state, msg.grunts);
  deps.state.burningPits = msg.burningPits;
  deps.state.towerAlive = msg.towerAlive;
  deps.battleAnim.territory = deps.snapshotTerritory();
  deps.battleAnim.walls = deps.state.players.map((p) => new Set(p.walls));

  deps.state.capturedCannons = [];
  if (msg.capturedCannons) {
    for (const cc of msg.capturedCannons) {
      const victim = deps.state.players[cc.victimId];
      if (victim && cc.cannonIdx >= 0 && cc.cannonIdx < victim.cannons.length) {
        deps.state.capturedCannons.push({
          cannon: victim.cannons[cc.cannonIdx]!,
          victimId: cc.victimId,
          capturerId: cc.capturerId,
        });
      }
    }
  }

  deps.battleAnim.impacts = [];
  deps.state.cannonballs = [];
  deps.state.timer = BATTLE_TIMER;
  deps.remoteCrosshairs.clear();
  deps.watcherCrosshairPos.clear();
  deps.watcherOrbitParams.clear();
  deps.watcherIdlePhases.clear();
  for (const p of deps.state.players) {
    if (p.eliminated || !p.homeTower) continue;
    deps.watcherCrosshairPos.set(p.id, {
      x: (p.homeTower.col + 1) * TILE_SIZE,
      y: (p.homeTower.row + 1) * TILE_SIZE,
    });
  }
}
export function applyBuildStartCheckpoint(
  msg: ServerMessage,
  deps: CheckpointDeps,
): void {
  if (msg.type !== MSG.BUILD_START) return;
  applyPlayersCheckpoint(deps.state, msg.players);
  applyGruntsCheckpoint(deps.state, msg.grunts);
  applyHousesCheckpoint(deps.state, msg.houses);
  deps.state.bonusSquares = msg.bonusSquares;
  deps.state.towerAlive = msg.towerAlive;
  deps.state.burningPits = msg.burningPits;
  deps.state.round = msg.round;
  deps.state.timer = msg.timer;
  deps.state.cannonballs = [];
  deps.battleAnim.impacts = [];
  deps.accum.grunt = 0;
  resetCannonFacings(deps.state);
}
