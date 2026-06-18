/** A player's slot id in an online session, or SPECTATOR_SLOT (-1) for watchers.
 *  Branded to prevent raw numbers from silently entering the player-identity pipeline.
 *  Always check with `isActivePlayer()` before using as an array index.
 *
 *  `as PlayerId` casts are acceptable at trust boundaries:
 *  1. Wire protocol deserialization: `msg.playerId as PlayerId`
 *  2. Constants: `SPECTATOR_SLOT = -1 as PlayerId` */

export type PlayerId = number & { readonly __playerId: true };

/** Narrowed PlayerId that passed the `isActivePlayer()` guard (>= 0).
 *  Safe to use as an index into `state.players` or `controllers`.
 *
 *  `as ValidPlayerId` casts are acceptable in three cases:
 *  1. Loop index bounded by playerCount: `for (let i = 0; i < playerCount; i++)`
 *  2. Server-validated message field: `msg.playerId as ValidPlayerId`
 *  3. Value just checked locally: `if (id >= 0) … id as ValidPlayerId`
 *  Prefer `isActivePlayer()` type guard when possible. */
export type ValidPlayerId = PlayerId & { readonly __validId: true };

/** Sentinel value for myPlayerId: client joined but did not select a slot.
 *  Spectators can watch the game but not control any player. If promoted to host
 *  (original host disconnects), all players become AI. */
export const SPECTATOR_SLOT = -1 as PlayerId;

/** Type guard: true if this is a valid player slot (not spectating).
 *  Narrows `PlayerId` to `ValidPlayerId` in the true branch. */
export function isActivePlayer(playerId: PlayerId): playerId is ValidPlayerId {
  return playerId >= 0;
}

/** True if a player is eliminated or absent (null/undefined ⇒ effectively
 *  eliminated). Deliberately works on the minimal `{ eliminated? }` slot shape
 *  — NOT the full `Player` struct — so it stays at L0 and is callable from
 *  low-layer code (e.g. zone math in `player-zones.ts`) that must not import
 *  `Player`. Its narrowing inverse `isPlayerAlive` (a `player is Player` guard)
 *  lives in `player-types.ts` (L4) with the struct it narrows to. */
export function isPlayerEliminated(
  player: { readonly eliminated?: boolean } | null | undefined,
): boolean {
  return !player || player.eliminated === true;
}
