/**
 * Battle-metrics observer — subscribes to a scenario's event bus + the
 * per-frame TICK event + the AI fire-decision diag hook, and accumulates one
 * structured metrics row per (battle, player). It does NOT score — it tracks
 * raw quantities, grouped so a downstream report can look at them per axis
 * (shot economy, offense, defense, crosshair). See the project memory
 * `project_battle_metrics_tracking` for the catalog and rationale.
 *
 * Two complementary tracks per battle row:
 *   - per-shot intent/aim: classify each CANNON_FIRED's impact tile + tag the
 *     AI's FireOrigin (charity / super_attack / … now distinct) + flight
 *     distance & time (the distance confound).
 *   - per-impact results: WALL_DESTROYED / CANNON_DAMAGED→0 / GRUNT_KILLED /
 *     TOWER_KILLED, shooter-attributed (splash/ricochet correct), with grunt
 *     kills split own-zone (defense) vs enemy-zone (charity — helps opponent).
 *
 * All-AI pool games only: every shot triggers the diag hook, so origin counts
 * are complete. Human shots would not emit a FireOrigin.
 */

import { setAiBattleDiagHook } from "../src/ai/ai-battle-diag.ts";
import { BATTLE_MESSAGE } from "../src/shared/core/battle-events.ts";
import {
  GAME_EVENT,
  type GameEventMap,
} from "../src/shared/core/game-event-bus.ts";
import type { TileKey } from "../src/shared/core/grid.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { isPlayerEliminated } from "../src/shared/core/player-types.ts";
import { packTile, zoneOwnerIdAt } from "../src/shared/core/spatial.ts";
import { IMPACT, type ImpactKind, classifyImpact } from "./impact-classify.ts";
import type { Scenario } from "./scenario.ts";

export interface PlayerBattleMetrics {
  round: number;
  playerId: number;
  /** Shots fired (CANNON_FIRED where this player is the scoring shooter). */
  shots: number;
  /** Impact-tile classification at fire time — what the AI aimed at. */
  outcome: Record<ImpactKind, number>;
  /** AI FireOrigin tag per shot (charity / super_attack / focus_fire / …). */
  origin: Record<string, number>;
  /** Sum of cannon→target flight distance (px) and flight time (s) over shots
   *  — the distance confound covariate; per-shot avg = sum / shots. */
  flightDistSumPx: number;
  flightTimeSum: number;
  // --- actual results (shooter-attributed, splash/ricochet correct) ---
  enemyWallsDestroyed: number;
  /** Self-fire wall hits — cleanup (pocket/ice-trench), NOT waste. */
  ownWallsDestroyed: number;
  enemyCannonsKilled: number;
  /** Grunt kills in the shooter's OWN zone — defends own towers. */
  gruntKillsOwnZone: number;
  /** Grunt kills in an ENEMY zone — "charity", removes a threat to the
   *  zone-owner's towers (helps the opponent). Anti-pattern. */
  gruntKillsEnemyZone: number;
  /** This player's towers destroyed by grunts during the battle (defense
   *  failure). Attributed to the tower owner, not a shooter. */
  ownTowersLostToGrunts: number;
  /** Shots whose impact tile is an enemy-zone house — house-offense intent
   *  (the only cannon path to enemy towers, via spawned grunts). MEASURED,
   *  not rewarded (per project decision). */
  enemyHouseShots: number;
  /** Redundant shots: another in-flight ball from this shooter already
   *  targeted the same impact tile (over-commit / focus-fire overshoot). */
  dupShots: number;
  /** Burning pits created in THIS player's zone during the battle — terrain-
   *  denial burden (blocks their next build/cannon placement). Attributed to
   *  the zone owner (PIT_CREATED carries no shooter). */
  pitsInOwnZone: number;
  // --- cross-round build tax (the closing WALL_BUILD after this battle) ---
  /** Wall tiles this player placed next build that REFILL tiles destroyed in
   *  this battle — forced repair work (cross-round tempo tax suffered). */
  repairTilesPlaced: number;
  /** Wall tiles placed next build on fresh tiles — territory expansion. Low
   *  expansion + high repair = the battle taxed this player's build. */
  expansionTilesPlaced: number;
  /** Tiles destroyed this battle that were NOT re-placed by the end of the
   *  closing WALL_BUILD — repair the player couldn't/didn't finish (with
   *  repairTilesPlaced these sum to walls destroyed this round). The
   *  build-budget-exhaustion / "couldn't fix the damage" signal. Counts
   *  exact-tile non-refills: a player who re-encloses via a different wall
   *  route still shows the original holes here. */
  unrepairedGaps: number;
  // --- crosshair (per-frame TICK, after the countdown orbit) ---
  crosshairTravelPx: number;
  crosshairSamples: number;
}

