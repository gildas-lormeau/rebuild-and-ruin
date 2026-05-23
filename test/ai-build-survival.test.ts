/**
 * Behavioral suite for AI build-phase placement: 11 seeds × 30 rounds each,
 * one Deno.test per seed so failures are individually diagnosable.
 *
 * Background: pre-fix to the selectTarget strategic fallback +
 * scoreTopCandidates hard-reject escape (ai-strategy-build.ts /
 * ai-build-target.ts), the AI could fall into a "build walls but never close
 * a ring" pattern when every selectTarget phase bailed on canFillAfterPlugging
 * or every gap-filler hit a SCORING_RULES hard-reject.
 *
 * Stall fingerprint: the player built ≥STALL_WALL_THRESHOLD wall tiles AND
 * fired zero `towerEnclosed` events this round AND has ≥1 alive unowned
 * tower in its zone at round end AND did not lose a life this round. The
 * earlier "ownedAtRoundEnd === 0" gate was too narrow — it missed cases where
 * the AI maintained a previously-enclosed castle but failed to expand to
 * alive unenclosed secondaries despite heavy building (seed 523357 r36
 * pattern).
 *
 * The life-lost filter survives the new metric: when a player loses a life,
 * applyLifePenalties resets the zone — that's a separate concern, not a
 * build-strategy stall.
 */

import { assert } from "@std/assert";
import { createScenario, waitForEvent } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";

interface RoundRow {
  walls: number;
  enclosures: number;
  unownedAliveZoneTowers: number;
  lostLifeThisRound: boolean;
  livesAtRoundEnd: number;
}

interface SeedFindings {
  stalls: string[];
  perPlayer: Array<{ enclosures: number; livesEnd: number; activeRounds: number }>;
}

const SEEDS = [
  42, 100, 203607, 314159, 555555, 634446, 700000, 833681, 921118, 1234567,
  7777777,
] as const;
const ROUNDS_TO_PLAY = 30;
/** Wall-placement volume that signals the AI was actively building (~one
 *  full piece bag for a round). */
const STALL_WALL_THRESHOLD = 25;
/** Sim-ms budget for 30 rounds (~70s/round × safety margin). */
const RUN_BUDGET_MS = 5_500_000;
const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;

for (const seed of SEEDS) {
  Deno.test(`AI build survival: seed ${seed}`, runOneSeed(seed));
}

function runOneSeed(seed: number) {
  return async () => {
    const perRound = await runSeed(seed);
    const findings = analyzeSeed(seed, perRound);
    const rounds = [...perRound.keys()].sort((a, b) => a - b);
    const lastRound = rounds[rounds.length - 1] ?? 0;
    console.log(
      `seed=${seed} rounds=${rounds.length}/${ROUNDS_TO_PLAY} (last=r${lastRound}) ${PLAYER_NAMES.map((n, i) => `${n}:enc=${findings.perPlayer[i]!.enclosures} lives=${findings.perPlayer[i]!.livesEnd} active=${findings.perPlayer[i]!.activeRounds}`).join(" | ")}`,
    );
    if (findings.stalls.length > 0) {
      console.log("Stalls:");
      for (const stall of findings.stalls) console.log(`  ${stall}`);
    }
    assert(
      findings.stalls.length === 0,
      `Detected ${findings.stalls.length} stall round(s) for seed ${seed}. See log for details.`,
    );
  };
}

