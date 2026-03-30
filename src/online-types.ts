/** Shared types and utilities for online multiplayer sub-modules. */

import type { OrbitParams } from "./controller-interfaces.ts";
import type { PixelPos } from "./geometry-types.ts";
import { CANNON_MODES, CannonMode } from "./types.ts";

/** Cannon phantom sent over the network. `valid` controls placement coloring (green/red). */
export type CannonPhantom = {
  row: number;
  col: number;
  valid: boolean;
  mode: CannonMode;
  playerId: number;
  facing?: number;
};

/** Remote AI piece phantom (no `valid` — always drawn as neutral; no local validation). */
export type PiecePhantom = {
  offsets: [number, number][];
  row: number;
  col: number;
  playerId: number;
};

/** Local human piece phantom. Has `valid` for green/red placement preview coloring. */
export type HumanPiecePhantom = {
  offsets: [number, number][];
  row: number;
  col: number;
  valid: boolean;
  playerId: number;
};

/** Subset of watcher state containing network-received data (phantoms, crosshairs).
 *  Defined here (L10) so both "online infrastructure" and "online logic" consumers
 *  can reference it without importing from the higher-layer watcher module. */
export interface WatcherNetworkState {
  remoteCrosshairs: Map<number, PixelPos>;
  remoteCannonPhantoms: readonly CannonPhantom[];
  remotePiecePhantoms: readonly PiecePhantom[];
  orbitParams: Map<number, OrbitParams>;
}

export interface WatcherTimingState {
  phaseStartTime: number;
  phaseDuration: number;
  countdownStartTime: number;
  countdownDuration: number;
}

/** Speed multiplier for interpolating remote crosshairs (faster than local to reduce visual lag).
 *  Shared between host (online-host-crosshairs) and watcher (online-watcher-battle). */
export const REMOTE_CROSSHAIR_MULT = 2;

/** Start tracking a new phase timer. Call at the moment a phase begins on the watcher side.
 *  The watcher reconstructs `state.timer` each frame from `(now - phaseStartTime)`. */
export function startWatcherPhaseTimer(
  timing: WatcherTimingState,
  now: number,
  phaseDuration: number,
): void {
  timing.phaseStartTime = now;
  timing.phaseDuration = phaseDuration;
}

/** Reset phase timing to idle (no active phase timer). */
export function resetWatcherPhaseTimer(timing: WatcherTimingState): void {
  timing.phaseStartTime = 0;
  timing.phaseDuration = 0;
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

/** Return the cannon mode for network transmission. Currently identity (returns
 *  phantom.mode directly), but provides an abstraction point if wire format diverges. */
export function phantomWireMode(phantom: CannonPhantom): CannonMode {
  return phantom.mode;
}

/** Check if a value has changed since last send, updating the dedup map.
 *  Returns true if the value changed (caller should send).
 *  Returns false if unchanged (caller should skip sending).
 *  Usage: `if (!dedupChanged(map, playerId, key)) return;` */
export function dedupChanged(
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

/** Dedup key for cannon phantom network sends. Covers all fields that affect display.
 *  Same pattern as piecePhantomKey — both are `(phantom: T) => string` dedup keys
 *  used by dedupChanged() to suppress redundant network sends. */
export function cannonPhantomKey(phantom: CannonPhantom): string {
  return `${phantom.row},${phantom.col},${phantom.mode}`;
}

/** Dedup key for piece phantom network sends. Covers position + shape.
 *  Same pattern as cannonPhantomKey — more complex key due to variable-length offsets. */
export function piecePhantomKey(phantom: PiecePhantom): string {
  return `${phantom.row},${phantom.col},${phantom.offsets.map((offset) => offset.join(":")).join(";")}`;
}
