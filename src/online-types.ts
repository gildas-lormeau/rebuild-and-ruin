/** Shared types and utilities for online multiplayer sub-modules. */

import type { PixelPos } from "./geometry-types.ts";
import { CannonMode } from "./types.ts";

export type CannonPhantom = {
  row: number;
  col: number;
  valid: boolean;
  kind: CannonMode;
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
export function phantomWireMode(p: CannonPhantom): CannonMode {
  return p.kind;
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

/** Dedup key for cannon phantom network sends. Covers all fields that affect display. */
export function cannonPhantomKey(p: CannonPhantom): string {
  return `${p.row},${p.col},${p.kind}`;
}

/** Dedup key for piece phantom network sends. Covers position + shape. */
export function piecePhantomKey(p: PiecePhantom): string {
  return `${p.row},${p.col},${p.offsets.map((o) => o.join(":")).join(";")}`;
}
