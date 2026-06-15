/**
 * Seed-condition registry — every drift-sensitive test's seed requirement
 * in one place.
 *
 * Each entry names a condition (e.g. `"upgrade:rapid_fire"`) and declares a
 * `match` function that subscribes to the bus and/or polls `sc.state` to
 * answer "has the condition fired yet?". The `scripts/record-seeds.ts`
 * scanner runs every seed, installs every matcher, and records the first
 * seed that satisfies each condition — all in a single pass.
 *
 * When RNG drifts:
 *
 *     npm run record-seeds
 *
 * rescans and rewrites `test/seed-fixtures.json`. Tests then load via:
 *
 *     const sc = await loadSeed("upgrade:rapid_fire");
 *
 * Adding a new condition
 * ----------------------
 * 1. Pick a unique dotted name: `{subsystem}:{specific-condition}`.
 * 2. Choose `mode` (classic/modern) and a `rounds` budget that gives the
 *    condition enough headroom to fire (10 is a safe default for modern).
 * 3. Write `match` as `(sc) => { install listeners; return () => hasFired }`.
 *    For one-shot events (most of them), latch a closure flag on the listener
 *    and return it in the poller — see the upgrade examples below.
 *
 * Rules
 * -----
 * - `match` must be deterministic: same seed → same poller result.
 * - The poller is invoked by `runUntil`, so keep it cheap (boolean flag read).
 * - Don't mutate `sc.state` — tests should observe, not drive.
 */

import type { ModifierId } from "../src/shared/core/game-constants.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { IMPLEMENTED_MODIFIERS } from "../src/shared/core/modifier-defs.ts";
import {
  IMPLEMENTED_UPGRADES,
  type UpgradeId,
} from "../src/shared/core/upgrade-defs.ts";
import type { Scenario } from "./scenario.ts";

export interface SeedCondition {
  readonly mode: "classic" | "modern";
  readonly rounds: number;
  /** Install listeners / state observers. Returns a polling function that
   *  the scanner calls each tick to check "has the condition fired?". */
  readonly match: (sc: Scenario) => () => boolean;
}

/** Typed name of a registered condition. */
export type SeedConditionName = keyof typeof SEED_CONDITIONS;

/** Default round budget. Most modern-mode conditions fire within 15 rounds; bump
 *  per-entry if a specific condition needs more headroom. */
const DEFAULT_ROUNDS = 15;
/** Every implemented upgrade/modifier is auto-registered as a seed condition
 *  by reading `IMPLEMENTED_UPGRADES` / `IMPLEMENTED_MODIFIERS` from the pool
 *  registries. Flipping `implemented: true` on a pool entry is the only step —
 *  run `npm run record-seeds` to pick up the new condition.
 *
 *  Caveat: a pool entry with `implemented: false` has no seed fixture, so
 *  `loadSeed("upgrade:x")` on an unimplemented id fails at test time rather
 *  than compile time. That's intentional — don't seed what doesn't exist. */
const UPGRADE_CONDITIONS: Record<string, SeedCondition> = Object.fromEntries(
  IMPLEMENTED_UPGRADES.map((def) => [
    `upgrade:${def.id}`,
    {
      mode: "modern",
      rounds: DEFAULT_ROUNDS,
      match: (sc) => latchUpgradePicked(sc, def.id),
    } satisfies SeedCondition,
  ]),
);
const MODIFIER_CONDITIONS: Record<string, SeedCondition> = Object.fromEntries(
  IMPLEMENTED_MODIFIERS.map((def) => [
    `modifier:${def.id}`,
    {
      mode: "modern",
      rounds: DEFAULT_ROUNDS,
      match: (sc) => latchModifierFired(sc, def.id),
    } satisfies SeedCondition,
  ]),
);
export const SEED_CONDITIONS: Readonly<Record<string, SeedCondition>> = {
  ...UPGRADE_CONDITIONS,
  ...MODIFIER_CONDITIONS,
  "modifier:sinkhole_then_high_tide": {
    mode: "modern",
    rounds: DEFAULT_ROUNDS,
    match: (sc) => latchModifierSequence(sc, "sinkhole", "high_tide"),
  },
  // Rubble_clearing only does something visible when there are dead
  // cannons or burning pits to clear. The default `modifier:rubble_clearing`
  // condition latches on the first roll, which can land on an empty
  // round; this variant waits for a roll with at least one held entity
  // so the fade-out test has something to render.
  "modifier:rubble_clearing_nonempty": {
    mode: "modern",
    rounds: DEFAULT_ROUNDS,
    match: (sc) => latchRubbleClearingWithEntities(sc),
  },
  // A reselect cycle: some player lost a life (chose CONTINUE) and is
  // re-picking a castle mid-game. Pins selection-entry behavior that
  // differs from the game-start cycle (the BANNER_SELECT announcement
  // window plays only at game start).
  "selection:reselect-cycle": {
    mode: "classic",
    rounds: DEFAULT_ROUNDS,
    match: (sc) => () =>
      sc.state.phase === Phase.CASTLE_SELECT && sc.state.round > 1,
  },
  // The generic `upgrade:shield_battery` condition latches on the pick alone,
  // which can land on a seed where the first picker's shielded cannon never
  // survives into a BATTLE phase — so the effect-fires step in upgrades.test.ts
  // has nothing to observe. This variant requires the effect to actually
  // manifest (first picker holds a shielded cannon during BATTLE), mirroring
  // that test's probe. Overrides the auto-generated entry above.
  "upgrade:shield_battery": {
    mode: "modern",
    rounds: DEFAULT_ROUNDS,
    match: (sc) => latchShieldBatteryEffective(sc),
  },
  // The generic `modifier:sapper` condition latches on the first sapper roll,
  // which can land on a round where no grunt is targeting a wall — leaving the
  // reveal test with 0 targeted walls to render. This variant requires at least
  // one grunt with a `targetedWall` at apply time, mirroring that test's guard.
  // Overrides the auto-generated entry above.
  "modifier:sapper": {
    mode: "modern",
    rounds: DEFAULT_ROUNDS,
    match: (sc) => latchSapperTargetsWalls(sc),
  },
};

