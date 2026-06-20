/**
 * Seeds for private Rngs whose draws don't touch `state.rng`.
 * `deriveAiStrategySeed` — per-(slot, round) AI strategy/personality streams.
 * `deriveBoardLocalSeed` — R5b board-dependent-count draws (see its own doc).
 * Formulas MUST stay stable: determinism fixtures + promoted-host AI identity
 * depend on them.
 */

import type { ValidPlayerId } from "./player-slot.ts";

/** Large prime for deriving per-round AI strategy seeds (ensures uncorrelated rounds). */
const SEED_ROUND_MULTIPLIER = 1000003;
/** Golden ratio hash constant (2^32 × φ⁻¹) for deriving per-slot AI strategy seeds. */
const SEED_SLOT_MULTIPLIER = 0x9e3779b9;
/** Mixing constant separating distinct board-local draw sites (R5b). */
const SEED_SITE_MULTIPLIER = 0x85ebca6b;
/**
 * Distinct discriminator per board-local draw site (R5b). Keeps two sites that
 * share the same (round, key) from drawing the *same* private sequence. Values
 * are opaque — only their mutual distinctness matters. Never reuse a number.
 */
export const BOARD_LOCAL_SITE = {
  HOUSE_REFILL: 1,
  CATAPULT_KIND: 2,
  GRUNT_WALL_ATTACK: 3,
  ENCLOSED_GRUNT_RESPAWN: 4,
  BONUS_REFILL: 5,
  BATTLE_HOUSE_GRUNT: 6,
  CAPTURED_CANNON_PICK: 7,
  GRUNT_SPAWN_JITTER: 8,
  WILDFIRE_SPREAD: 9,
  SINKHOLE_PLACEMENT: 10,
  MORTAR_ELECTION: 11,
  RICOCHET_SCATTER: 12,
  CONSCRIPTION_RESPAWN: 13,
  PIECE_BAG: 14,
  CASTLE_CLUMSY: 15,
  LOW_WATER_RIVERBED: 16,
} as const;

export function deriveAiStrategySeed(
  baseSeed: number,
  round: number,
  slot: ValidPlayerId,
): number {
  return (
    (baseSeed + round * SEED_ROUND_MULTIPLIER + slot * SEED_SLOT_MULTIPLIER) >>>
    0 // >>> 0 coerces to uint32 (consistent seed behavior across platforms)
  );
}

/**
 * R5b: seed for a private Rng that absorbs a board-dependent-count draw so the
 * shared `state.rng` cursor stays board-independent. Inputs MUST all be synced /
 * peer-identical: `baseSeed` = `state.rng.seed` (immutable — reading it does NOT
 * advance the cursor), `round` = `state.round`, `site` = a `BOARD_LOCAL_SITE`
 * tag, `key` = a board-independent sub-discriminator (zoneId, slot, or a tile
 * key for spawn-position-keyed draws). Formula MUST stay stable — determinism
 * fixtures depend on it.
 */
export function deriveBoardLocalSeed(
  baseSeed: number,
  round: number,
  site: number,
  key: number,
): number {
  return (
    (baseSeed +
      round * SEED_ROUND_MULTIPLIER +
      site * SEED_SITE_MULTIPLIER +
      key * SEED_SLOT_MULTIPLIER) >>>
    0
  );
}