async function runSeed(seed: number): Promise<Map<number, RoundRow[]>> {
  const sc = await createScenario({
    seed,
    mode: "modern",
    rounds: ROUNDS_TO_PLAY + 1,
  });

  const perRound = new Map<number, RoundRow[]>();
  const getRow = (round: number): RoundRow[] => {
    let row = perRound.get(round);
    if (!row) {
      row = [0, 1, 2].map(() => ({
        walls: 0,
        enclosures: 0,
        unownedAliveZoneTowers: 0,
        lostLifeThisRound: false,
        livesAtRoundEnd: 0,
      }));
      perRound.set(round, row);
    }
    return row;
  };

  sc.bus.on(GAME_EVENT.WALL_PLACED, (ev) => {
    getRow(sc.state.round)[ev.playerId]!.walls += ev.tileKeys.length;
  });
  sc.bus.on(GAME_EVENT.TOWER_ENCLOSED, (ev) => {
    getRow(sc.state.round)[ev.playerId]!.enclosures += 1;
  });
  sc.bus.on(GAME_EVENT.LIFE_LOST, (ev) => {
    getRow(ev.round)[ev.playerId]!.lostLifeThisRound = true;
  });
  // ROUND_END fires inside finalizeRound, AFTER finalizeTerritoryWithScoring
  // but also AFTER applyLifePenalties — so for life-losing players the zone
  // has already been reset and ownedTowers is empty. Capture unowned-alive
  // count here; the analyzer filters life-lost rounds separately.
  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    const row = getRow(ev.round);
    for (let pid = 0 as ValidPlayerId; pid < 3; pid = (pid + 1) as ValidPlayerId) {
      const player = sc.state.players[pid];
      if (!player) continue;
      row[pid]!.livesAtRoundEnd = player.lives;
      const home = player.homeTower;
      if (!home) {
        row[pid]!.unownedAliveZoneTowers = 0;
        continue;
      }
      const ownedSet = new Set(player.ownedTowers.map((tower) => tower.index));
      let unownedAlive = 0;
      for (const tower of sc.state.map.towers) {
        if (tower.zone !== home.zone) continue;
        if (!sc.state.towerAlive[tower.index]) continue;
        if (ownedSet.has(tower.index)) continue;
        unownedAlive++;
      }
      row[pid]!.unownedAliveZoneTowers = unownedAlive;
    }
  });

  try {
    waitForEvent(
      sc,
      GAME_EVENT.PHASE_START,
      (ev) =>
        ev.phase === Phase.WALL_BUILD && sc.state.round === ROUNDS_TO_PLAY,
      { timeoutMs: RUN_BUDGET_MS, label: `seed=${seed} r${ROUNDS_TO_PLAY} WB` },
    );
    waitForEvent(
      sc,
      GAME_EVENT.ROUND_END,
      (ev) => ev.round === ROUNDS_TO_PLAY,
      { timeoutMs: 90_000, label: `seed=${seed} r${ROUNDS_TO_PLAY} end` },
    );
  } catch {
    // Game may have ended early via last-player-standing — partial data fine.
  }
  return perRound;
}

function analyzeSeed(
  seed: number,
  perRound: Map<number, RoundRow[]>,
): SeedFindings {
  const rounds = [...perRound.keys()].sort((a, b) => a - b);
  const stalls: string[] = [];
  const perPlayer = [0, 1, 2].map(() => ({
    enclosures: 0,
    livesEnd: 0,
    activeRounds: 0,
  }));
  for (let pid = 0; pid < 3; pid++) {
    for (const round of rounds) {
      const row = perRound.get(round)![pid]!;
      perPlayer[pid]!.enclosures += row.enclosures;
      if (row.walls > 0) perPlayer[pid]!.activeRounds += 1;
      perPlayer[pid]!.livesEnd = row.livesAtRoundEnd;
      // Stall: built actively, fired no enclosure this round despite having
      // ≥1 alive unowned tower available to enclose, didn't lose a life
      // (zone reset would clear ownedTowers and confuse the metric).
      if (
        row.walls >= STALL_WALL_THRESHOLD &&
        row.enclosures === 0 &&
        row.unownedAliveZoneTowers >= 1 &&
        !row.lostLifeThisRound &&
        row.livesAtRoundEnd > 0
      ) {
        stalls.push(
          `seed=${seed} r${round} ${PLAYER_NAMES[pid]}: ${row.walls} walls placed, 0 enclosures fired, ${row.unownedAliveZoneTowers} alive unowned tower(s) available, lives=${row.livesAtRoundEnd}`,
        );
      }
    }
  }
  return { stalls, perPlayer };
}
