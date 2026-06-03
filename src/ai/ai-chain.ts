/**
 * Chain-attack kinds the AI executes during battle. Paired const + derived
 * union, kept in their own file so `ai-strategy-types.ts` can stay
 * purely-types and the strategy/phase modules import the value directly.
 */

/** The kind of chain attack the AI executes during battle. */

export type ChainType = (typeof CHAIN)[keyof typeof CHAIN];

export type TacticId = (typeof TACTIC)[keyof typeof TACTIC];

export const CHAIN = {
  WALL: "wall",
  GRUNT: "grunt",
  POCKET: "pocket",
  STRUCTURAL: "structural",
  ICE_TRENCH: "ice_trench",
} as const;
/** Granular battle-tactic identity — finer than ChainType, which collapses
 *  wall_demolition + super_attack into CHAIN.WALL and structural + fat_breach
 *  into CHAIN.STRUCTURAL. The battle phase machine re-plans a fresh chain each
 *  time one finishes (multiple attacks per battle); it tracks which OFFENSIVE
 *  tactics have already fired and feeds them back to `planBattle` as an
 *  exclusion set so the attack sequence varies (e.g. structural → fat_breach →
 *  super_attack) instead of re-picking the highest-probability tactic every
 *  time. Only the four wall-breaching tactics are excluded; the defensive /
 *  utility tactics (ice_trench, grunt_sweep, charity, pocket) stay
 *  re-selectable as their live preconditions demand. */
export const TACTIC = {
  DENY_ENCLOSURE: "deny_enclosure",
  ICE_TRENCH: "ice_trench",
  GRUNT_SWEEP: "grunt_sweep",
  CHARITY: "charity",
  STRUCTURAL: "structural",
  FAT_BREACH: "fat_breach",
  POCKET: "pocket",
  WALL_DEMOLITION: "wall_demolition",
  SUPER_ATTACK: "super_attack",
} as const;
/** The wall-breaching tactics subject to force-variety exclusion across a
 *  battle's re-plans. Defensive / utility tactics are intentionally absent —
 *  and so is DENY_ENCLOSURE: it stays re-selectable so successive re-plans keep
 *  pursuing the defender's cheapest ring (raising its re-closure cost) instead
 *  of firing once and moving on. */
export const OFFENSIVE_TACTICS: ReadonlySet<TacticId> = new Set([
  TACTIC.STRUCTURAL,
  TACTIC.FAT_BREACH,
  TACTIC.WALL_DEMOLITION,
  TACTIC.SUPER_ATTACK,
]);
