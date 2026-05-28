/**
 * Capture an ASCII snapshot of the board at a specific (seed, round, phase,
 * moment), optionally cropped to one player's footprint.
 *
 * Usage:
 *   npm run snapshot -- --seed 1000000 --round 20 --phase WALL_BUILD
 *   npm run snapshot -- --seed 42 --round 5 --phase BATTLE --moment end --player BLUE
 *   npm run snapshot -- --seed 1000000 --mode classic --round 3 --phase CANNON_PLACE
 *   npm run snapshot -- --seed 42 --round 5 --phase BATTLE --at 3.5
 *
 * --phase: CASTLE_SELECT | CANNON_PLACE | MODIFIER_REVEAL | BATTLE |
 *          UPGRADE_PICK | WALL_BUILD
 * --moment: start (default — at PHASE_START) | end (just after the phase exits)
 * --at <seconds>: sim-seconds elapsed since the target phase's PHASE_START.
 *          Wins over --moment. Errors if the phase exits before reaching
 *          the requested offset. Sub-second values (e.g. 2.5) are fine —
 *          the runtime advances one frame at a time so granularity is bounded
 *          by the sim frame budget, not seconds.
 * --player RED|BLUE|GOLD: highlights that player + crops the ASCII to
 *          their footprint (`cropTo: playerId` auto-computes the bbox)
 *
 * Conditional phases (MODIFIER_REVEAL, UPGRADE_PICK) don't fire every round;
 * asking for one in a round that doesn't have it will time out.
 *
 * Body wrapped in main() because Biome hoists top-level consts past their
 * init-order dependencies.
 */

import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { GameState } from "../src/shared/core/types.ts";
import { createScenario, waitForEvent } from "../test/scenario.ts";

interface Args {
  seed: number | undefined;
  mode: "classic" | "modern";
  round: number | undefined;
  phase: Phase | undefined;
  moment: "start" | "end";
  /** Sim-seconds elapsed since PHASE_START, when provided. Overrides moment. */
  at: number | undefined;
  player: 0 | 1 | 2 | undefined;
}

const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;

await main();

