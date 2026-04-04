/** A player's slot id in an online session, or SPECTATOR_SLOT (-1) for watchers.
 *  Branded to prevent raw numbers from silently entering the player-identity pipeline.
 *  Always check with `isActivePlayer()` before using as an array index.
 *
 *  `as PlayerSlotId` casts are acceptable at trust boundaries:
 *  1. Wire protocol deserialization: `msg.playerId as PlayerSlotId`
 *  2. Constants: `SPECTATOR_SLOT = -1 as PlayerSlotId` */

export type PlayerSlotId = number & { readonly __playerSlot: true };

/** Narrowed PlayerSlotId that passed the `isActivePlayer()` guard (>= 0).
 *  Safe to use as an index into `state.players` or `controllers`.
 *
 *  `as ValidPlayerSlot` casts are acceptable in three cases:
 *  1. Loop index bounded by playerCount: `for (let i = 0; i < playerCount; i++)`
 *  2. Server-validated message field: `msg.playerId as ValidPlayerSlot`
 *  3. Value just checked locally: `if (id >= 0) … id as ValidPlayerSlot`
 *  Prefer `isActivePlayer()` type guard when possible. */
export type ValidPlayerSlot = PlayerSlotId & { readonly __validSlot: true };

/** Sentinel value for myPlayerId: client joined but did not select a slot.
 *  Spectators can watch the game but not control any player. If promoted to host
 *  (original host disconnects), all players become AI. */
export const SPECTATOR_SLOT = -1 as PlayerSlotId;

/** Type guard: true if this is a valid player slot (not spectating).
 *  Narrows `PlayerSlotId` to `ValidPlayerSlot` in the true branch. */
export function isActivePlayer(
  playerId: PlayerSlotId,
): playerId is ValidPlayerSlot {
  return playerId >= 0;
}
