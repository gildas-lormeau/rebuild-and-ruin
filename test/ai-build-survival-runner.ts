/**
 * Shared engine for the AI build-survival suite. Imported by both the test
 * file (which registers one Deno.test per seed) and the worker (which actually
 * runs `runSeed` on a background thread). See ai-build-survival.test.ts for
 * the stall-fingerprint background and the rationale for the 26-seed set.
 */

import { createScenario, waitForEvent } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";

export interface RoundRow {
  walls: number;
  enclosures: number;
  unownedAliveZoneTowers: number;
  lostLifeThisRound: boolean;
  livesAtRoundEnd: number;
}

export interface PlayerSummary {
  enclosures: number;
  livesEnd: number;
  activeRounds: number;
}

export interface SeedFindings {
  stalls: string[];
  perPlayer: PlayerSummary[];
}

export interface SeedResult {
  seed: number;
  findings: SeedFindings;
  /** Highest round number for which any per-round data was recorded. */
  lastRound: number;
  /** Number of rounds for which data was recorded (≤ ROUNDS_TO_PLAY). */
  roundsRecorded: number;
}

export const SEEDS = [
  42, 100, 203607, 314159, 409946, 510296, 555555, 634446, 700000, 833681,
  921118, 1234567, 1992148, 3020266, 3480269, 6959185, 7082653, 7126930,
  7414600, 7777777, 8055250, 8815892, 9142064, 9364665, 9468552, 9862896,
] as const;
export const ROUNDS_TO_PLAY = 30;
/** Wall-placement volume that signals the AI was actively building (~one
 *  full piece bag for a round). */
export const STALL_WALL_THRESHOLD = 25;
/** Sim-ms budget for 30 rounds (~70s/round × safety margin). */
export const RUN_BUDGET_MS = 5_500_000;
export const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;

export async function runAndAnalyze(seed: number): Promise<SeedResult> {
  const perRound = await runSeed(seed);
  const findings = analyzeSeed(seed, perRound);
  const rounds = [...perRound.keys()].sort((a, b) => a - b);
  const lastRound = rounds[rounds.length - 1] ?? 0;
  return { seed, findings, lastRound, roundsRecorded: rounds.length };
}

export function formatSummaryLine(result: SeedResult): string {
  const { seed, findings, lastRound, roundsRecorded } = result;
  const perPlayer = PLAYER_NAMES.map(
    (name, i) =>
      `${name}:enc=${findings.perPlayer[i]!.enclosures} lives=${findings.perPlayer[i]!.livesEnd} active=${findings.perPlayer[i]!.activeRounds}`,
  ).join(" | ");
  return `seed=${seed} rounds=${roundsRecorded}/${ROUNDS_TO_PLAY} (last=r${lastRound}) ${perPlayer}`;
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
  const perPlayer: PlayerSummary[] = [0, 1, 2].map(() => ({
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
