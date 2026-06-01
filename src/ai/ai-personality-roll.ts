/**
 * `rollPersonality` + archetype profile tables. Split out of
 * ai-strategy.ts so the function (called from online host promotion
 * via online-host-promotion.ts) sits at L1 instead of L12 — lets the hook surface
 * stay below any non-AI consumer's layer.
 */

import type {
  AiPersonality,
  ArchetypeId,
} from "../shared/core/ai-personality.ts";
import {
  DIFFICULTY_EASY,
  DIFFICULTY_HARD,
  DIFFICULTY_NORMAL,
} from "../shared/core/game-constants.ts";
import type { Rng } from "../shared/platform/rng.ts";

interface ArchetypeProfile {
  buildSkill: [number, number]; // [lo, hi] for 1–5
  spatialAwareness: [number, number]; // [lo, hi] for 1–3
  aggressiveness: [number, number];
  defensiveness: [number, number];
  battleTactics: [number, number];
  cursorSkill: [number, number];
  thinkingSpeed: [number, number];
  caresAboutHouses: number; // probability of true
  caresAboutBonuses: number;
  bankHugging: number; // probability of true
}

/** AI personality archetype. Determines correlated base trait values. */
const Archetype = {
  BUILDER: "builder",
  AGGRESSIVE: "aggressive",
  TACTICIAN: "tactician",
  CHAOTIC: "chaotic",
  BALANCED: "balanced",
} as const;
/**
 * Archetype trait profiles — tuned via playtesting for 3-player AI games.
 *
 * Each trait range [lo, hi] is rolled uniformly at AI creation, producing
 * varied play styles within each archetype. Key design goals:
 *
 * - BUILDER:     Prioritizes wall repair over attacking. High build skill
 *                ensures clean walls; low aggressiveness means fewer super
 *                guns and passive targeting. Slow, deliberate cursor.
 * - AGGRESSIVE:  Maximizes damage output. Always picks super guns, fires
 *                chain attacks, ignores houses/bonuses to save time for
 *                demolition. Mediocre walls but fast, accurate aim.
 * - TACTICIAN:   Strategic targeting (flanked walls, grunt-blocking walls).
 *                Good at everything but not extreme. Balloons deployed
 *                reactively. Moderate bank-hugging for territorial balance.
 * - CHAOTIC:     Unpredictable — low build skill creates messy walls, but
 *                fast cursor and high aggressiveness make battle dangerous.
 *                No tactical chains; fires at random targets rapidly.
 * - BALANCED:    All traits at midpoint. The "average" AI — competent but
 *                not specialized. Used as the baseline for difficulty tuning.
 */
const ARCHETYPE_PROFILES: Record<ArchetypeId, ArchetypeProfile> = {
  [Archetype.BUILDER]: {
    buildSkill: [3, 4],
    spatialAwareness: [2, 3],
    aggressiveness: [1, 1],
    defensiveness: [2, 3],
    battleTactics: [1, 2],
    cursorSkill: [1, 2],
    thinkingSpeed: [1, 2],
    caresAboutHouses: 0.8,
    caresAboutBonuses: 0.8,
    bankHugging: 0.2,
  },
  [Archetype.AGGRESSIVE]: {
    buildSkill: [1, 2],
    spatialAwareness: [2, 3],
    aggressiveness: [3, 3],
    defensiveness: [1, 1],
    battleTactics: [2, 3],
    cursorSkill: [2, 3],
    thinkingSpeed: [2, 3],
    caresAboutHouses: 0.2,
    caresAboutBonuses: 0.2,
    bankHugging: 0.8,
  },
  [Archetype.TACTICIAN]: {
    buildSkill: [2, 3],
    spatialAwareness: [3, 3],
    aggressiveness: [2, 2],
    defensiveness: [2, 2],
    battleTactics: [3, 3],
    cursorSkill: [2, 3],
    thinkingSpeed: [2, 3],
    caresAboutHouses: 0.7,
    caresAboutBonuses: 0.7,
    bankHugging: 0.5,
  },
  [Archetype.CHAOTIC]: {
    buildSkill: [1, 1],
    spatialAwareness: [1, 1],
    aggressiveness: [2, 3],
    defensiveness: [1, 2],
    battleTactics: [1, 1],
    cursorSkill: [2, 3],
    thinkingSpeed: [3, 3],
    caresAboutHouses: 0.2,
    caresAboutBonuses: 0.2,
    bankHugging: 0.8,
  },
  [Archetype.BALANCED]: {
    buildSkill: [2, 2],
    spatialAwareness: [2, 2],
    aggressiveness: [2, 2],
    defensiveness: [2, 2],
    battleTactics: [2, 2],
    cursorSkill: [2, 2],
    thinkingSpeed: [2, 2],
    caresAboutHouses: 0.5,
    caresAboutBonuses: 0.5,
    bankHugging: 0.5,
  },
};
const ARCHETYPE_LIST = Object.values(Archetype);

/** Roll an `AiPersonality` from `rng`, honoring difficulty bias.
 *  Difficulty biases trait rolls within archetype ranges:
 *    Easy(0):      lo end minus 1 (floor 1) — noticeably weaker than archetype baseline
 *    Normal(1):    always lo end of range — competent but beatable
 *    Hard(2):      roll uniformly in [lo, hi] — original behavior, varied and strong
 *    Very Hard(3): hi end plus 1 (capped) — exceeds archetype limits */
export function rollPersonality(
  rng: Rng,
  difficulty: number = DIFFICULTY_NORMAL,
): AiPersonality {
  const chosen = rng.pick(ARCHETYPE_LIST);
  const profile = ARCHETYPE_PROFILES[chosen];
  const bias = (range: [number, number], cap: number): number => {
    if (difficulty <= DIFFICULTY_EASY) return Math.max(1, range[0] - 1);
    if (difficulty === DIFFICULTY_NORMAL) return range[0];
    if (difficulty === DIFFICULTY_HARD) return rng.int(...range);
    return Math.min(cap, range[1] + 1); // VERY_HARD or higher
  };
  return {
    archetype: chosen,
    buildSkill: bias(profile.buildSkill, 5) as 1 | 2 | 3 | 4 | 5,
    spatialAwareness: bias(profile.spatialAwareness, 3) as 1 | 2 | 3,
    aggressiveness: bias(profile.aggressiveness, 3) as 1 | 2 | 3,
    defensiveness: bias(profile.defensiveness, 3) as 1 | 2 | 3,
    battleTactics: bias(profile.battleTactics, 3) as 1 | 2 | 3,
    cursorSkill: bias(profile.cursorSkill, 3) as 1 | 2 | 3,
    thinkingSpeed: bias(profile.thinkingSpeed, 3) as 1 | 2 | 3,
    caresAboutHouses: rng.bool(profile.caresAboutHouses),
    caresAboutBonuses: rng.bool(profile.caresAboutBonuses),
    bankHugging: rng.bool(profile.bankHugging),
  };
}
