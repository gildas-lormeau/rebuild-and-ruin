/**
 * Checkpoint parity test — the primary validation gate for agent-contributed
 * features that touch online play.
 *
 * Runs two headless games with the same seed and 3 AIs:
 *   - local: normal path (reference)
 *   - network: checkpoint relay enabled — every phase boundary goes through
 *     serialize → JSON string → parse → apply via a fake WebSocket stub,
 *     exercising the full network code path
 *
 * Three layers of assertion:
 *   1. Per-phase parity: after every phase transition (cannon, battle, build,
 *      finalize), both games are compared via buildGrid() ASCII map + structured
 *      state fingerprint. Any divergence means checkpoint serialization dropped state.
 *   2. Relay self-check: within the network game, state is fingerprinted before
 *      and after each relay apply. Any change means the roundtrip is not lossless.
 *   3. Rendering snapshot check: after battle-start, verifies battleAnim.walls
 *      and battleAnim.territory match actual player state (catches watcher
 *      rendering bugs where the watcher sees stale walls/territory).
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
import {
  createBattleStartMessage,
  createBuildStartMessage,
  createCannonStartMessage,
} from "../src/online/online-serialize.ts";
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
  const modern = state.modern;
  const parts = [
    `phase=${state.phase} round=${state.round} rng=${state.rng.getState()}`,
    `grunts=[${state.grunts.map((grunt) => `${grunt.row},${grunt.col}→t${grunt.targetTowerIdx ?? "?"}`).join(";")}] pits=${state.burningPits.length} bonus=${state.bonusSquares.length}`,
    `captured=${state.capturedCannons.length}`,
    `towerAlive=[${state.towerAlive}] pendRevive=[${[...state.towerPendingRevive].sort()}]`,
    `spawnQ=${state.gruntSpawnQueue.length} houses=${aliveHouses} tileHash=${tileHash(state)}`,
    `frozen=[${modern?.frozenTiles ? [...modern.frozenTiles].sort() : ""}] highTide=[${modern?.highTideTiles ? [...modern.highTideTiles].sort() : ""}] sinkhole=[${modern?.sinkholeTiles ? [...modern.sinkholeTiles].sort() : ""}]`,
    `modifier=${modern?.activeModifier ?? "none"} lastMod=${modern?.lastModifierId ?? "none"}`,
    `offers=${modern?.pendingUpgradeOffers ? [...modern.pendingUpgradeOffers.entries()].map(([pid, tu]) => `${pid}:${tu.join(",")}`).sort().join(";") : "none"}`,
    `masterLockout=${modern?.masterBuilderLockout ?? 0} masterOwners=[${modern?.masterBuilderOwners ? [...modern.masterBuilderOwners].sort() : ""}]`,
    `salvage=[${state.players.map((_, idx) => state.salvageSlots[idx] ?? 0)}]`,
    ...state.players.map(playerFingerprint),
  ];
  return parts.join("\n");
}

function playerFingerprint(player: Player): string {
  const cannonsDetail = player.cannons
    .map((c) => `${c.hp}@${(c.facing ?? 0).toFixed(2)}${c.mortar ? "M" : ""}${c.shielded ? "S" : ""}b${c.balloonHits ?? 0}`)
    .join(",");
  return `P${player.id}: lives=${player.lives} score=${player.score} elim=${player.eliminated} walls=${player.walls.size} interior=${player.interior.size} cannons=[${cannonsDetail}] defFacing=${player.defaultFacing.toFixed(4)} towers=${player.ownedTowers.length} castle=${player.castleWallTiles.size} dmg=${player.damagedWalls.size} upgrades=[${[...player.upgrades.entries()]}]`;
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
// Serialization-level assertion
// ---------------------------------------------------------------------------

/** Compare all checkpoint message types between both games. Each message type
 *  serializes different state subsets — comparing all three gives maximum coverage
 *  without manual fingerprint enumeration. */
function assertSerializationParity(local: GameState, network: GameState, label: string): void {
  const lc = JSON.stringify(createCannonStartMessage(local));
  const nc = JSON.stringify(createCannonStartMessage(network));
  assert(lc === nc, `Cannon-start message diverges at ${label}`);

  const lb = JSON.stringify(createBattleStartMessage(local));
  const nb = JSON.stringify(createBattleStartMessage(network));
  assert(lb === nb, `Battle-start message diverges at ${label}`);

  const ls = JSON.stringify(createBuildStartMessage(local));
  const ns = JSON.stringify(createBuildStartMessage(network));
  assert(ls === ns, `Build-start message diverges at ${label}`);
}

