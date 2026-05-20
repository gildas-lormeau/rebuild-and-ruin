/**
 * AI upgrade-pick: per-entry auto-resolve tick + contextual decision heuristic.
 * Determinism: `precomputeAiUpgradePicks` runs at `battle-done.mutate` so the
 * `state.rng.next()` fallback inside `aiPickUpgrade` is drawn once per peer in
 * lockstep — lazy draws in the dialog tick would drift across peers because
 * `shouldAutoResolve` is asymmetric (host skips remote slots, non-host skips
 * its own). Dialog tick reads `state.modern.precomputedUpgradePicks`.
 */

import { deriveAiStrategySeed } from "../shared/core/ai-seed.ts";
import { isBalloonCannon, isCannonAlive } from "../shared/core/battle-types.ts";
import { GRID_COLS, GRID_ROWS } from "../shared/core/grid.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { zoneAt } from "../shared/core/spatial.ts";
import type { UpgradePickViewState } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { UID, type UpgradeId } from "../shared/core/upgrade-defs.ts";
import { Rng } from "../shared/platform/rng.ts";
import type { UpgradePickEntry } from "../shared/ui/interaction-types.ts";
import { secondsToTicks } from "./ai-utils.ts";

const SMALL_PIECES_TERRITORY_RATIO = 0.8;
/** Extra delay per auto-resolving entry (by entry index) so AI picks land
 *  one at a time instead of all snapping on the same frame (ticks). */
const UPGRADE_PICK_STAGGER = secondsToTicks(0.5);
/** Ticks between focus "steps" while an AI entry cycles through its offers
 *  during the delay. */
const UPGRADE_PICK_CYCLE_STEP = secondsToTicks(0.22);
/** Window at the end of the delay where the AI stops cycling and locks
 *  focus onto its final pick, so the reveal isn't a random-looking snap (ticks). */
const UPGRADE_PICK_LOCK_IN = secondsToTicks(0.35);

/** Per-frame auto-resolve tick for one upgrade-pick dialog entry.
 *  Called by `game/upgrade-pick.ts` via an injected callback (the game
 *  layer may not import ai/, so the runtime/entry wiring closes over state
 *  and passes this function down).
 *
 *  Phases of the animation:
 *    1. Cycling — focus steps through offers while autoTimer < lockInStart.
 *    2. Lock-in — points focusedCard at the eventual pick (from
 *                 precomputedUpgradePicks, idempotent) for the final
 *                 LOCK_IN window.
 *    3. Commit — applies the pick to entry.choice, records pickedAtTimer. */
export function tickAiUpgradePickEntry(
  entry: UpgradePickEntry,
  entryIdx: number,
  autoDelayTicks: number,
  dialogTimer: number,
  state: UpgradePickViewState,
): void {
  entry.autoTimer++;
  const effectiveDelay = autoDelayTicks + entryIdx * UPGRADE_PICK_STAGGER;
  // Clamp at 0 so shrinking autoDelay below LOCK_IN doesn't produce a
  // negative window that silently skips the cycling phase.
  const lockInStart = Math.max(0, effectiveDelay - UPGRADE_PICK_LOCK_IN);

  if (entry.autoTimer >= effectiveDelay) {
    const pick = resolveAiPick(entry, state, true);
    entry.choice = pick;
    entry.focusedCard = entry.offers.indexOf(pick);
    entry.pickedAtTimer = dialogTimer;
    return;
  }

  if (entry.autoTimer >= lockInStart) {
    entry.focusedCard = entry.offers.indexOf(
      resolveAiPick(entry, state, false),
    );
    return;
  }

  const len = entry.offers.length;
  const dir = (entry.playerId & 1) === 0 ? 1 : -1;
  const start = entryIdx % len;
  const cycleStep = UPGRADE_PICK_CYCLE_STEP * (1 + (entryIdx % 3) * 0.17);
  const rawStep = Math.floor(entry.autoTimer / cycleStep);
  entry.focusedCard = (((start + dir * rawStep) % len) + len) % len;
}

/** Precompute every alive player's AI upgrade pick at battle-done.mutate,
 *  right after `prepareNextRound` populated `pendingUpgradeOffers`. Anchors
 *  every `state.rng.next()` draw to a deterministic state-mutation point
 *  that runs identically on every peer — see file header for why the lazy
 *  per-tick draw was peer-asymmetric.
 *
 *  No-op when not in modern mode or before UPGRADE_FIRST_ROUND (offers
 *  would be null in those cases). */
export function precomputeAiUpgradePicks(state: GameState): void {
  const offers = state.modern?.pendingUpgradeOffers;
  if (!offers) return;
  const picks = new Map<ValidPlayerId, UpgradeId>();
  for (const [playerId, playerOffers] of offers) {
    picks.set(playerId, aiPickUpgrade(playerOffers, state, playerId));
  }
  state.modern!.precomputedUpgradePicks = picks;
}

/** Resolve the AI's pick for a pending entry — prefers the deterministic
 *  precomputed value (drawn from `state.rng` at battle-done.mutate), falls
 *  back to a fresh `aiPickUpgrade` call if precompute didn't run (unit
 *  tests that build the dialog without going through battle-done).
 *
 *  Parity hazard: the fallback draws from `state.rng` lazily and
 *  asymmetrically (only AI slots whose precompute slot is missing draw),
 *  so an online peer hitting this path mid-match would drift. The
 *  `warnIfMissing` flag — set only on the commit tick — surfaces the
 *  drift in dev / test output without spamming once-per-frame through
 *  the lock-in window. Any production hit indicates a missing
 *  precompute call site to fix. */
