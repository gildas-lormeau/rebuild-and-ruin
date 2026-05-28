/**
 * Shared engine for `scripts/ai-intelligence.ts`. Runs one seed end-to-end
 * and returns multi-dimensional intelligence metrics — designed to be sampled
 * across many random seed sets so the user can measure metric variance and
 * decide whether the seed-set size is statistically adequate.
 *
 * Metrics per (seed, player):
 *   - finalLives      — lives remaining at game end (or last reached round)
 *   - finalScore      — score at game end
 *   - lastAliveRound  — last round the player was still alive
 *
 * Metrics per (seed, player, round) — sampled at every ROUND_END:
 *   - enclosedAlive   — count of alive towers owned (enclosed) this round
 *   - interiorSize    — interior tile count this round
 *
 * No per-decision metrics yet — start coarse, layer finer signals once the
 * variance of coarse metrics is understood.
 */

import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { createScenario, waitForEvent } from "../test/scenario.ts";

export interface PerRoundSample {
  enclosedAlive: number;
  interiorSize: number;
}

export interface PerPlayerMetrics {
  finalLives: number;
  finalScore: number;
  lastAliveRound: number;
  perRound: readonly PerRoundSample[];
}

export interface SeedMetrics {
  seed: number;
  rounds: number;
  players: readonly [PerPlayerMetrics, PerPlayerMetrics, PerPlayerMetrics];
}

export async function runSeed(
  seed: number,
  rounds: number,
  mode: "classic" | "modern",
): Promise<SeedMetrics> {
  const sc = await createScenario({ seed, mode, rounds: rounds + 1 });

  const perRound: PerRoundSample[][] = [[], [], []];
  const lastAliveRound: [number, number, number] = [0, 0, 0];

  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    for (let pid = 0; pid < 3; pid++) {
      const player = sc.state.players[pid];
      if (!player) continue;
      const enclosedAlive = player.enclosedTowers.filter(
        (tower) => sc.state.towerAlive[tower.index],
      ).length;
      perRound[pid]!.push({
        enclosedAlive,
        interiorSize: player.interior.size,
      });
      if (player.lives > 0) lastAliveRound[pid] = ev.round;
    }
  });

  try {
    await waitForEvent(sc, GAME_EVENT.ROUND_END, (ev) => ev.round === rounds, {
      timeoutMs: 200_000 * rounds,
      label: `ai-intel seed=${seed} r${rounds}`,
    });
  } catch {
    // Early end via last-player-standing — partial samples are OK.
  }

  const players: PerPlayerMetrics[] = [];
  for (let pid = 0; pid < 3; pid++) {
    const player = sc.state.players[pid]!;
    players.push({
      finalLives: player.lives,
      finalScore: player.score,
      lastAliveRound: lastAliveRound[pid] ?? 0,
      perRound: perRound[pid]!,
    });
  }

  return {
    seed,
    rounds: Math.max(...perRound.map((arr) => arr.length)),
    players: players as [PerPlayerMetrics, PerPlayerMetrics, PerPlayerMetrics],
  };
}
