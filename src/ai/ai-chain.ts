/**
 * Chain-attack kinds the AI executes during battle. Paired const + derived
 * union, kept in their own file so `ai-strategy-types.ts` can stay
 * purely-types and the strategy/phase modules import the value directly.
 */

/** The kind of chain attack the AI executes during battle. */

export type ChainType = (typeof CHAIN)[keyof typeof CHAIN];

export const CHAIN = {
  WALL: "wall",
  GRUNT: "grunt",
  POCKET: "pocket",
  STRUCTURAL: "structural",
  ICE_TRENCH: "ice_trench",
} as const;