export interface BattleMetricsObserver {
  /** One row per (battle, non-eliminated player), in battle order. */
  readonly battles: readonly PlayerBattleMetrics[];
  attach(sc: Scenario): void;
  detach(): void;
}

export function createBattleMetricsObserver(): BattleMetricsObserver {
  const battles: PlayerBattleMetrics[] = [];
  const subscriptions: Array<() => void> = [];
  let attached = false;

  /** Active battle's per-player rows, keyed by playerId. Rebuilt each BATTLE. */
  const current = new Map<number, PlayerBattleMetrics>();
  /** Last crosshair pixel position per player, for travel deltas. */
  const crosshairLast = new Map<number, { x: number; y: number }>();
  /** Wall tiles destroyed this round per victim (cannon OR grunt) — consumed
   *  by the next WALL_BUILD to split repair vs expansion. Cleared each battle. */
  const destroyedThisRound = new Map<number, Set<TileKey>>();
  /** Shooter of the most recent CANNON_FIRED — the diag hook fires synchronously
   *  right after with no intervening events, so this attributes its origin. */
  let lastShooter: number | undefined;

  function on<K extends keyof GameEventMap>(
    sc: Scenario,
    eventType: K,
    handler: (ev: GameEventMap[K]) => void,
  ): void {
    sc.bus.on(eventType, handler);
    subscriptions.push(() => sc.bus.off(eventType, handler));
  }

  return {
    get battles() {
      return battles;
    },

    attach(sc) {
      if (attached) throw new Error("battle-metrics observer already attached");
      attached = true;

      on(sc, GAME_EVENT.PHASE_START, (ev) => {
        if (ev.phase !== Phase.BATTLE) return;
        current.clear();
        crosshairLast.clear();
        destroyedThisRound.clear();
        lastShooter = undefined;
        for (let pid = 0; pid < sc.state.players.length; pid++) {
          const player = sc.state.players[pid];
          if (!player || isPlayerEliminated(player)) continue;
          const row = emptyRow(ev.round, pid);
          battles.push(row);
          current.set(pid, row);
        }
      });

      on(sc, BATTLE_MESSAGE.CANNON_FIRED, (ev) => {
        const shooter = ev.scoringPlayerId ?? ev.playerId;
        const row = current.get(shooter);
        if (!row) return;
        row.shots++;
        const info = classifyImpact(sc.state, ev.impactRow, ev.impactCol, shooter);
        row.outcome[info.kind]++;
        row.flightDistSumPx += Math.hypot(
          ev.impactX - ev.launchX,
          ev.impactY - ev.launchY,
        );
        row.flightTimeSum += ev.flightTime;
        // Over-commit: another in-flight ball from this shooter already targets
        // this tile (this fire is already pushed onto cannonballs, so >= 2).
        const sameTile = sc.state.cannonballs.filter(
          (ball) =>
            (ball.scoringPlayerId ?? ball.playerId) === shooter &&
            ball.impactRow === ev.impactRow &&
            ball.impactCol === ev.impactCol,
        ).length;
        if (sameTile >= 2) row.dupShots++;
        // House-offense intent: aimed at a house in an enemy zone.
        if (info.kind === IMPACT.HOUSE) {
          const zoneOwner = zoneOwnerIdAt(sc.state, ev.impactRow, ev.impactCol);
          if (zoneOwner !== shooter) row.enemyHouseShots++;
        }
        lastShooter = shooter;
      });

      on(sc, BATTLE_MESSAGE.WALL_DESTROYED, (ev) => {
        // Repair-burden tracking: EVERY destroyed wall (cannon OR grunt) is a
        // tile the owner may re-place next build. Accumulate per victim.
        const destroyed =
          destroyedThisRound.get(ev.playerId) ?? new Set<TileKey>();
        destroyed.add(packTile(ev.row, ev.col));
        destroyedThisRound.set(ev.playerId, destroyed);
        // Offense attribution (cannon shots only; grunt melee has no shooter).
        if (ev.shooterId === undefined) return;
        const row = current.get(ev.shooterId);
        if (!row) return;
        if (ev.shooterId === ev.playerId) row.ownWallsDestroyed++;
        else row.enemyWallsDestroyed++;
      });

      on(sc, BATTLE_MESSAGE.PIT_CREATED, (ev) => {
        // Pit lands in some zone; that zone's owner suffers the build/cannon
        // blockage. PIT_CREATED carries no shooter, so attribute to the victim.
        const row = current.get(zoneOwnerIdAt(sc.state, ev.row, ev.col));
        if (!row) return;
        row.pitsInOwnZone++;
      });

      on(sc, GAME_EVENT.WALL_PLACED, (ev) => {
        // Only the closing WALL_BUILD repairs battle damage. `current` still
        // holds this round's rows (cleared only at the next BATTLE start).
        if (sc.state.phase !== Phase.WALL_BUILD) return;
        const row = current.get(ev.playerId);
        if (!row) return;
        const destroyed = destroyedThisRound.get(ev.playerId);
        for (const tile of ev.tileKeys) {
          if (destroyed?.has(tile)) {
            row.repairTilesPlaced++;
            destroyed.delete(tile);
          } else {
            row.expansionTilesPlaced++;
          }
        }
      });

      on(sc, GAME_EVENT.ROUND_END, () => {
        // Closing WALL_BUILD is done; whatever destroyed tiles remain unrepaired
        // are this round's gaps. `current` still holds this round's rows (the
        // next BATTLE clears it), so attribute before that reset.
        for (const [pid, row] of current) {
          row.unrepairedGaps = destroyedThisRound.get(pid)?.size ?? 0;
        }
      });

      on(sc, BATTLE_MESSAGE.CANNON_DAMAGED, (ev) => {
        if (ev.newHp > 0 || ev.shooterId === undefined) return;
        if (ev.shooterId === ev.playerId) return; // self-destroyed cannon: skip
        const row = current.get(ev.shooterId);
        if (!row) return;
        row.enemyCannonsKilled++;
      });

      on(sc, BATTLE_MESSAGE.GRUNT_KILLED, (ev) => {
        if (ev.shooterId === undefined) return;
        const row = current.get(ev.shooterId);
        if (!row) return;
        const zoneOwner = zoneOwnerIdAt(sc.state, ev.row, ev.col);
        if (zoneOwner === ev.shooterId) row.gruntKillsOwnZone++;
        else row.gruntKillsEnemyZone++;
      });

      on(sc, BATTLE_MESSAGE.TOWER_KILLED, (ev) => {
        if (ev.playerId === undefined) return;
        const row = current.get(ev.playerId);
        if (!row) return;
        row.ownTowersLostToGrunts++;
      });

      on(sc, GAME_EVENT.TICK, () => {
        if (sc.state.phase !== Phase.BATTLE) return;
        if (sc.state.battleCountdown > 0) return; // skip Ready/Aim orbit motion
        const crosshairs = sc.overlay().battle?.crosshairs ?? [];
        for (const crosshair of crosshairs) {
          const row = current.get(crosshair.playerId);
          if (!row) continue;
          const last = crosshairLast.get(crosshair.playerId);
          if (last) {
            row.crosshairTravelPx += Math.hypot(
              crosshair.x - last.x,
              crosshair.y - last.y,
            );
          }
          crosshairLast.set(crosshair.playerId, {
            x: crosshair.x,
            y: crosshair.y,
          });
          row.crosshairSamples++;
        }
      });

      // AI fire-decision diag — fires synchronously after CANNON_FIRED with no
      // intervening events, so `lastShooter` is the matching shot's shooter.
      setAiBattleDiagHook((ev) => {
        if (lastShooter === undefined) return;
        const row = current.get(lastShooter);
        if (!row) return;
        row.origin[ev.origin] = (row.origin[ev.origin] ?? 0) + 1;
      });
      subscriptions.push(() => setAiBattleDiagHook(undefined));
    },

    detach() {
      for (const off of subscriptions) off();
      subscriptions.length = 0;
      current.clear();
      crosshairLast.clear();
      attached = false;
    },
  };
}

function emptyRow(round: number, playerId: number): PlayerBattleMetrics {
  const outcome = {} as Record<ImpactKind, number>;
  for (const kind of Object.values(IMPACT)) outcome[kind] = 0;
  return {
    round,
    playerId,
    shots: 0,
    outcome,
    origin: {},
    flightDistSumPx: 0,
    flightTimeSum: 0,
    enemyWallsDestroyed: 0,
    ownWallsDestroyed: 0,
    enemyCannonsKilled: 0,
    gruntKillsOwnZone: 0,
    gruntKillsEnemyZone: 0,
    ownTowersLostToGrunts: 0,
    enemyHouseShots: 0,
    dupShots: 0,
    pitsInOwnZone: 0,
    repairTilesPlaced: 0,
    expansionTilesPlaced: 0,
    unrepairedGaps: 0,
    crosshairTravelPx: 0,
    crosshairSamples: 0,
  };
}
