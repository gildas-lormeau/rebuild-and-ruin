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
import { canFireOwnCannon } from "../src/game/index.ts";
import {
  aliveCannons,
  isBalloonCannon,
} from "../src/shared/core/battle-types.ts";
import { BATTLE_MESSAGE } from "../src/shared/core/battle-events.ts";
import { getBattleInterior } from "../src/shared/sim/board-occupancy.ts";
import type { CannonIdx } from "../src/shared/core/geometry-types.ts";
import {
  GAME_EVENT,
  type GameEventMap,
} from "../src/shared/core/game-event-bus.ts";
import type { TileKey } from "../src/shared/core/grid.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { isPlayerEliminated, type ValidPlayerId } from "../src/shared/core/player-slot.ts";
import {
  type Player,
} from "../src/shared/core/player-types.ts";
import {
  computeOutside,
  computeOutsideAfterAdd,
  computeTrappedAfterAdd,
  DIRS_8,
  forEachTowerTile,
  inBounds,
  packTile,
  unpackTile,
  zoneOwnerIdAt,
} from "../src/shared/core/spatial.ts";
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
  /** pickTarget sub-branch per standard (non-chain) shot (enclosure_contig /
   *  enclosure_jump / fresh_cannon / priority_cannon / strategic / …). Resolves
   *  WHERE the default/focus_fire shots came from — the scatter-source axis. */
  pickPath: Record<string, number>;
  /** Sum of inter-shot tile-jump attributed to the CURRENT shot's pickPath, and
   *  the pair count — mean = how far each sub-branch jumps from the prior shot.
   *  Isolates which branches scatter (high jump) vs concentrate (low jump). */
  pickPathJumpSum: Record<string, number>;
  pickPathJumpPairs: Record<string, number>;
  /** Sum of cannon→target flight distance (px) and flight time (s) over shots
   *  — the distance confound covariate; per-shot avg = sum / shots. */
  flightDistSumPx: number;
  flightTimeSum: number;
  // --- actual results (shooter-attributed, splash/ricochet correct) ---
  enemyWallsDestroyed: number;
  /** Self-fire wall hits — cleanup (pocket/ice-trench), NOT waste. */
  ownWallsDestroyed: number;
  enemyCannonsKilled: number;
  // --- per-shot enclosure-breach quality (enemy-wall cannon hits only) ---
  // Each enemy-wall hit is classified by its effect on the victim's BREACH
  // DISTANCE — the minimum walls still separating the sealed interior it
  // borders from the map boundary (min wall-count 8-path). Distance → 0 =
  // breaching; distance decreased but > 0 = progress; distance unchanged =
  // useless. Evaluated per-hit at the moment it lands, so multi-shot drilling
  // (two holes made at different moments) is credited as progress step-by-step,
  // not lumped into useless.
  /** Hits that dropped breach distance to 0 — the interior now leaks. */
  enemyWallsBreaching: number;
  /** Hits that REDUCED breach distance but left it > 0 — a necessary drilling
   *  step toward a breach (e.g. the first tile of a 2-thick barrier). */
  enemyWallsProgress: number;
  /** Hits that left breach distance UNCHANGED — genuinely wasted: a redundant
   *  parallel layer the min-cut doesn't pass through, or a wall sealing no live
   *  interior (already-open ring / stray wall). The "useless hit" axis. */
  enemyWallsUseless: number;
  /** The three buckets split by the firing shot's FireOrigin (deny_enclosure /
   *  structural / default / …) — shows which tactic wastes fire. Origin is
   *  resolved per (shooter, cannon) from the diag hook; "unknown" when the
   *  shot's origin wasn't captured. */
  wallBreachByOrigin: Record<string, number>;
  wallProgressByOrigin: Record<string, number>;
  wallUselessByOrigin: Record<string, number>;
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
  // --- attack effectiveness: were the unrepaired gaps NEEDED walls? ---
  /** Of `unrepairedGaps`, the tiles still LOAD-BEARING for an enclosure against
   *  the FINAL build board (classifyHit breaching/progress) — re-placing one
   *  would help re-seal a leaking ring. These are walls the victim NEEDED but
   *  couldn't/didn't rebuild: the real "effective attack" signal. Survivors
   *  only (a life-loser's zone is reset before this is measured). */
  unrepairedLoadBearing: number;
  /** Of `unrepairedGaps`, the tiles NOT needed for any enclosure at end-of-build
   *  (classifyHit useless) — future-interior / redundant walls the victim
   *  CORRECTLY left unbuilt. NOT an effective attack, even though "unrepaired". */
  unrepairedInner: number;
  /** 1 if this player lost a life closing this round (no enclosed alive tower →
   *  zone reset) — the maximal "couldn't hold the enclosure" outcome. Its zone
   *  is reset before the gap split runs, so its gaps aren't classified; this
   *  flag carries the effectiveness signal instead. */
  lifeLostThisRound: number;
  // --- battle decisiveness (victim-side: breach severity suffered) ---
  /** Enclosed-interior tile count at BATTLE start vs at battle end (first
   *  non-BATTLE phase, pre-repair). start − end = interior lost to breaches
   *  this battle — the territory-shrink signal that fires even when no tower
   *  dies (the dominant case). The missing "did fire actually breach?" axis. */
  interiorAtStart: number;
  interiorAtEnd: number;
  /** Enclosed-tower count at start vs battle end. start − end = towers knocked
   *  OUT of enclosure by a breach (still alive, but no longer scoring/firing)
   *  — distinct from `ownTowersLostToGrunts` (towers actually killed). */
  enclosedTowersAtStart: number;
  enclosedTowersAtEnd: number;
  // --- cannon utilization / firing cadence ---
  /** Alive, non-balloon cannons at battle start regardless of enclosure — the
   *  raw "how many cannons do I own" axis. owned − usable = cannons that can't
   *  fire because they're not enclosed (an enclosure problem, not a firing one). */
  ownedCannonsAtStart: number;
  /** Cannons that COULD fire at battle start (alive + enclosed + not captured)
   *  — the "how many cannons" axis. With one serial crosshair the player fires
   *  ~one cannon per ~1.5s cycle regardless of this; surplus cannons buy
   *  uninterrupted cadence (always a fresh one ready), not parallel volume. */
  usableCannonsAtStart: number;
  /** Distinct cannon indices that fired ≥1 shot this battle. usable − distinct
   *  = cannons that never fired (idle offense capacity). */
  distinctCannonsFired: number;
  /** Sum over shots of the shooter's ready-cannon count IMMEDIATELY AFTER each
   *  fire (the just-fired cannon is mid-flight, so this is the headroom for the
   *  NEXT cycle). Mean = spam headroom: ≫0 means many cannons keep the player
   *  firing every crosshair cycle; ≈0 means the next shot must wait on a ball
   *  to land (reload-throttled — only happens with few cannons). */
  readyAfterFireSum: number;
  /** Shots after which NO cannon was ready (headroom 0) — the player is
   *  reload-throttled below the crosshair-cycle cadence. stallShots / shots =
   *  the fraction of fire that hit the per-cannon in-flight limit. */
  stallShots: number;
  // --- pressure / spectacle (the "boring AI" regression axis) ---
  /** Longest run of consecutive shots this battle aimed at enemy-directed
   *  targets (enemy walls / enemy cannons). Housekeeping shots (own walls,
   *  grunts, grass) break the run. The sustained-visible-aggression signal —
   *  the May-era AI hammered "dozens of walls in a row"; surgical tactics
   *  read as passive because this collapses even when per-shot quality rises. */
  enemyStreakMax: number;
  /** Shots fired BY enemies that impacted in this player's zone — victim-side
   *  incoming pressure ("how hammered does this player feel"). Low values =
   *  the player is left alone (e.g. not picked as anyone's battle victim). */
  incomingShots: number;
  // --- fire concentration (consecutive-shot target spread) ---
  /** Sum of tile-distance between each shot's impact tile and the previous
   *  shot's, over `interShotPairs` consecutive pairs. mean = how far the AI
   *  jumps between shots: low = concentrated fire (cheap crosshair travel,
   *  damage stacks toward a breach), high = scatter across the fortress. */
  interShotDistSum: number;
  interShotPairs: number;
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
  /** Distinct cannon indices fired per shooter this battle — collapsed into
   *  `row.distinctCannonsFired` on every fire. Cleared each battle. */
  const firedCannons = new Map<number, Set<number>>();
  /** Last shot's impact tile per shooter — for consecutive-shot concentration. */
  const lastShotTile = new Map<number, { row: number; col: number }>();
  /** Running enemy-directed streak per shooter — collapsed into
   *  `row.enemyStreakMax`. Cleared each battle. */
  const enemyStreak = new Map<number, number>();
  /** Inter-shot jump computed for the just-fired shot per shooter (undefined if
   *  it was the first shot). Consumed by the diag hook — which fires right after
   *  CANNON_FIRED — to attribute the jump to that shot's pickPath. */
  const lastJump = new Map<number, number | undefined>();
  /** Guards the post-battle interior/enclosure snapshot so only the FIRST
   *  non-BATTLE phase after a battle captures it (pre-repair). */
  let battleEndCaptured = false;
  /** Shooter of the most recent CANNON_FIRED — the diag hook fires synchronously
   *  right after with no intervening events, so this attributes its origin. */
  let lastShooter: number | undefined;
  /** Cannon index of the most recent CANNON_FIRED — paired with `lastShooter`
   *  in the diag hook to key `shotOriginByCannon`. */
  let lastCannonIdx: number | undefined;
  /** FireOrigin of each cannon's most recent shot, keyed `${shooter}:${idx}`.
   *  A cannon can't fire again until its ball lands (the WALL_DESTROYED below),
   *  so at destruction time this holds the origin of the destroying shot.
   *  Cleared each battle. */
  const shotOriginByCannon = new Map<string, string>();

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
        if (ev.phase !== Phase.BATTLE) {
          // First non-BATTLE phase after a battle: snapshot post-battle,
          // pre-repair interior/enclosure (UPGRADE_PICK or WALL_BUILD comes
          // next, both before any WALL_PLACED repair). Guarded so only the
          // first such phase captures.
          if (!battleEndCaptured && current.size > 0) {
            for (const [pid, row] of current) {
              const player = sc.state.players[pid];
              if (!player) continue;
              const interior = getBattleInterior(player);
              row.interiorAtEnd = interior.size;
              row.enclosedTowersAtEnd = countTowersInInterior(sc, interior);
            }
            battleEndCaptured = true;
          }
          return;
        }
        current.clear();
        crosshairLast.clear();
        destroyedThisRound.clear();
        firedCannons.clear();
        lastShotTile.clear();
        enemyStreak.clear();
        shotOriginByCannon.clear();
        battleEndCaptured = false;
        lastShooter = undefined;
        lastCannonIdx = undefined;
        for (let pid = 0; pid < sc.state.players.length; pid++) {
          const player = sc.state.players[pid];
          if (!player || isPlayerEliminated(player)) continue;
          const row = emptyRow(ev.round, pid);
          row.ownedCannonsAtStart = countOwnedCannons(player);
          row.usableCannonsAtStart = countReadyCannons(sc, pid);
          const interior = getBattleInterior(player);
          row.interiorAtStart = interior.size;
          row.enclosedTowersAtStart = countTowersInInterior(sc, interior);
          // Default end to start so a battle whose end is never captured (e.g.
          // the final round at the rounds cap) contributes a neutral 0 loss.
          row.interiorAtEnd = row.interiorAtStart;
          row.enclosedTowersAtEnd = row.enclosedTowersAtStart;
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
        // Pressure: extend or break the shooter's enemy-directed streak, and
        // attribute the shot to the victim whose zone it lands in.
        const enemyDirected =
          info.kind === IMPACT.ENEMY_WALL || info.kind === IMPACT.ENEMY_CANNON;
        const streak = enemyDirected ? (enemyStreak.get(shooter) ?? 0) + 1 : 0;
        enemyStreak.set(shooter, streak);
        if (streak > row.enemyStreakMax) row.enemyStreakMax = streak;
        const impactZoneOwner = zoneOwnerIdAt(
          sc.state,
          ev.impactRow,
          ev.impactCol,
        );
        if (impactZoneOwner !== shooter) {
          const victimRow = current.get(impactZoneOwner);
          if (victimRow) victimRow.incomingShots++;
        }
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
        // Cannon utilization: this fire's ball is already pushed onto
        // cannonballs, so the firing cannon now reads not-ready — the count
        // below is the headroom available for the NEXT cycle.
        const fired = firedCannons.get(shooter) ?? new Set<number>();
        fired.add(ev.cannonIdx);
        firedCannons.set(shooter, fired);
        row.distinctCannonsFired = fired.size;
        const readyAfter = countReadyCannons(sc, shooter);
        row.readyAfterFireSum += readyAfter;
        if (readyAfter === 0) row.stallShots++;
        // Fire concentration: tile-distance from the previous shot's impact.
        const prev = lastShotTile.get(shooter);
        if (prev) {
          const jump = Math.hypot(
            ev.impactRow - prev.row,
            ev.impactCol - prev.col,
          );
          row.interShotDistSum += jump;
          row.interShotPairs++;
          lastJump.set(shooter, jump);
        } else {
          lastJump.set(shooter, undefined);
        }
        lastShotTile.set(shooter, { row: ev.impactRow, col: ev.impactCol });
        lastShooter = shooter;
        lastCannonIdx = ev.cannonIdx;
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
        if (ev.shooterId === ev.playerId) {
          row.ownWallsDestroyed++;
        } else {
          row.enemyWallsDestroyed++;
          classifyBreach(sc, ev, row, shotOriginByCannon);
        }
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

      on(sc, GAME_EVENT.LIFE_LOST, (ev) => {
        // Fires inside finalizeRound (BEFORE ROUND_END) when a player ends the
        // closing build with no enclosed alive tower → zone reset. The maximal
        // "couldn't rebuild the enclosure" outcome. Mark the row so ROUND_END
        // skips the gap split (its walls are no longer the final build board).
        const row = current.get(ev.playerId);
        if (row) row.lifeLostThisRound = 1;
      });

      on(sc, GAME_EVENT.ROUND_END, () => {
        // Closing WALL_BUILD is done; whatever destroyed tiles remain unrepaired
        // are this round's gaps. `current` still holds this round's rows (the
        // next BATTLE clears it), so attribute before that reset.
        for (const [pid, row] of current) {
          const leftover = destroyedThisRound.get(pid);
          row.unrepairedGaps = leftover?.size ?? 0;
          if (!leftover || leftover.size === 0) continue;
          // Split the unrepaired gaps by whether each tile is STILL needed for
          // an enclosure against the FINAL build board: classifyHit useless =
          // future-interior / redundant wall the victim correctly skipped (not
          // an effective attack); breaching/progress = a wall they NEEDED but
          // left unbuilt (the effective-attack signal). A life-loser's zone is
          // already reset here (resetZoneState in applyLifePenalties, before
          // ROUND_END) so its walls aren't the final board — skip its split; the
          // life-loss itself is the effectiveness signal.
          if (row.lifeLostThisRound > 0) continue;
          const victim = sc.state.players[pid];
          if (!victim) continue;
          for (const tile of leftover) {
            const { row: tr, col: tc } = unpackTile(tile);
            if (classifyHit(victim.walls, tr, tc) === "useless") {
              row.unrepairedInner++;
            } else {
              row.unrepairedLoadBearing++;
            }
          }
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
        if (lastCannonIdx !== undefined) {
          shotOriginByCannon.set(`${lastShooter}:${lastCannonIdx}`, ev.origin);
        }
        const row = current.get(lastShooter);
        if (!row) return;
        row.origin[ev.origin] = (row.origin[ev.origin] ?? 0) + 1;
        if (ev.pickPath !== undefined) {
          row.pickPath[ev.pickPath] = (row.pickPath[ev.pickPath] ?? 0) + 1;
          const jump = lastJump.get(lastShooter);
          if (jump !== undefined) {
            row.pickPathJumpSum[ev.pickPath] =
              (row.pickPathJumpSum[ev.pickPath] ?? 0) + jump;
            row.pickPathJumpPairs[ev.pickPath] =
              (row.pickPathJumpPairs[ev.pickPath] ?? 0) + 1;
          }
        }
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
    pickPath: {},
    pickPathJumpSum: {},
    pickPathJumpPairs: {},
    flightDistSumPx: 0,
    flightTimeSum: 0,
    enemyWallsDestroyed: 0,
    ownWallsDestroyed: 0,
    enemyCannonsKilled: 0,
    enemyWallsBreaching: 0,
    enemyWallsProgress: 0,
    enemyWallsUseless: 0,
    wallBreachByOrigin: {},
    wallProgressByOrigin: {},
    wallUselessByOrigin: {},
    gruntKillsOwnZone: 0,
    gruntKillsEnemyZone: 0,
    ownTowersLostToGrunts: 0,
    enemyHouseShots: 0,
    dupShots: 0,
    pitsInOwnZone: 0,
    repairTilesPlaced: 0,
    expansionTilesPlaced: 0,
    unrepairedGaps: 0,
    unrepairedLoadBearing: 0,
    unrepairedInner: 0,
    lifeLostThisRound: 0,
    interiorAtStart: 0,
    interiorAtEnd: 0,
    enclosedTowersAtStart: 0,
    enclosedTowersAtEnd: 0,
    ownedCannonsAtStart: 0,
    usableCannonsAtStart: 0,
    distinctCannonsFired: 0,
    readyAfterFireSum: 0,
    stallShots: 0,
    enemyStreakMax: 0,
    incomingShots: 0,
    interShotDistSum: 0,
    interShotPairs: 0,
    crosshairTravelPx: 0,
    crosshairSamples: 0,
  };
}

/** Classify an enemy-wall cannon hit as breaching / progress / useless (see
 *  `classifyHit`) and attribute it to the shooter's row by FireOrigin. The wall
 *  is already removed from `victim.walls` when WALL_DESTROYED fires (apply
 *  precedes the bus emit), so `victim.walls` is the post-removal set. */
function classifyBreach(
  sc: Scenario,
  ev: GameEventMap[typeof BATTLE_MESSAGE.WALL_DESTROYED],
  shooterRow: PlayerBattleMetrics,
  shotOriginByCannon: ReadonlyMap<string, string>,
): void {
  const victim = sc.state.players[ev.playerId];
  if (!victim) return;
  const origin =
    shotOriginByCannon.get(`${ev.shooterId}:${ev.shooterCannonIdx}`) ??
    "unknown";
  const category = classifyHit(victim.walls, ev.row, ev.col);
  if (category === "breaching") {
    shooterRow.enemyWallsBreaching++;
    shooterRow.wallBreachByOrigin[origin] =
      (shooterRow.wallBreachByOrigin[origin] ?? 0) + 1;
  } else if (category === "progress") {
    shooterRow.enemyWallsProgress++;
    shooterRow.wallProgressByOrigin[origin] =
      (shooterRow.wallProgressByOrigin[origin] ?? 0) + 1;
  } else {
    shooterRow.enemyWallsUseless++;
    shooterRow.wallUselessByOrigin[origin] =
      (shooterRow.wallUselessByOrigin[origin] ?? 0) + 1;
  }
}

/** Classify one wall removal against the victim's post-removal wall set.
 *
 *  - breaching: re-adding the tile re-traps interior — it was the last wall of
 *    the barrier here, so this hit opened the hole.
 *  - else the barrier still seals. The tile is a drilling STEP (progress) iff,
 *    with it re-added, its 4-connected wall body bridges a wall touching the
 *    live interior to a wall touching the outside — i.e. it lies on a radial
 *    barrier between interior and outside, so removing it thinned that barrier
 *    one wall toward a breach (e.g. the inner tile of a 2-thick wall). This is
 *    the multi-hit-breach credit: each step is scored when it lands, regardless
 *    of when the others do.
 *  - else USELESS: the wall body doesn't bridge interior to outside through this
 *    tile — a redundant parallel/concentric layer the breach skips, or a stray
 *    wall sealing no live interior. */
function classifyHit(
  walls: ReadonlySet<TileKey>,
  row: number,
  col: number,
): "breaching" | "progress" | "useless" {
  const tileKey = packTile(row, col);
  const outsideNow = computeOutside(walls);
  if (computeTrappedAfterAdd(outsideNow, [tileKey]).length > 0) {
    return "breaching";
  }
  const wallsBefore = new Set(walls);
  wallsBefore.add(tileKey);
  const outsideBefore = computeOutsideAfterAdd(outsideNow, [tileKey]);
  // BFS the destroyed tile's 4-connected wall body (a barrier seals the
  // 8-flood iff its walls are 4-linked). Progress iff that body touches BOTH a
  // live-interior tile and an outside tile somewhere — the tile is part of a
  // barrier actually separating the two.
  let touchesInterior = false;
  let touchesOutside = false;
  const stack: TileKey[] = [tileKey];
  const seen = new Set<TileKey>([tileKey]);
  while (stack.length > 0) {
    const key = stack.pop()!;
    const { row: kr, col: kc } = unpackTile(key);
    for (const [dr, dc] of DIRS_8) {
      const nr = kr + dr;
      const nc = kc + dc;
      if (!inBounds(nr, nc)) continue;
      const nkey = packTile(nr, nc);
      if (wallsBefore.has(nkey)) {
        // Extend through the wall body 4-connected only.
        if ((dr === 0 || dc === 0) && !seen.has(nkey)) {
          seen.add(nkey);
          stack.push(nkey);
        }
      } else if (outsideBefore.has(nkey)) {
        touchesOutside = true;
      } else {
        touchesInterior = true;
      }
    }
    if (touchesInterior && touchesOutside) return "progress";
  }
  return "useless";
}

/** Count towers with any tile inside the given (freshly computed) interior set
 *  — i.e. the player's currently-enclosed towers. Computed live from the same
 *  flood-fill as `interiorAtStart/End` so the start↔end delta is timing-
 *  independent (the cached `player.enclosedTowers` is only refreshed during
 *  BUILD, so it would be stale at the post-battle snapshot). */
function countTowersInInterior(
  sc: Scenario,
  interior: ReadonlySet<TileKey>,
): number {
  let count = 0;
  for (const tower of sc.state.map.towers) {
    let enclosed = false;
    forEachTowerTile(tower, (_r, _c, key) => {
      if (interior.has(key)) enclosed = true;
    });
    if (enclosed) count++;
  }
  return count;
}

/** Count alive, non-balloon cannons the player owns — the raw firepower they
 *  hold regardless of whether each is currently enclosed (and thus fireable). */
function countOwnedCannons(player: Player): number {
  let count = 0;
  for (const cannon of aliveCannons(player.cannons)) {
    if (!isBalloonCannon(cannon)) count++;
  }
  return count;
}

/** Count the player's cannons that can fire right now (alive + enclosed +
 *  not-captured + no ball in flight from them) — the same `canFireOwnCannon`
 *  predicate the AI's round-robin uses, so the count matches what the firing
 *  loop actually sees. */
function countReadyCannons(sc: Scenario, playerId: number): number {
  const player = sc.state.players[playerId];
  if (!player) return 0;
  let count = 0;
  for (let idx = 0; idx < player.cannons.length; idx++) {
    if (
      canFireOwnCannon(sc.state, playerId as ValidPlayerId, idx as CannonIdx)
    ) {
      count++;
    }
  }
  return count;
}
