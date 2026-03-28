/**
 * Shared pure helper functions used by both main.ts and online-client.ts.
 *
 * These are stateless utilities that take all inputs as parameters.
 */

import { nextReadyCombined } from "./battle-system.ts";
import type { Crosshair, PlayerController } from "./controller-interfaces.ts";
import { rebuildHomeCastle } from "./game-engine.ts";
import type { KeyBindings } from "./player-config.ts";
import {
  type GameState,
  type Impact,
  Mode,
  Phase,
  type Player,
} from "./types.ts";

/** Format a key binding as a short hint string (e.g. "Arrows + N (B rotate)"). */
export function formatKeyHint(kb: KeyBindings): string {
  const arrows =
    kb.up === "ArrowUp"
      ? "Arrows"
      : kb.up.toUpperCase() +
        kb.left.toUpperCase() +
        kb.down.toUpperCase() +
        kb.right.toUpperCase();
  return `${arrows} + ${kb.confirm.toUpperCase()} (${kb.rotate.toUpperCase()} rotate)`;
}

/** Build a map from confirm key → player slot index for lobby joining. */
export function createLobbyConfirmKeys(
  keyBindings: readonly KeyBindings[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < keyBindings.length; i++) {
    const kb = keyBindings[i]!;
    m.set(kb.confirm, i);
    m.set(kb.confirm.toUpperCase(), i);
  }
  return m;
}

/** Snapshot per-player territory (interior + walls) for battle rendering. */
export function snapshotTerritory(players: readonly Player[]): Set<number>[] {
  return players.map((p) => {
    const combined = new Set(p.interior);
    for (const key of p.walls) combined.add(key);
    return combined;
  });
}

/** Collect crosshairs from local controllers. */
export function collectLocalCrosshairs(params: {
  state: GameState;
  controllers: PlayerController[];
  canFireNow: boolean;
  skipController?: (playerId: number) => boolean;
  onCrosshairCollected?: (
    ctrl: PlayerController,
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

/** Run the shared main loop tick: quit countdown, pause check, mode dispatch.
 *  Returns false if the loop should NOT reschedule (Mode.STOPPED). */
export function tickMainLoop(params: {
  dt: number;
  mode: Mode;
  paused: boolean;
  quitPending: boolean;
  quitTimer: number;
  quitMessage?: string;
  frame: { announcement?: string };
  setQuitPending: (v: boolean) => void;
  setQuitTimer: (v: number) => void;
  render: () => void;
  ticks: Record<number, (dt: number) => void>;
}): boolean {
  const { dt, mode, frame, ticks } = params;

  // Tick ESC-to-quit countdown
  if (params.quitPending) {
    const next = params.quitTimer - dt;
    if (next <= 0) {
      params.setQuitPending(false);
    } else {
      params.setQuitTimer(next);
      if (params.quitMessage) frame.announcement = params.quitMessage;
    }
  }

  // Pause: keep rendering but skip all game ticks
  if (
    params.paused &&
    mode !== Mode.LOBBY &&
    mode !== Mode.OPTIONS &&
    mode !== Mode.CONTROLS &&
    mode !== Mode.STOPPED
  ) {
    if (!frame.announcement) frame.announcement = "PAUSED";
    params.render();
    return true;
  }

  if (mode === Mode.STOPPED) return false;

  const tick = ticks[mode];
  if (tick) tick(dt);

  return true;
}

/** Process the reselection queue. Returns players still needing UI interaction.
 *  `processPlayer` returns: "done" (AI picked), "pending" (needs UI), or "remote" (remote human). */
export function processReselectionQueue(params: {
  reselectQueue: number[];
  state: GameState;
  controllers: PlayerController[];
  initTowerSelection: (pid: number, zone: number) => void;
  processPlayer: (
    pid: number,
    ctrl: PlayerController,
    zone: number,
  ) => "done" | "pending";
  onDone: (pid: number, ctrl: PlayerController) => void;
}): { remaining: number[]; needsUI: boolean } {
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
  clearOverlaySelection: () => void;
  reselectQueue: { length: number };
  reselectionPids: number[];
  finalizeAndAdvance: () => void;
}): void {
  const { state, selectionStates, clearOverlaySelection, reselectionPids } =
    params;
  selectionStates.clear();
  clearOverlaySelection();
  (params.reselectQueue as number[]).length = 0;

  const pids = new Set(reselectionPids);
  for (const pid of pids) {
    const player = state.players[pid]!;
    if (!player.homeTower) continue;
    rebuildHomeCastle(state, player);
  }

  params.finalizeAndAdvance();
}