/** Latch a bus event fire behind a closure flag. Returns the poller. */
function latchUpgradePicked(
  sc: Scenario,
  upgradeId: UpgradeId,
): () => boolean {
  let seen = false;
  sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
    if (ev.upgradeId === upgradeId) seen = true;
  });
  return () => seen;
}

/** Latch shield_battery's effect: the first player to pick it later holds a
 *  shielded cannon during a BATTLE phase. Mirrors the effect probe in
 *  upgrades.test.ts so the recorded seed actually exercises the shield, not
 *  just the pick. */
function latchShieldBatteryEffective(sc: Scenario): () => boolean {
  let picker: number | undefined;
  let inBattle = false;
  let seen = false;
  sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
    if (ev.upgradeId === "shield_battery" && picker === undefined) {
      picker = ev.playerId;
    }
  });
  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (ev.phase === Phase.BATTLE) inBattle = true;
  });
  sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
    if (ev.phase === Phase.BATTLE) inBattle = false;
  });
  sc.bus.onAny(() => {
    if (!inBattle || picker === undefined) return;
    if (sc.state.players[picker]?.cannons.some((c) => c.shielded === true)) {
      seen = true;
    }
  });
  return () => seen;
}

/** Latch a modifier firing (any instance of the given id). Subscribes to
 *  `MODIFIER_APPLIED` — the dedicated domain event. The banner no longer
 *  carries modifier metadata (retired with the banner-reveal refactor). */
function latchModifierFired(
  sc: Scenario,
  modifierId: ModifierId,
): () => boolean {
  let seen = false;
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === modifierId) seen = true;
  });
  return () => seen;
}

/** Latch the first `rubble_clearing` apply that has at least one held
 *  entity to clear (otherwise the fade-out has nothing to render).
 *  `MODIFIER_APPLIED` now fires AFTER `applyBattleStartModifiers`, so
 *  `state.modern.rubbleClearingHeld` is populated at event time. */
function latchRubbleClearingWithEntities(sc: Scenario): () => boolean {
  let seen = false;
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId !== "rubble_clearing") return;
    const held = sc.state.modern?.rubbleClearingHeld;
    if (held && held.pits.length + held.deadCannons.length > 0) seen = true;
  });
  return () => seen;
}

/** Latch the first `sapper` apply where at least one grunt is targeting a
 *  wall (`targetedWall` set) — otherwise the reveal has no walls to pulse.
 *  Mirrors `sapperImpl.apply`, which marks exactly those grunts' walls. */
function latchSapperTargetsWalls(sc: Scenario): () => boolean {
  let seen = false;
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId !== "sapper") return;
    if (sc.state.grunts.some((grunt) => grunt.targetedWall !== undefined)) {
      seen = true;
    }
  });
  return () => seen;
}

/** Latch a modifier sequence: `first` fires, then `second` fires after. */
function latchModifierSequence(
  sc: Scenario,
  first: ModifierId,
  second: ModifierId,
): () => boolean {
  let sawFirst = false;
  let sawSecond = false;
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === first) sawFirst = true;
    else if (ev.modifierId === second && sawFirst) sawSecond = true;
  });
  return () => sawSecond;
}
