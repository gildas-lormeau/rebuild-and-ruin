import { CannonMode } from "./battle-types.ts";
import type { SerializedPlayer } from "./checkpoint-data.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";

/** Cannon phantom sent over the network. `valid` controls placement coloring (green/red). */
export type CannonPhantom = {
  row: number;
  col: number;
  valid: boolean;
  mode: CannonMode;
  playerId: ValidPlayerSlot;
};

/** Remote AI piece phantom (no `valid` — always drawn as neutral; no local validation). */
export type PiecePhantom = {
  offsets: [number, number][];
  row: number;
  col: number;
  playerId: ValidPlayerSlot;
  valid: boolean;
};

/** Network payload for a cannon placement event. */
export interface CannonPlacedPayload {
  playerId: ValidPlayerSlot;
  row: number;
  col: number;
  mode: CannonMode;
}

/** Network payload for a cannon phantom (includes validity for coloring). */
export interface CannonPhantomPayload extends CannonPlacedPayload {
  valid: boolean;
}

/** Network payload for a piece placement event. */
export interface PiecePlacedPayload {
  playerId: ValidPlayerSlot;
  row: number;
  col: number;
  offsets: [number, number][];
}

/** Network payload for a piece phantom (includes validity for coloring). */
export interface PiecePhantomPayload extends PiecePlacedPayload {
  valid: boolean;
}

/** Network payload for build phase end (checkpoint data). */
export interface BuildEndPayload {
  needsReselect: ValidPlayerSlot[];
  eliminated: ValidPlayerSlot[];
  scores: number[];
  players: SerializedPlayer[];
}

/** Opaque dedup tracker — wraps a per-player map of last-sent serialized keys.
 *  Use `shouldSend()` to check + update atomically; `clear()` on reset. */
export interface DedupChannel {
  /** Check-then-update: returns true if the key differs from the last call
   *  (caller should send). MUTATES internal state — stores the new key. */
  shouldSend(playerId: ValidPlayerSlot, key: string): boolean;
  /** Clear all tracked values (call on phase transition or host promotion). */
  clear(): void;
}

/** Sentinel channel for local play — never blocks sends (always returns true).
 *  Used as a fallback when networking deps are absent. */
export const NOOP_DEDUP_CHANNEL: DedupChannel = {
  shouldSend: () => true,
  clear: () => {},
};

/** Return the cannon mode for network transmission. Currently identity (returns
 *  phantom.mode directly), but provides an abstraction point if wire format diverges. */
export function phantomWireMode(phantom: CannonPhantom): CannonMode {
  return phantom.mode;
}

/** Create a new dedup channel (empty — all first sends will pass). */
export function createDedupChannel(): DedupChannel {
  const map = new Map<number, string>();
  return {
    shouldSend(playerId: ValidPlayerSlot, key: string): boolean {
      if (map.get(playerId) === key) return false;
      map.set(playerId, key);
      return true;
    },
    clear(): void {
      map.clear();
    },
  };
}

/** Filter remote phantoms to only those from non-eliminated players.
 *  Shared between host (mergeRemotePiecePhantoms) and watcher to prevent
 *  drift in the eliminated-player exclusion logic. */
export function filterAlivePhantoms<T extends { playerId: ValidPlayerSlot }>(
  phantoms: readonly T[],
  players: readonly { eliminated?: boolean }[],
): T[] {
  return phantoms.filter((phantom) => !players[phantom.playerId]?.eliminated);
}

/** Dedup key for cannon phantom network sends. Covers all fields that affect display.
 *  Format: `"row,col,mode,valid"` where valid is `1` (true) or `0` (false).
 *  Same pattern as piecePhantomKey — both are `(phantom: T) => string` dedup keys
 *  used by dedupChanged() to suppress redundant network sends. */
export function cannonPhantomKey(phantom: CannonPhantom): string {
  return `${phantom.row},${phantom.col},${phantom.mode},${phantom.valid ? 1 : 0}`;
}

/** Dedup key for piece phantom network sends. Covers position + shape + validity.
 *  Format: `"row,col,valid,r0:c0;r1:c1;..."` — offsets joined by `:` (within pair)
 *  and `;` (between pairs). Valid is `1`/`0`.
 *  Same pattern as cannonPhantomKey — more complex key due to variable-length offsets. */
export function piecePhantomKey(phantom: PiecePhantom): string {
  return `${phantom.row},${phantom.col},${phantom.valid ? 1 : 0},${phantom.offsets.map((offset) => offset.join(":")).join(";")}`;
}
