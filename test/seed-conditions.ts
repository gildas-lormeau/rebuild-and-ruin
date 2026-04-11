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

import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { UpgradeId } from "../src/shared/core/upgrade-defs.ts";
import type { Scenario } from "./scenario.ts";

export interface SeedCondition {
  readonly mode: "classic" | "modern";
  readonly rounds: number;
  /** Install listeners / state observers. Returns a polling function that
   *  the scanner calls each tick to check "has the condition fired?". */
  readonly match: (sc: Scenario) => () => boolean;
}

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

/** Every implemented upgrade as a seed condition.
 *  Adding a new upgrade? Add one line here and run `npm run record-seeds`. */
const UPGRADE_CONDITIONS: Record<string, SeedCondition> = Object.fromEntries(
  (
    [
      "mortar",
      "rapid_fire",
      "ricochet",
      "shield_battery",
      "reinforced_walls",
      "master_builder",
      "small_pieces",
      "double_time",
      "architect",
      "foundations",
      "reclamation",
      "territorial_ambition",
      "conscription",
      "salvage",
      "ceasefire",
      "supply_drop",
      "second_wind",
      "demolition",
      "clear_the_field",
    ] satisfies readonly UpgradeId[]
  ).map((upgradeId) => [
    `upgrade:${upgradeId}`,
    {
      mode: "modern",
      rounds: 10,
      match: (sc) => latchUpgradePicked(sc, upgradeId),
    } satisfies SeedCondition,
  ]),
);

export const SEED_CONDITIONS: Readonly<Record<string, SeedCondition>> = {
  ...UPGRADE_CONDITIONS,
  // Future conditions (modifiers, battle states, input scenarios) land here.
};

/** Typed name of a registered condition. */
export type SeedConditionName = keyof typeof SEED_CONDITIONS;