function resolveAiPick(
  entry: UpgradePickEntry,
  state: UpgradePickViewState,
  warnIfMissing: boolean,
): UpgradeId {
  const precomputed = state.modern?.precomputedUpgradePicks?.get(
    entry.playerId,
  );
  if (precomputed !== undefined) return precomputed;
  if (warnIfMissing) {
    console.warn(
      `ai-upgrade-pick: precomputedUpgradePicks missing for player ${entry.playerId} — falling back to state.rng draw (parity hazard in multiplayer)`,
    );
  }
  return aiPickUpgrade(entry.offers, state, entry.playerId);
}

/** AI-aware pick: contextual upgrade selection based on game state.
 *  File-local — invoked by `precomputeAiUpgradePicks` (deterministic,
 *  battle-done anchor) and by `resolveAiPick` as a defensive fallback. */
function aiPickUpgrade(
  offers: readonly [UpgradeId, UpgradeId, UpgradeId],
  state: UpgradePickViewState,
  playerId: ValidPlayerId,
): UpgradeId {
  const hasDeadTowers = playerHasDeadTowers(state, playerId);
  if (hasDeadTowers && offers.includes(UID.SECOND_WIND)) {
    return UID.SECOND_WIND;
  }
  const hasGruntsInZone = anyEntityInPlayerZone(state, playerId, state.grunts);
  if (hasGruntsInZone && offers.includes(UID.CLEAR_THE_FIELD)) {
    return UID.CLEAR_THE_FIELD;
  }
  const hasPits = anyEntityInPlayerZone(state, playerId, state.burningPits);
  if (hasPits && offers.includes(UID.FOUNDATIONS)) {
    return UID.FOUNDATIONS;
  }
  const hasDeadCannons = playerHasDeadCannons(state, playerId);
  if (hasDeadCannons && offers.includes(UID.RECLAMATION)) {
    return UID.RECLAMATION;
  }
  // Mortar is strong when player has few cannons (catch-up mechanic)
  if (offers.includes(UID.MORTAR) && playerCannonCount(state, playerId) <= 3) {
    return UID.MORTAR;
  }
  const largeTerritory =
    playerTerritoryRatio(state, playerId) >= SMALL_PIECES_TERRITORY_RATIO;
  if (largeTerritory && offers.includes(UID.SMALL_PIECES)) {
    return UID.SMALL_PIECES;
  }
  // Exclude contextual upgrades when conditions aren't met
  const excluded = new Set<UpgradeId>();
  if (!hasDeadTowers) excluded.add(UID.SECOND_WIND);
  if (!hasGruntsInZone) excluded.add(UID.CLEAR_THE_FIELD);
  if (!hasPits) excluded.add(UID.FOUNDATIONS);
  if (!hasDeadCannons) excluded.add(UID.RECLAMATION);
  if (!largeTerritory) excluded.add(UID.SMALL_PIECES);
  // Demolition: exclude when AI has thin walls (nothing to gain from stripping)
  if (!playerHasThickWalls(state, playerId)) excluded.add(UID.DEMOLITION);
  const viable = offers.filter((id) => !excluded.has(id));
  const pool = viable.length > 0 ? viable : offers;
  const pickRng = new Rng(
    // lint:allow-state-rng -- reading state.rng.seed (immutable constructor
    // seed, not a draw) to derive a private Rng. The derived seed depends
    // only on (baseSeed, round, slot), so every peer arrives at the same
    // private Rng for the same slot without advancing state.rng.
    deriveAiStrategySeed(state.rng.seed, state.round, playerId),
  );
  return pool[Math.floor(pickRng.next() * pool.length)]!;
}

function playerTerritoryRatio(
  state: UpgradePickViewState,
  playerId: ValidPlayerId,
): number {
  const player = state.players[playerId];
  if (!player?.homeTower) return 0;
  const interior = getInterior(player);
  if (interior.size === 0) return 0;
  const zone = player.homeTower.zone;
  let zoneGrassCount = 0;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (zoneAt(state.map, row, col) === zone) zoneGrassCount++;
    }
  }
  return zoneGrassCount > 0 ? interior.size / zoneGrassCount : 0;
}

function playerHasDeadTowers(
  state: UpgradePickViewState,
  playerId: ValidPlayerId,
): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  return player.ownedTowers.some((tower) => !state.towerAlive[tower.index]);
}

function anyEntityInPlayerZone(
  state: UpgradePickViewState,
  playerId: ValidPlayerId,
  entities: readonly { row: number; col: number }[],
): boolean {
  const player = state.players[playerId];
  if (!player?.homeTower) return false;
  const zone = player.homeTower.zone;
  return entities.some((e) => zoneAt(state.map, e.row, e.col) === zone);
}

function playerHasDeadCannons(
  state: UpgradePickViewState,
  playerId: ValidPlayerId,
): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  return player.cannons.some((cannon) => cannon.hp <= 0);
}

/** True if the player has many non-load-bearing (inner) walls — Demolition would hurt them. */
function playerHasThickWalls(
  state: UpgradePickViewState,
  playerId: ValidPlayerId,
): boolean {
  const player = state.players[playerId];
  if (!player || player.walls.size === 0) return false;
  // Rough heuristic: if walls outnumber interior tiles, walls are thick
  return player.walls.size > getInterior(player).size;
}

function playerCannonCount(
  state: UpgradePickViewState,
  playerId: ValidPlayerId,
): number {
  const player = state.players[playerId];
  if (!player) return 0;
  return player.cannons.filter(
    (cannon) => isCannonAlive(cannon) && !isBalloonCannon(cannon),
  ).length;
}