async function main(): Promise<void> {
  const args = parseArgs();
  if (
    args.seed === undefined ||
    args.round === undefined ||
    args.phase === undefined
  ) {
    console.error(
      "Usage: npm run snapshot -- --seed N --round N --phase PHASE " +
        "[--mode classic|modern] [--moment start|end | --at SECONDS] " +
        "[--player RED|BLUE|GOLD]",
    );
    console.error(
      "  PHASE: CASTLE_SELECT | CANNON_PLACE | MODIFIER_REVEAL | BATTLE | UPGRADE_PICK | WALL_BUILD",
    );
    Deno.exit(1);
  }

  using sc = await createScenario({
    seed: args.seed,
    mode: args.mode,
    rounds: args.round + 1,
    renderer: "ascii",
  });

  const targetLabel =
    args.at !== undefined
      ? `r${args.round} ${args.phase} @${args.at}s`
      : `r${args.round} ${args.phase} ${args.moment}`;
  // 200_000ms/round matches watch-game's budget shape (~183s sim/round on
  // survival, headroom for stalls).
  const timeoutMs = 200_000 * (args.round + 1);

  if (args.at !== undefined) {
    // "at N seconds" = wait for PHASE_START, then drive sim time forward
    // until N*1000 sim-ms have elapsed. Bail if the phase exits early
    // (PHASE_END for the target, or ROUND_END) — the requested offset
    // doesn't exist.
    let phaseStartAt: number | null = null;
    let phaseExitedEarly = false;
    sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
      if (
        phaseStartAt === null &&
        ev.round === args.round &&
        ev.phase === args.phase
      ) {
        phaseStartAt = sc.now();
      }
    });
    sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
      if (
        phaseStartAt !== null &&
        ev.round === args.round &&
        ev.phase === args.phase
      ) {
        phaseExitedEarly = true;
      }
    });
    sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
      if (phaseStartAt !== null && ev.round === args.round) {
        phaseExitedEarly = true;
      }
    });
    const targetMs = args.at * 1000;
    sc.runUntil(
      () =>
        phaseExitedEarly ||
        (phaseStartAt !== null && sc.now() - phaseStartAt >= targetMs),
      { timeoutMs },
    );
    if (phaseExitedEarly) {
      console.error(
        `Phase ${args.phase} in round ${args.round} exited before reaching --at ${args.at}s.`,
      );
      Deno.exit(1);
    }
  } else if (args.moment === "start") {
    waitForEvent(
      sc,
      GAME_EVENT.PHASE_START,
      (ev) => ev.round === args.round && ev.phase === args.phase,
      { timeoutMs, label: targetLabel },
    );
  } else {
    // "end" = state right after the target phase exits. Wait for the
    // target phase to START, then for the NEXT PHASE_START (or ROUND_END
    // if the target was WALL_BUILD, the last phase of a round). Modern
    // mode has conditional phases (MODIFIER_REVEAL / UPGRADE_PICK) so we
    // can't hard-code the successor phase per (mode, target) — listening
    // for whichever fires next is the only robust path.
    let sawTarget = false;
    let triggered = false;
    sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
      if (sawTarget) triggered = true;
      if (ev.round === args.round && ev.phase === args.phase) sawTarget = true;
    });
    sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
      if (sawTarget && ev.round === args.round) triggered = true;
    });
    sc.runUntil(() => triggered, { timeoutMs, label: targetLabel });
  }

  // Banner: seed/round/phase/moment + per-player stats (filtered to the
  // focused player if --player was passed)
  console.log(
    `seed=${args.seed} mode=${args.mode} ${targetLabel}${args.player !== undefined ? ` (focus ${PLAYER_NAMES[args.player]})` : ""}`,
  );
  for (let i = 0; i < 3; i++) {
    const player = sc.state.players[i];
    if (!player) continue;
    if (args.player !== undefined && args.player !== i) continue;
    console.log(
      `  ${PLAYER_NAMES[i]}: ${player.lives}♥ ${player.score} ${player.walls.size}w ${player.ownedTowers.length}e${player.eliminated ? " ELIM" : ""}`,
    );
  }
  console.log();

  // cropTo accepts a ValidPlayerId directly — the renderer auto-computes
  // the player's footprint bbox.
  const snapshot = sc.renderer!.snapshot({
    coords: true,
    playerFilter: args.player,
    cropTo: args.player,
  });
  console.log(snapshot);
  console.log();
  console.log(buildAnchors(sc.state, args.player));
  Deno.exit(0);
}

/** Anchor footnote — absolute (row, col) positions for entities the agent
 *  is likely to want to reason about. Skips groups with no entries so
 *  early-game / empty-state snapshots stay short. Always uses (row, col)
 *  ordering to match TilePos / tileAt across the codebase. */
