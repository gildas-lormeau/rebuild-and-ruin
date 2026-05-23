/**
 * Behavioral suite for AI build-phase placement: 10 seeds × 20 rounds each,
 * one Deno.test per seed so failures are individually diagnosable.
 *
 * Background: pre-fix to the selectTarget strategic fallback +
 * scoreTopCandidates hard-reject escape (ai-strategy-build.ts /
 * ai-build-target.ts), the AI could fall into a "build walls but never close
 * a ring" pattern when every selectTarget phase bailed on canFillAfterPlugging
 * or every gap-filler hit a SCORING_RULES hard-reject. Either way the
 * scattered `pickFallbackPlacement` took over and the AI never closed any
 * ring across a round.
 *
 * The pathological fingerprint is *NOT* "no enclosure events fired this
 * round" — a healthy player can keep an already-closed ring and fire zero
 * `towerEnclosed` events. The real stall is "the AI built ≥THRESHOLD wall
 * tiles AND ended the round with zero enclosed towers AND did not lose a
 * life this round" (the life-lost case clears ownedTowers via zone reset
 * and is a separate concern).
 *
 * Each seed has one test that runs 20 rounds and asserts no such stall round
 * for any non-eliminated, non-life-losing player.
 */

import { assert } from "@std/assert";
import { createScenario, waitForEvent } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";

interface RoundRow {
  walls: number;
  enclosures: number;
  ownedAtRoundEnd: number;
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
const ROUNDS_TO_PLAY = 20;
/** Wall-placement volume that signals the AI was actively building (~one
 *  full piece bag for a round). */
const STALL_WALL_THRESHOLD = 25;
/** Sim-ms budget for 20 rounds (~70s/round × safety margin). */
const RUN_BUDGET_MS = 3_500_000;
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
        ownedAtRoundEnd: 0,
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
  // has already been reset and ownedTowers is 0. We capture both signals
  // (lostLifeThisRound + ownedAtRoundEnd) and let the analyzer filter.
  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    const row = getRow(ev.round);
    for (let pid = 0 as ValidPlayerId; pid < 3; pid = (pid + 1) as ValidPlayerId) {
      const player = sc.state.players[pid];
      if (!player) continue;
      row[pid]!.ownedAtRoundEnd = player.ownedTowers.length;
      row[pid]!.livesAtRoundEnd = player.lives;
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
      // Stall: built actively, ended round with no enclosed towers, did NOT
      // lose a life this round (so the zone wasn't reset by applyLifePenalties).
      if (
        row.walls >= STALL_WALL_THRESHOLD &&
        row.ownedAtRoundEnd === 0 &&
        !row.lostLifeThisRound &&
        row.livesAtRoundEnd > 0
      ) {
        stalls.push(
          `seed=${seed} r${round} ${PLAYER_NAMES[pid]}: ${row.walls} walls placed, 0 owned at round end, ${row.enclosures} enclosures fired this round, lives=${row.livesAtRoundEnd}`,
        );
      }
    }
  }
  return { stalls, perPlayer };
}
