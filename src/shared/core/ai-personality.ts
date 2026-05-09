/**
 * Pre-rolled AI personality shape. Lives here so `ControllerFactory` in
 * `system-interfaces.ts` can reference it without importing upward into
 * `ai/`. Rolling logic + trait profiles stay in `src/ai/ai-strategy.ts`.
 */

/** Archetype string literals — must stay in sync with the `Archetype` const
 *  in `src/ai/ai-strategy.ts`. The const there is the single source of truth
 *  for the value space; this union is its type-level mirror. */

export type ArchetypeId =
  | "builder"
  | "aggressive"
  | "tactician"
  | "chaotic"
  | "balanced";

/** Pre-rolled personality. Computed once at bootstrap by `rollPersonality`,
 *  then handed to `DefaultStrategy` so its constructor doesn't draw from RNG.
 *  Letting pure-AI controllers reuse `state.rng` for runtime decisions
 *  without polluting it with construction-time draws is what makes the
 *  one-RNG-per-game architecture work even when one peer installs an
 *  `AiAssistedHumanController` variant for a slot the other peer treats as
 *  plain pure-AI. */
export interface AiPersonality {
  readonly archetype: ArchetypeId;
  readonly buildSkill: 1 | 2 | 3 | 4 | 5;
  readonly spatialAwareness: 1 | 2 | 3;
  readonly aggressiveness: 1 | 2 | 3;
  readonly defensiveness: 1 | 2 | 3;
  readonly battleTactics: 1 | 2 | 3;
  readonly cursorSkill: 1 | 2 | 3;
  readonly thinkingSpeed: 1 | 2 | 3;
  readonly caresAboutHouses: boolean;
  readonly caresAboutBonuses: boolean;
  readonly bankHugging: boolean;
}
