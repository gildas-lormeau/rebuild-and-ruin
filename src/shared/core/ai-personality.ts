/**
 * Pre-rolled AI personality shape. Lives here so `ControllerFactory` in
 * `system-interfaces.ts` can reference it without importing upward into
 * `ai/`. Rolling logic + trait profiles stay in
 * `src/ai/ai-personality-roll.ts`.
 */

/** Archetype string literals — type-level mirror of the `Archetype` const
 *  in `src/ai/ai-personality-roll.ts` (the value-space source of truth,
 *  which can't be imported here: it lives in a higher layer). Drift is
 *  caught at compile time by `ARCHETYPE_PROFILES: Record<ArchetypeId, ...>`
 *  keyed with `[Archetype.X]` in that file — add/remove/rename on either
 *  side and tsc fails there. */

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
