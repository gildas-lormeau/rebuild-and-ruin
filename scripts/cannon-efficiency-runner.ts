/**
 * Per-seed measurement for `scripts/cannon-efficiency.ts`. Runs one modern
 * game to-the-death and returns the firing-behaviour Agg. Imported by both the
 * worker (`cannon-efficiency-worker.ts`) and — as a fallback — the main script.
 *
 * See cannon-efficiency.ts for the metric definitions. The returned Agg holds
 * only plain numbers / number[] (no Sets), so it survives postMessage's
 * structured clone unchanged.
 */

import { filterActiveFiringCannons } from "../src/game/cannon-system.ts";
import { BATTLE_MESSAGE } from "../src/shared/core/battle-events.ts";
import { isCannonEnclosed } from "../src/shared/core/board-occupancy.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { createScenario, ScenarioTimeoutError } from "../test/scenario.ts";

export interface Agg {
  shots: number;
  flightT: number;
  impacts: number;
  /** Every launch→impact distance (px), for percentiles / far-reach. */
  dists: number[];
  /** Per (player, battle-round): capable fleet, cannons used, shots, cursor. */
  battleCapable: number[];
  battleCannons: number[];
  battleShots: number[];
  battleTravel: number[];
  /** Total cursor path (px) while present in battle, for trav/sht. */
  cursorTravelPx: number;
  meanRoundOverlap: number;
}

export async function measureSeed(seed: number, rounds: number): Promise<Agg> {
  const sc = await createScenario({
    seed,
    mode: "modern",
    rounds: Number.POSITIVE_INFINITY,
  });
  const agg = emptyAgg();

  // Per-player accumulators for the current battle round, flushed on
  // ROUND_END. curCapable is snapshot at battle start (drives util); the
  // rest accrue during the battle.
  const curTargets: Map<number, Set<number>> = new Map();
  const curCannons: Map<number, Set<number>> = new Map();
  const curShots: Map<number, number> = new Map();
  const curTravel: Map<number, number> = new Map();
  const curCapable: Map<number, number> = new Map();
  const roundSets: Map<number, Set<number>[]> = new Map();

  sc.bus.on(BATTLE_MESSAGE.CANNON_FIRED, (ev) => {
    agg.shots++;
    agg.flightT += ev.flightTime;
    agg.dists.push(Math.hypot(ev.impactX - ev.startX, ev.impactY - ev.startY));
    const tileKey = ev.impactRow * 1000 + ev.impactCol;
    const pid = ev.scoringPlayerId ?? ev.playerId;
    const cannonKey = ev.playerId * 100 + ev.cannonIdx;
    let tset = curTargets.get(pid);
    if (!tset) curTargets.set(pid, (tset = new Set()));
    tset.add(tileKey);
    let cset = curCannons.get(pid);
    if (!cset) curCannons.set(pid, (cset = new Set()));
    cset.add(cannonKey);
    curShots.set(pid, (curShots.get(pid) ?? 0) + 1);
  });
  sc.bus.on(BATTLE_MESSAGE.WALL_DESTROYED, (ev) => {
    if (ev.shooterId !== undefined) agg.impacts++; // cannon-driven only
  });
  sc.bus.on(BATTLE_MESSAGE.CANNON_DAMAGED, () => {
    agg.impacts++;
  });
  sc.bus.on(GAME_EVENT.ROUND_END, () => {
    // Flush by capable fleet: a player with cannons that COULD fire counts
    // even if it fired 0 (that is the waste we want to see).
    for (const [pid, capable] of curCapable) {
      if (capable === 0) continue;
      agg.battleCapable.push(capable);
      agg.battleCannons.push(curCannons.get(pid)?.size ?? 0);
      agg.battleShots.push(curShots.get(pid) ?? 0);
      agg.battleTravel.push(curTravel.get(pid) ?? 0);
      const tset = curTargets.get(pid);
      if (tset && tset.size > 0) {
        let arr = roundSets.get(pid);
        if (!arr) roundSets.set(pid, (arr = []));
        arr.push(tset);
      }
    }
    curTargets.clear();
    curCannons.clear();
    curShots.clear();
    curTravel.clear();
    curCapable.clear();
  });

  // Per-frame: snapshot capable fleet at battle start, integrate cursor path.
  const lastPos: Map<number, { x: number; y: number }> = new Map();
  let wasBattle = false;
  let ended = false;
  sc.bus.on(GAME_EVENT.GAME_END, () => {
    ended = true;
  });
  const sample = (): boolean => {
    const inBattle = sc.state.phase === Phase.BATTLE;
    if (inBattle && !wasBattle) {
      // Battle just started — snapshot each player's fire-capable fleet
      // (alive + enclosed), independent of countdown/reload timing.
      for (let pid = 0; pid < sc.state.players.length; pid++) {
        const player = sc.state.players[pid];
        if (!player) continue;
        const capable = filterActiveFiringCannons(player).filter((c) =>
          isCannonEnclosed(c, player),
        ).length;
        curCapable.set(pid, capable);
      }
    }
    wasBattle = inBattle;

    const chs = sc.overlay().battle?.crosshairs;
    const seen = new Set<number>();
    if (chs) {
      for (const ch of chs) {
        seen.add(ch.playerId);
        const prev = lastPos.get(ch.playerId);
        if (prev) {
          const d = Math.hypot(ch.x - prev.x, ch.y - prev.y);
          agg.cursorTravelPx += d;
          curTravel.set(ch.playerId, (curTravel.get(ch.playerId) ?? 0) + d);
        }
        lastPos.set(ch.playerId, { x: ch.x, y: ch.y });
      }
    }
    for (const pid of [...lastPos.keys()]) {
      if (!seen.has(pid)) lastPos.delete(pid);
    }
    return ended;
  };

  try {
    sc.runUntil(sample, { timeoutMs: 200_000 * rounds });
  } catch (err) {
    if (!(err instanceof ScenarioTimeoutError)) throw err;
  }

  let overlapSum = 0;
  let pairs = 0;
  for (const arr of roundSets.values()) {
    for (let i = 1; i < arr.length; i++) {
      overlapSum += jaccard(arr[i - 1]!, arr[i]!);
      pairs++;
    }
  }
  agg.meanRoundOverlap = pairs ? overlapSum / pairs : 0;
  return agg;
}

export function emptyAgg(): Agg {
  return {
    shots: 0,
    flightT: 0,
    impacts: 0,
    dists: [],
    battleCapable: [],
    battleCannons: [],
    battleShots: [],
    battleTravel: [],
    cursorTravelPx: 0,
    meanRoundOverlap: 0,
  };
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  return inter / (a.size + b.size - inter);
}
