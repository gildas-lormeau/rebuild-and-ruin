/**
 * Cannon tier derivation — a pure function of a player's remaining lives.
 *
 * Lives on its own leaf (not in player-types.ts) so render-side modules can
 * derive the tier without depending on the game-domain `Player` type — the
 * structural `{ readonly lives: number }` param keeps the boundary airtight.
 */

import { STARTING_LIVES } from "./game-constants.ts";

/** Cannon tier for a player, derived from lives lost. Tier 1 at full lives,
 *  tier 2 after one life lost, tier 3 after two (the post-continue tier for
 *  a player on their last life). Clamped to [1, 3] so test maps or custom
 *  starting-lives values can't produce tier 4+. Used by ball-speed and the
 *  3D cannon sprite selection. */
export function cannonTier(player: { readonly lives: number }): 1 | 2 | 3 {
  const lost = STARTING_LIVES - player.lives;
  if (lost >= 2) return 3;
  if (lost === 1) return 2;
  return 1;
}
