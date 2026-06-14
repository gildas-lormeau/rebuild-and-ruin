/**
 * Shared engine for `scripts/battle-metrics.ts`. Runs one seed end-to-end with
 * the battle-metrics observer attached and returns every per-(battle, player)
 * row plus coarse per-game stats. No scoring — raw quantities only. Mirrors
 * `scripts/ai-intelligence-runner.ts`.
 */

import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import {
  createBattleMetricsObserver,
  type PlayerBattleMetrics,
} from "../test/battle-metrics-observer.ts";
import { createScenario, waitForEvent } from "../test/scenario.ts";

export interface PlayerGameMetrics {
  playerId: number;
  finalLives: number;
  finalScore: number;
  lastAliveRound: number;
}

export interface SeedMetrics {
  seed: number;
  battles: PlayerBattleMetrics[];
  players: PlayerGameMetrics[];
  /** Round at which GAME_END fired (the game's final round), or -1 if it never
   *  ended within the cap. Lets the report trim to the last N rounds per game. */
  endRound: number;
  /** True iff the game ended by last-player-standing (≤1 player alive) — a
   *  "full game". False if it hit the round cap with multiple survivors. */
  endedNaturally: boolean;
  /** Rolled AI archetype per playerId for this game — lets the report segment
   *  rows by play style (join via `archetypes[row.playerId]`). `undefined` for
   *  any non-AI slot. */
  archetypes: (string | undefined)[];
}

/** Safety round cap for `runToEnd` games — far above the natural last-player-
 *  standing length (empirically ~28–56 rounds), so a game ends by elimination
 *  long before this. A game that reaches it is a non-terminating stalemate and
 *  is flagged `endedNaturally: false` (excluded from "full game" analysis). */
const RUN_TO_END_SAFETY_CAP = 200;

export async function runSeed(
  seed: number,
  rounds: number,
  mode: "classic" | "modern",
  runToEnd = false,
): Promise<SeedMetrics> {
  // runToEnd: play until last-player-standing (high safety cap). Otherwise cap
  // at `rounds`; +1 so the ROUND_END for `rounds` fires before the cap.
  const cap = runToEnd ? RUN_TO_END_SAFETY_CAP : rounds;
  const sc = await createScenario({ seed, mode, rounds: cap + 1 });
  const observer = createBattleMetricsObserver();
  observer.attach(sc);

  const lastAliveRound: [number, number, number] = [0, 0, 0];
  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    for (let pid = 0; pid < 3; pid++) {
      const player = sc.state.players[pid];
      if (player && player.lives > 0) lastAliveRound[pid] = ev.round;
    }
  });
  let endRound = -1;
  sc.bus.on(GAME_EVENT.GAME_END, (ev) => {
    endRound = ev.round;
  });

  try {
    if (runToEnd) {
      await waitForEvent(sc, GAME_EVENT.GAME_END, () => true, {
        timeoutMs: 200_000 * cap,
        label: `battle-metrics seed=${seed} to-end`,
      });
    } else {
      await waitForEvent(
        sc,
        GAME_EVENT.ROUND_END,
        (ev) => ev.round === rounds,
        {
          timeoutMs: 200_000 * rounds,
          label: `battle-metrics seed=${seed} r${rounds}`,
        },
      );
    }
  } catch {
    // Early end via last-player-standing (capped run) or no natural end within
    // the safety cap (runToEnd) — partial samples are OK.
  }

  const aliveAtEnd = sc.state.players.filter(
    (player) => player && player.lives > 0,
  ).length;
  const endedNaturally = endRound > 0 && aliveAtEnd <= 1;

  const players: PlayerGameMetrics[] = [];
  for (let pid = 0; pid < 3; pid++) {
    const player = sc.state.players[pid];
    if (!player) continue;
    players.push({
      playerId: pid,
      finalLives: player.lives,
      finalScore: player.score,
      lastAliveRound: lastAliveRound[pid] ?? 0,
    });
  }

  const battles = [...observer.battles];
  const archetypes = [...sc.aiArchetypes()];
  observer.detach();
  return { seed, battles, players, endRound, endedNaturally, archetypes };
}
