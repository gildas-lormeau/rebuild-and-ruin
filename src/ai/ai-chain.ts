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
 *  time. Only the tactics in `OFFENSIVE_TACTICS` are excluded; the defensive /
 *  utility tactics (ice_trench, grunt_sweep, charity, pocket) stay
 *  re-selectable as their live preconditions demand. */
export const TACTIC = {
  PINCH_KILL: "pinch_kill",
  GRUNT_BREACH: "grunt_breach",
  DENY_ENCLOSURE: "deny_enclosure",
  MAX_REPAIR_COST: "max_repair_cost",
  ICE_TRENCH: "ice_trench",
  GRUNT_SWEEP: "grunt_sweep",
  CHARITY: "charity",
  STRUCTURAL: "structural",
  FAT_BREACH: "fat_breach",
  POCKET: "pocket",
  DECLUTTER: "declutter",
  WALL_DEMOLITION: "wall_demolition",
  SUPER_ATTACK: "super_attack",
  FINISH_IT: "finish_it",
  SUSTAINED_PRESSURE: "sustained_pressure",
} as const;
/** The tactics subject to once-per-battle exclusion across a battle's
 *  re-plans. Most defensive / utility tactics are intentionally absent —
 *  and so is DENY_ENCLOSURE: it stays re-selectable so successive re-plans keep
 *  pursuing the defender's cheapest ring (raising its re-closure cost) instead
 *  of firing once and moving on. */
export const OFFENSIVE_TACTICS: ReadonlySet<TacticId> = new Set([
  TACTIC.STRUCTURAL,
  TACTIC.FAT_BREACH,
  TACTIC.WALL_DEMOLITION,
  TACTIC.SUPER_ATTACK,
  // One corridor per battle: the drill's value is the grunt march it enables,
  // and the grunts only march once (next build) — a second drill the same
  // battle would spend shots on a seam with no fresh marchers.
  TACTIC.GRUNT_BREACH,
  // One pocket per battle: declutter is a tempo spend on the player's OWN fat
  // walls, and its trigger (fat count over threshold) stays true for the whole
  // battle — without the exclusion a fat castle would re-plan cleanup chains
  // all battle and never fire at an enemy.
  TACTIC.DECLUTTER,
  // One perimeter spray per battle: the outer shell it punches doesn't
  // regenerate mid-battle, so a second spray the same battle would re-fire at
  // holes already open. Its precondition (>16 cannons vs a large messy castle)
  // stays true all battle, so without the exclusion a dominant player would
  // re-pick it every re-plan and never run the tail grind.
  TACTIC.FINISH_IT,
  // SUSTAINED_PRESSURE is deliberately absent: it is the guaranteed tail
  // fallback — re-selectable every re-plan so the battery keeps grinding the
  // victim instead of downshifting to the per-shot loop.
]);