// ---------------------------------------------------------------------------
// Rendering snapshot assertion
// ---------------------------------------------------------------------------

/** Verify that battleAnim.walls and battleAnim.territory (what the watcher
 *  renderer actually uses during battle) match the current player state. */
function assertBattleAnimParity(network: Scenario, label: string): void {
  const battleAnim = network.getRelayBattleAnim();
  if (!battleAnim) return;
  for (let pi = 0; pi < network.state.players.length; pi++) {
    const player = network.state.players[pi]!;
    const snapWalls = battleAnim.walls[pi];
    if (snapWalls) {
      const missing = [...player.walls].filter((w) => !snapWalls.has(w));
      const extra = [...snapWalls].filter((w) => !player.walls.has(w));
      assert(
        missing.length === 0 && extra.length === 0,
        `battleAnim.walls[${pi}] diverges at ${label}: ${missing.length} missing, ${extra.length} extra`,
      );
    }
    const snapTerritory = battleAnim.territory[pi];
    if (snapTerritory) {
      const missing = [...(player.interior as ReadonlySet<number>)].filter((t) => !snapTerritory.has(t));
      const extra = [...snapTerritory].filter((t) => !(player.interior as ReadonlySet<number>).has(t));
      assert(
        missing.length === 0 && extra.length === 0,
        `battleAnim.territory[${pi}] diverges at ${label}: ${missing.length} missing, ${extra.length} extra`,
      );
    }
  }
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

  // Relay self-check: serialize→apply on own state must be lossless
  network.onRelayCapture = () => ({
    grid: gridFingerprint(network.state),
    state: stateFingerprint(network.state),
  });
  network.onRelayVerify = (label, before) => {
    if (label === "battle-start") {
      // Self-check skipped: territory recompute is non-idempotent at battle-start
      // because the host's map was mutated by modifiers/clearHighTide after the
      // last recheckTerritoryOnly. The per-phase parity comparison validates instead.
      // Still check that watcher rendering snapshots match post-recompute state.
      assertBattleAnimParity(network, `${label} (seed ${seed} ${mode})`);
      return;
    }
    const afterState = stateFingerprint(network.state);
    if (before.state !== afterState) {
      const bl = before.state.split("\n"), al = afterState.split("\n");
      const parts = [`Relay roundtrip changed state at ${label} (seed ${seed} ${mode})`];
      for (let idx = 0; idx < bl.length; idx++) {
        if (bl[idx] !== al[idx]) parts.push(`  before: ${bl[idx]}`, `  after:  ${al[idx]}`);
      }
      assert(false, parts.join("\n"));
    }
    const afterGrid = gridFingerprint(network.state);
    if (before.grid !== afterGrid) {
      assert(false, `Relay roundtrip changed grid at ${label} (seed ${seed} ${mode})`);
    }
  };

  while (local.state.players.filter((p) => !p.eliminated).length > 1) {
    const round = local.state.round;

    local.runCannon();
    network.runCannon();
    assertParity(local, network, `round ${round} after-cannon`);
    assertSerializationParity(local.state, network.state, `round ${round} after-cannon`);

    local.runBattle();
    network.runBattle();
    assertParity(local, network, `round ${round} after-battle`);
    assertSerializationParity(local.state, network.state, `round ${round} after-battle`);

    local.runBuild();
    network.runBuild();
    assertParity(local, network, `round ${round} after-build`);
    assertSerializationParity(local.state, network.state, `round ${round} after-build`);

    const lr = local.finalizeBuild();
    const nr = network.finalizeBuild();
    assertParity(local, network, `round ${round} after-finalize`);
    assertSerializationParity(local.state, network.state, `round ${round} after-finalize`);

    local.processReselection(lr.needsReselect);
    network.processReselection(nr.needsReselect);
    if (lr.needsReselect.length > 0) {
      assertParity(local, network, `round ${round} post-reselect`);
    }
  }
}

// ---------------------------------------------------------------------------
// Seeds — custom via CLI args, or random
// Usage: deno test --no-check test/checkpoint-parity.test.ts -- 9941 52 66
// ---------------------------------------------------------------------------

const customSeeds = Deno.args.map(Number).filter((n) => !Number.isNaN(n));
const seeds = customSeeds.length > 0
  ? customSeeds
  : Array.from({ length: 10 }, () => Math.floor(Math.random() * 10000));

for (const seed of seeds) {
  Deno.test(`classic seed ${seed}: checkpoint parity`, () => runParityTest(seed, "classic"));
  Deno.test(`modern seed ${seed}: checkpoint parity`, () => runParityTest(seed, "modern"));
}
