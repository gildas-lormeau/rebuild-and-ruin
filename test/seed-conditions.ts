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
 *  `MODIFIER_APPLIED` fires at modifier-roll time, BEFORE
 *  `applyBattleStartModifiers` populates `rubbleClearingHeld`, so we
 *  poll the next TICK for the populated snapshot. */
function latchRubbleClearingWithEntities(sc: Scenario): () => boolean {
  let pendingCheck = false;
  let seen = false;
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "rubble_clearing") pendingCheck = true;
  });
  sc.bus.on(GAME_EVENT.TICK, () => {
    if (!pendingCheck || seen) return;
    const held = sc.state.modern?.rubbleClearingHeld;
    if (held && held.pits.length + held.deadCannons.length > 0) seen = true;
    pendingCheck = false;
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
