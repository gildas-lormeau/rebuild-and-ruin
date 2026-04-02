/**
 * Shared pure helper functions used by both main.ts and online-client.ts.
 *
 * These are stateless utilities that take all inputs as parameters.
 */

import { nextReadyCombined } from "./battle-system.ts";
import type {
  BattleController,
  ControllerIdentity,
  Crosshair,
  SelectionController,
} from "./controller-interfaces.ts";
import { packTile } from "./spatial.ts";
import { type GameState, type Impact, Phase, type Player } from "./types.ts";

/** Snapshot per-player territory (interior + walls) for battle rendering. */
export function snapshotTerritory(players: readonly Player[]): Set<number>[] {
  return players.map((player) => {
    const combined = new Set(player.interior);
    for (const key of player.walls) combined.add(key);
    return combined;
  });
}

/** Collect crosshairs from local controllers. */
export function collectLocalCrosshairs<
  T extends ControllerIdentity & BattleController = ControllerIdentity &
    BattleController,
>(params: {
  state: GameState;
  controllers: T[];
  canFireNow: boolean;
  skipController?: (playerId: number) => boolean;
  onCrosshairCollected?: (
    ctrl: T,
    ch: { x: number; y: number },
    readyCannon: boolean,
  ) => void;
}): Crosshair[] {
  const {
    state,
    controllers,
    canFireNow,
    skipController,
    onCrosshairCollected,
  } = params;
  const crosshairs: Crosshair[] = [];

  for (const ctrl of controllers) {
    if (skipController?.(ctrl.playerId)) continue;
    const player = state.players[ctrl.playerId]!;
    if (player.eliminated) continue;
    // Check if any cannon (own or captured) can fire right now
    const readyCannon = nextReadyCombined(state, ctrl.playerId);
    // If none ready, check if any ball is in flight (own or captured) — still reloading
    const anyReloading =
      !readyCannon &&
      state.cannonballs.some(
        (b) =>
          b.playerId === ctrl.playerId || b.scoringPlayerId === ctrl.playerId,
      );
    // Hide crosshair only when nothing can fire and nothing is reloading
    if (!readyCannon && !anyReloading) continue;
    const ch = ctrl.getCrosshair();
    crosshairs.push({
      x: ch.x,
      y: ch.y,
      playerId: ctrl.playerId,
      cannonReady: canFireNow && !!readyCannon,
    });
    onCrosshairCollected?.(ctrl, ch, !!readyCannon);
  }

  return crosshairs;
}

/** Tick game core: age impacts, dispatch to phase handlers. */
export function tickGameCore(params: {
  dt: number;
  state: GameState;
  battleAnim: { impacts: Impact[] };
  impactFlashDuration: number;
  tickCannonPhase: (dt: number) => void;
  tickBattleCountdown: (dt: number) => void;
  tickBattlePhase: (dt: number) => void;
  tickBuildPhase: (dt: number) => void;
}): void {
  const {
    dt,
    state,
    battleAnim,
    impactFlashDuration,
    tickCannonPhase,
    tickBattleCountdown,
    tickBattlePhase,
    tickBuildPhase,
  } = params;

  // Age and filter impact flashes regardless of phase
  for (const imp of battleAnim.impacts) imp.age += dt;
  battleAnim.impacts = battleAnim.impacts.filter(
    (imp) => imp.age < impactFlashDuration,
  );

  if (state.phase === Phase.CANNON_PLACE) {
    tickCannonPhase(dt);
  } else if (state.phase === Phase.BATTLE) {
    if (state.battleCountdown > 0) {
      tickBattleCountdown(dt);
    } else {
      tickBattlePhase(dt);
    }
  } else if (state.phase === Phase.WALL_BUILD) {
    tickBuildPhase(dt);
  }
}

/** Process the reselection queue. Returns players still needing UI interaction.
 *  `processPlayer` returns: "done" (AI picked), "pending" (needs UI), or "remote" (remote human). */
export function processReselectionQueue<
  T extends ControllerIdentity & SelectionController = ControllerIdentity &
    SelectionController,
>(params: {
  reselectQueue: number[];
  state: GameState;
  controllers: T[];
  initTowerSelection: (pid: number, zone: number) => void;
  processPlayer: (pid: number, ctrl: T, zone: number) => "done" | "pending";
  onDone: (pid: number, ctrl: T) => void;
}): {
  remaining: number[] /** True if any player still needs interactive castle selection. */;
  needsUI: boolean;
} {
  const remaining: number[] = [];
  let needsUI = false;
  for (const pid of params.reselectQueue) {
    const ctrl = params.controllers[pid]!;
    const zone = params.state.playerZones[pid] ?? 0;
    const result = params.processPlayer(pid, ctrl, zone);
    if (result === "done") {
      params.onDone(pid, ctrl);
    } else {
      remaining.push(pid);
      needsUI = true;
      params.initTowerSelection(pid, zone);
    }
  }
  return { remaining, needsUI };
}

/** Finish reselection — clear selection state, reset reselecting players, animate castles. */
export function completeReselection(params: {
  state: GameState;
  selectionStates: Map<number, { highlighted: number; confirmed: boolean }>;
  resetOverlaySelection: () => void;
  reselectQueue: { length: number };
  reselectionPids: number[];
  finalizeAndAdvance: () => void;
}): void {
  const { state, selectionStates, resetOverlaySelection, reselectionPids } =
    params;
  selectionStates.clear();
  resetOverlaySelection();
  (params.reselectQueue as number[]).length = 0;

  // The castle build animation already placed walls (including clumsy extras)
  // via addPlayerWall. Don't rebuild — just do cleanup.
  const pids = new Set(reselectionPids);
  for (const pid of pids) {
    const player = state.players[pid]!;
    if (!player.homeTower) continue;
    // Protect animated walls from debris sweep
    player.castleWallTiles = new Set(player.walls);
    // Destroy houses under rebuilt castle walls
    for (const house of state.map.houses) {
      if (!house.alive) continue;
      if (player.walls.has(packTile(house.row, house.col))) {
        house.alive = false;
      }
    }
  }

  params.finalizeAndAdvance();
}
