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
  /** Rolled AI archetype per playerId for this game — lets the report segment
   *  rows by play style (join via `archetypes[row.playerId]`). `undefined` for
   *  any non-AI slot. */
  archetypes: (string | undefined)[];
}

export async function runSeed(
  seed: number,
  rounds: number,
  mode: "classic" | "modern",
): Promise<SeedMetrics> {
  // rounds + 1 so the ROUND_END for `rounds` actually fires before the cap.
  const sc = await createScenario({ seed, mode, rounds: rounds + 1 });
  const observer = createBattleMetricsObserver();
  observer.attach(sc);

  const lastAliveRound: [number, number, number] = [0, 0, 0];
  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    for (let pid = 0; pid < 3; pid++) {
      const player = sc.state.players[pid];
      if (player && player.lives > 0) lastAliveRound[pid] = ev.round;
    }
  });

  try {
    await waitForEvent(sc, GAME_EVENT.ROUND_END, (ev) => ev.round === rounds, {
      timeoutMs: 200_000 * rounds,
      label: `battle-metrics seed=${seed} r${rounds}`,
    });
  } catch {
    // Early end via last-player-standing — partial samples are OK.
  }

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
  return { seed, battles, players, archetypes };
}
