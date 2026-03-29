/** Shared types and utilities for online multiplayer sub-modules. */

import type { PixelPos } from "./geometry-types.ts";
import { CANNON_MODES, CannonMode } from "./types.ts";

export type CannonPhantom = {
  row: number;
  col: number;
  valid: boolean;
  mode: CannonMode;
  playerId: number;
  facing?: number;
};

export type PiecePhantom = {
  offsets: [number, number][];
  row: number;
  col: number;
  playerId: number;
};

export type HumanPiecePhantom = {
  offsets: [number, number][];
  row: number;
  col: number;
  valid: boolean;
  playerId: number;
};

export interface WatcherTimingState {
  phaseStartTime: number;
  phaseDuration: number;
  countdownStartTime: number;
  countdownDuration: number;
}

/** Parse a string as a CannonMode, defaulting to NORMAL if invalid. */
export function toCannonMode(value: string | undefined): CannonMode {
  if (value && (CANNON_MODES as ReadonlySet<string>).has(value))
    return value as CannonMode;
  return CannonMode.NORMAL;
}

/** Move `vis` toward `(tx, ty)` at `speed` pixels/s. Mutates `vis` in place. */
export function interpolateToward(
  vis: PixelPos,
  tx: number,
  ty: number,
  speed: number,
  dt: number,
): void {
  const dx = tx - vis.x,
    dy = ty - vis.y;
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

/** Return the wire protocol cannon mode string for a phantom. */
export function phantomWireMode(phantom: CannonPhantom): CannonMode {
  return phantom.mode;
}

/** Check if a phantom changed since last send; updates the map if so. */
export function phantomChanged(
  map: Map<number, string>,
  playerId: number,
  key: string,
): boolean {
  if (map.get(playerId) === key) return false;
  map.set(playerId, key);
  return true;
}

/** Filter remote phantoms to only those from non-eliminated players.
 *  Shared between host (mergeRemotePiecePhantoms) and watcher to prevent
 *  drift in the eliminated-player exclusion logic. */
export function filterAlivePhantoms<T extends { playerId: number }>(
  phantoms: readonly T[],
  players: readonly { eliminated?: boolean }[],
): T[] {
  return phantoms.filter((phantom) => !players[phantom.playerId]?.eliminated);
}

/** Dedup key for cannon phantom network sends. Covers all fields that affect display. */
export function cannonPhantomKey(phantom: CannonPhantom): string {
  return `${phantom.row},${phantom.col},${phantom.mode}`;
}

/** Dedup key for piece phantom network sends. Covers position + shape. */
export function piecePhantomKey(phantom: PiecePhantom): string {
  return `${phantom.row},${phantom.col},${phantom.offsets.map((offset) => offset.join(":")).join(";")}`;
}
