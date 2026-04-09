/**
 * Checkpoint parity test — proves that checkpoint serialize→apply roundtrips
 * do not lose game state.
 *
 * Runs two headless games with the same seed and 3 AIs:
 *   - local: normal path (reference)
 *   - network: checkpoint relay enabled — every phase boundary goes through
 *     serialize → JSON string → parse → apply via a fake WebSocket stub,
 *     exercising the full network code path
 *
 * After each round, both games are compared via buildGrid() (ASCII map)
 * plus a structured state snapshot. Any divergence means checkpoint
 * serialization dropped state.
 *
 * Code under test (online/ net layer):
 *   - online-checkpoints.ts  — applyCannonStart/BattleStart/BuildStart/BuildEnd
 *   - online-serialize.ts    — createCannonStartMessage, createBuildStartMessage,
 *                              serializePlayers, applyPlayersCheckpoint
 *
 * Game logic exercised (must be identical in both paths):
 *   - game/: battle-system, build-system, cannon-system, grunt-*, phase-setup
 *   - shared/: board-occupancy, spatial, player-types, types
 *
 * Run with: deno test --no-check test/checkpoint-parity.test.ts
 */

import { assert } from "@std/assert";
import { buildGrid, type Cell } from "../src/game/debug-grid.ts";
import { GAME_MODE_MODERN } from "../src/shared/game-constants.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/grid.ts";
import type { Player } from "../src/shared/player-types.ts";
import type { GameState } from "../src/shared/types.ts";
import { setGameMode } from "../src/shared/types.ts";
import { createScenario, type Scenario } from "./scenario-helpers.ts";

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function gridFingerprint(state: GameState): string {
  const grid = buildGrid(state, "all", undefined);
  const lines: string[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    let line = "";
    for (let col = 0; col < GRID_COLS; col++) {
      const cell: Cell = grid[row]![col]!;
      const owner = cell.playerId >= 0 ? String(cell.playerId) : ".";
      const extra = cell.extra !== undefined ? `[${cell.extra}]` : "";
      line += cell.char + owner + extra;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function tileHash(state: GameState): number {
  let hash = 0;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      hash = ((hash << 5) - hash + state.map.tiles[row]![col]!) | 0;
    }
  }
  return hash;
}

function stateFingerprint(state: GameState): string {
  const aliveHouses = state.map.houses.filter((house) => house.alive).length;
  const parts = [
    `phase=${state.phase} round=${state.round} rng=${state.rng.getState()}`,
    `grunts=[${state.grunts.map((grunt) => `${grunt.row},${grunt.col}→t${grunt.targetTowerIdx ?? "?"}`).join(";")}] pits=${state.burningPits.length} bonus=${state.bonusSquares.length}`,
    `captured=${state.capturedCannons.length}`,
    `towerAlive=[${state.towerAlive}] pendRevive=[${[...state.towerPendingRevive].sort()}]`,
    `spawnQ=${state.gruntSpawnQueue.length} houses=${aliveHouses} tileHash=${tileHash(state)}`,
    `frozen=${state.modern?.frozenTiles?.size ?? 0} highTide=${state.modern?.highTideTiles?.size ?? 0} sinkhole=${state.modern?.sinkholeTiles?.size ?? 0}`,
    ...state.players.map(playerFingerprint),
  ];
  return parts.join("\n");
}

function playerFingerprint(player: Player): string {
  const cannonHp = player.cannons.map((c) => c.hp).join(",");
  const cannonsDetail = player.cannons.map((c) => `${c.hp}@${(c.facing ?? 0).toFixed(2)}`).join(",");
  return `P${player.id}: lives=${player.lives} score=${player.score} elim=${player.eliminated} walls=${player.walls.size} interior=${player.interior.size} cannons=[${cannonHp}] facing=[${cannonsDetail}] defFacing=${player.defaultFacing.toFixed(4)} towers=${player.ownedTowers.length} castle=${player.castleWallTiles.size} dmg=${player.damagedWalls.size} upgrades=[${[...player.upgrades.entries()]}]`;
}

// ---------------------------------------------------------------------------
// Parity assertion
// ---------------------------------------------------------------------------

function assertParity(local: Scenario, network: Scenario, label: string): void {
  const ls = stateFingerprint(local.state);
  const ns = stateFingerprint(network.state);
  const lg = gridFingerprint(local.state);
  const ng = gridFingerprint(network.state);

  if (ls === ns && lg === ng) return;

  const parts = [`Parity divergence at ${label}`];
  const ll = ls.split("\n"), nl = ns.split("\n");
  for (let idx = 0; idx < ll.length; idx++) {
    if (ll[idx] !== nl[idx]) parts.push(`  local:   ${ll[idx]}`, `  network: ${nl[idx]}`);
  }
  assert(false, parts.join("\n"));
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runParityTest(seed: number, mode: "classic" | "modern"): Promise<void> {
  const local = await createScenario(seed);
  const network = await createScenario(seed);
  if (mode === "modern") {
    setGameMode(local.state, GAME_MODE_MODERN);
    setGameMode(network.state, GAME_MODE_MODERN);
  }
  network.enableCheckpointRelay();

  while (local.state.players.filter((p) => !p.eliminated).length > 1) {
    const lr = local.playRound();
    const nr = network.playRound();

    assertParity(local, network, `round ${local.state.round}`);

    local.processReselection(lr.needsReselect);
    network.processReselection(nr.needsReselect);
    if (lr.needsReselect.length > 0) {
      assertParity(local, network, `round ${local.state.round} post-reselect`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixed seeds — classic
// ---------------------------------------------------------------------------

for (const seed of [52, 66, 65, 56, 2]) {
  Deno.test(`classic seed ${seed}: checkpoint parity`, () => runParityTest(seed, "classic"));
}

// ---------------------------------------------------------------------------
// Fixed seeds — modern (exercises modifiers + upgrades)
// ---------------------------------------------------------------------------

for (const seed of [52, 66, 65, 56, 2]) {
  Deno.test(`modern seed ${seed}: checkpoint parity`, () => runParityTest(seed, "modern"));
}

// ---------------------------------------------------------------------------
// Random seeds — both modes
// ---------------------------------------------------------------------------

const RANDOM_COUNT = 5;

for (let idx = 0; idx < RANDOM_COUNT; idx++) {
  const seed = Math.floor(Math.random() * 10000);
  Deno.test(`random classic seed ${seed}: checkpoint parity`, () => runParityTest(seed, "classic"));
  Deno.test(`random modern seed ${seed}: checkpoint parity`, () => runParityTest(seed, "modern"));
}
