/**
 * Phantom visualization types and dedup utilities.
 *
 * Phantoms represent remote players' placement previews (cannons, wall pieces)
 * shown on the local client during online play. The types and utilities here
 * are used by both runtime (host tick logic) and online (watcher battle) layers,
 * so they live in a shared layer to avoid pulling online code into the runtime chunk.
 */

import { CannonMode } from "./types.ts";

/** Cannon phantom sent over the network. `valid` controls placement coloring (green/red). */
export type CannonPhantom = {
  row: number;
  col: number;
  valid: boolean;
  mode: CannonMode;
  playerId: number;
};

/** Remote AI piece phantom (no `valid` — always drawn as neutral; no local validation). */
export type PiecePhantom = {
  offsets: [number, number][];
  row: number;
  col: number;
  playerId: number;
  valid: boolean;
};

/** Return the cannon mode for network transmission. Currently identity (returns
 *  phantom.mode directly), but provides an abstraction point if wire format diverges. */
export function phantomWireMode(phantom: CannonPhantom): CannonMode {
  return phantom.mode;
}

/** Check if a value has changed since last send, updating the dedup map.
 *  **Side effect**: updates `map[playerId] = key` on change.
 *  Returns true if the value changed (caller should send).
 *  Returns false if unchanged (caller should skip sending).
 *
 *  Dedup invariant (used across online-session.ts, online-host-crosshairs.ts,
 *  online-watcher-battle.ts): always follow the three-step sequence:
 *    1. Call `dedupChanged(map, id, key)` — returns true if value changed
 *    2. Send the network message (only if step 1 returned true)
 *    3. Map is already updated by step 1 (no separate update needed)
 *  Skipping step 1 wastes bandwidth; calling send without step 1 breaks dedup.
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
  return `${phantom.row},${phantom.col},${phantom.mode},${phantom.valid ? 1 : 0}`;
}

/** Dedup key for piece phantom network sends. Covers position + shape + validity.
 *  Same pattern as cannonPhantomKey — more complex key due to variable-length offsets. */
export function piecePhantomKey(phantom: PiecePhantom): string {
  return `${phantom.row},${phantom.col},${phantom.valid ? 1 : 0},${phantom.offsets.map((offset) => offset.join(":")).join(";")}`;
}