function buildAnchors(state: GameState, focus: 0 | 1 | 2 | undefined): string {
  const out: string[] = ["Anchors (row, col):"];
  const homeIndices = new Set<number>();
  for (const player of state.players) {
    if (player.homeTower) homeIndices.add(player.homeTower.index);
  }

  // Castles — home towers per active player.
  const castles: string[] = [];
  for (const player of state.players) {
    if (focus !== undefined && player.id !== focus) continue;
    if (!player.homeTower) continue;
    const alive = state.towerAlive[player.homeTower.index] ?? false;
    castles.push(
      `${PLAYER_NAMES[player.id]} ${alive ? "T" : "t"}(${player.homeTower.row},${player.homeTower.col})`,
    );
  }
  if (castles.length > 0) out.push(`  Castles: ${castles.join(" ")}`);

  // Non-home towers (capturable / contested).
  const towers: string[] = [];
  for (let i = 0; i < state.map.towers.length; i++) {
    if (homeIndices.has(i)) continue;
    const tower = state.map.towers[i]!;
    const alive = state.towerAlive[i] ?? false;
    towers.push(`${alive ? "Y" : "y"}#${i}(${tower.row},${tower.col})`);
  }
  if (towers.length > 0) out.push(`  Towers: ${towers.join(" ")}`);

  // Cannons per player. Dead cannons remain on the map as debris (x), so
  // include them — they still block placement.
  for (const player of state.players) {
    if (focus !== undefined && player.id !== focus) continue;
    if (player.cannons.length === 0) continue;
    const items: string[] = [];
    for (let idx = 0; idx < player.cannons.length; idx++) {
      const cannon = player.cannons[idx]!;
      const char = cannon.hp > 0 ? "C" : "x";
      items.push(`#${idx} ${char}(${cannon.row},${cannon.col})/${cannon.mode}`);
    }
    out.push(`  Cannons ${PLAYER_NAMES[player.id]}: ${items.join(" ")}`);
  }

  // Captured cannons (one player's cannon held by another).
  if (state.capturedCannons.length > 0) {
    const captured = state.capturedCannons.map(
      (entry) =>
        `(${entry.cannon.row},${entry.cannon.col})${PLAYER_NAMES[entry.victimId]}→${PLAYER_NAMES[entry.capturerId]}`,
    );
    out.push(`  Captured: ${captured.join(" ")}`);
  }

  // Burning pits (block grass tiles for 3 battle rounds).
  if (state.burningPits.length > 0) {
    const pits = state.burningPits.map((pit) => `(${pit.row},${pit.col})`);
    out.push(`  Burning pits: ${pits.join(" ")}`);
  }

  // Bonus squares.
  if (state.bonusSquares.length > 0) {
    const bonuses = state.bonusSquares.map(
      (bonus) => `(${bonus.row},${bonus.col})`,
    );
    out.push(`  Bonuses: ${bonuses.join(" ")}`);
  }

  return out.join("\n");
}

function parseArgs(): Args {
  const argv = Deno.args;
  let seed: number | undefined;
  let mode: "classic" | "modern" = "modern";
  let round: number | undefined;
  let phase: Phase | undefined;
  let moment: "start" | "end" = "start";
  let at: number | undefined;
  let player: 0 | 1 | 2 | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--seed") seed = Number(argv[++i]);
    else if (flag === "--mode") {
      const value = argv[++i];
      if (value !== "classic" && value !== "modern") {
        console.error(`Invalid --mode: ${value} (expected classic or modern)`);
        Deno.exit(1);
      }
      mode = value;
    } else if (flag === "--round") round = Number(argv[++i]);
    else if (flag === "--phase") {
      const value = argv[++i]?.toUpperCase() ?? "";
      const enumValue = (Phase as Record<string, Phase>)[value];
      if (enumValue === undefined) {
        console.error(
          `Invalid --phase: ${value} (expected CASTLE_SELECT | CANNON_PLACE | MODIFIER_REVEAL | BATTLE | UPGRADE_PICK | WALL_BUILD)`,
        );
        Deno.exit(1);
      }
      phase = enumValue;
    } else if (flag === "--moment") {
      const value = argv[++i];
      if (value !== "start" && value !== "end") {
        console.error(`Invalid --moment: ${value} (expected start or end)`);
        Deno.exit(1);
      }
      moment = value;
    } else if (flag === "--at") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) {
        console.error(
          `Invalid --at: ${argv[i]} (expected non-negative number of seconds)`,
        );
        Deno.exit(1);
      }
      at = value;
    } else if (flag === "--player") {
      const value = argv[++i]?.toUpperCase() ?? "";
      const idx = PLAYER_NAMES.indexOf(value as (typeof PLAYER_NAMES)[number]);
      if (idx < 0) {
        console.error(
          `Invalid --player: ${value} (expected RED, BLUE, or GOLD)`,
        );
        Deno.exit(1);
      }
      player = idx as 0 | 1 | 2;
    } else {
      console.error(`Unknown flag: ${flag}`);
      Deno.exit(1);
    }
  }
  return { seed, mode, round, phase, moment, at, player };
}
