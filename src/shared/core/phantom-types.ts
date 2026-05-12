import { CannonMode } from "./battle-types.ts";
import type { ValidPlayerId } from "./player-slot.ts";

/** Common positional fields shared between the cannon placement event and
 *  the preview phantom. Split out because the placement event carries an
 *  `applyAt` lockstep stamp that the phantom (a render preview) does not. */
interface CannonShapePayload {
  playerId: ValidPlayerId;
  row: number;
  col: number;
  mode: CannonMode;
}

/** Network payload for a cannon placement event. `applyAt` is the lockstep
 *  apply tick: both originator and receiver enqueue with this stamp so the
 *  cannon-push fires at the same logical sim tick on every peer. */
export interface CannonPlacedPayload extends CannonShapePayload {
  applyAt: number;
}

/** Cannon phantom (placement preview). `valid` controls placement coloring
 *  (green/red). Used in-memory by controllers/renderers and on the wire —
 *  phantoms render only, so they carry no `applyAt`. */
export interface CannonPhantom extends CannonShapePayload {
  valid: boolean;
}

/** Wire alias — same shape as the in-memory phantom. */
export type CannonPhantomPayload = CannonPhantom;

/** Common positional fields shared between the placement event and the
 *  preview phantom. Split out because the placement event carries an
 *  `applyAt` lockstep stamp that the phantom (a render preview) does not. */
interface PieceShapePayload {
  playerId: ValidPlayerId;
  row: number;
  col: number;
  offsets: [number, number][];
}

/** Network payload for a piece placement event. `applyAt` is the lockstep
 *  apply tick: both originator and receiver enqueue with this stamp so the
 *  apply (and its order-sensitive RNG-consuming `recheckTerritory` cascade)
 *  fires at the same logical sim tick on every peer. */
export interface PiecePlacedPayload extends PieceShapePayload {
  applyAt: number;
}

/** Piece phantom (placement preview). `valid` controls placement coloring
 *  (green = valid, dark gray = invalid). Used in-memory by controllers/
 *  renderers and on the wire — phantoms render only, so they carry no
 *  `applyAt`. */
export interface PiecePhantom extends PieceShapePayload {
  valid: boolean;
}

/** Wire alias — same shape as the in-memory phantom. */
export type PiecePhantomPayload = PiecePhantom;

/** Opaque dedup tracker — wraps a per-player map of last-sent serialized keys.
 *  Use `shouldSend()` to check + update atomically; `clear()` on reset. */
export interface DedupChannel {
  /** Check-then-update: returns true if the key differs from the last call
   *  (caller should send). MUTATES internal state — stores the new key. */
  shouldSend(playerId: ValidPlayerId, key: string): boolean;
  /** Clear all tracked values (call on phase transition or host promotion). */
  clear(): void;
}

/** Return the cannon mode for network transmission. Currently identity (returns
 *  phantom.mode directly), but provides an abstraction point if wire format diverges. */
export function phantomWireMode(phantom: CannonPhantom): CannonMode {
  return phantom.mode;
}

/** Create a new dedup channel (empty — all first sends will pass). */
export function createDedupChannel(): DedupChannel {
  const map = new Map<number, string>();
  return {
    shouldSend(playerId: ValidPlayerId, key: string): boolean {
      if (map.get(playerId) === key) return false;
      map.set(playerId, key);
      return true;
    },
    clear(): void {
      map.clear();
    },
  };
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
