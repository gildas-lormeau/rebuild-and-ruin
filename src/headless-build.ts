/**
 * Headless build-phase observer.
 * Runs one game up to the end of the first (or Nth) build phase,
 * printing all AI logs along the way.
 *
 * Usage:
 *   bun src/headless-build.ts              # 1 game, stop after round-1 build
 *   bun src/headless-build.ts --rounds 3   # run 3 full rounds (build+battle)
 *   bun src/headless-build.ts --seed 42    # deterministic map seed
 */
import {
  nextPhase,
  resetCannonFacings,
  finalizeBuildPhase,
  computeCannonLimitsForPhase,
} from "./game-engine.ts";
import { BUILD_TIMER, BATTLE_TIMER } from "./types.ts";
import { updateCannonballs, resolveBalloons } from "./battle-system.ts";
import { tickGrunts, gruntAttackTowers } from "./grunt-system.ts";
import { isCannonAlive } from "./spatial.ts";
import {
  createHeadlessRuntime,
  processHeadlessReselection,
} from "./headless-sim.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args: string[] =
  "Deno" in globalThis
    ? ((globalThis as Record<string, unknown>).Deno as { args: string[] }).args
    : // deno-lint-ignore no-process-global
      process.argv.slice(2);
function arg(name: string, fallback: number): number {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1]) return Number(args[idx + 1]);
  return fallback;
}

const targetRounds = arg("rounds", 1);
const seed = arg("seed", Math.floor(Math.random() * 1_000_000));
const noBattle = args.includes("--no-battle");

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function run() {
  console.log(
    `=== Headless build observer  seed=${seed}  rounds=${targetRounds} ===\n`,
  );
  const runtime = createHeadlessRuntime(seed);
  const { state, controllers, playerCount } = runtime;

  let roundsCompleted = 0;

  while (roundsCompleted < targetRounds && state.round <= 50) {
    // ---- CANNON_PLACE ----
    resetCannonFacings(state);
    computeCannonLimitsForPhase(state);
    for (let i = 0; i < playerCount; i++) {
      const player = state.players[i]!;
      if (player.eliminated) continue;
      const ctrl = controllers[i]!;
      ctrl.placeCannons(state, state.cannonLimits[i]!);
      ctrl.flushCannons(state, state.cannonLimits[i]!);
    }

    resolveBalloons(state);
    nextPhase(state); // → BATTLE
    for (const ctrl of controllers) ctrl.resetBattle(state);

    // ---- BATTLE ----
    if (!noBattle) {
      const battleDuration = BATTLE_TIMER;
      let battleTime = 0;
      const dt = 0.1;

      while (battleTime < battleDuration || state.cannonballs.length > 0) {
        if (battleTime < battleDuration) {
          for (let i = 0; i < playerCount; i++) {
            if (state.players[i]!.eliminated) continue;
            controllers[i]!.battleTick(state, dt);
          }
        }
        gruntAttackTowers(state, dt);
        updateCannonballs(state, dt);
        battleTime += dt;
      }
    }
    for (const ctrl of controllers) ctrl.onBattleEnd();

    // BATTLE → WALL_BUILD
    nextPhase(state);

    // ---- WALL_BUILD ----
    console.log(`\n--- Round ${state.round} BUILD PHASE ---`);
    for (const p of state.players) {
      if (p.eliminated) continue;
      const owned = p.ownedTowers.length;
      const alive = p.ownedTowers.filter(
        (t) => state.towerAlive[t.index]!,
      ).length;
      console.log(
        `  P${p.id}: towers=${owned} (alive=${alive}) walls=${p.walls.size} interior=${p.interior.size} cannons=${p.cannons.filter((c) => isCannonAlive(c)).length} grunts=${state.grunts.filter((g) => g.targetPlayerId === p.id).length}`,
      );
    }
    console.log("");

    for (let i = 0; i < playerCount; i++) {
      if (state.players[i]!.eliminated) continue;
      controllers[i]!.startBuild(state);
    }

    const buildDuration = BUILD_TIMER + 5;
    let buildTime = 0;
    let gruntTickAccum = 0;

    while (buildTime < buildDuration) {
      const buildDt = 0.5;
      buildTime += buildDt;

      gruntTickAccum += buildDt;
      if (gruntTickAccum >= 1.0) {
        gruntTickAccum -= 1.0;
        tickGrunts(state);
      }

      for (let i = 0; i < playerCount; i++) {
        if (state.players[i]!.eliminated) continue;
        controllers[i]!.buildTick(state, buildDt);
      }
    }

    for (const ctrl of controllers) ctrl.endBuild(state);

    const { needsReselect } = finalizeBuildPhase(state);

    if (state.round === 2) {
      console.log(`\n--- FIRST REBUILD results ---`);
      for (const p of state.players) {
        console.log(
          `  P${p.id}: towers=${p.ownedTowers.length} walls=${p.walls.size} interior=${p.interior.size}`,
        );
      }
    }

    processHeadlessReselection(runtime, needsReselect);

    const alive = state.players.filter((p) => !p.eliminated);
    if (alive.length <= 1) {
      console.log(
        `\nGame over after round ${state.round}. Winner: P${alive[0]?.id ?? "none"}`,
      );
      return;
    }

    roundsCompleted++;
  }

  console.log(`\n=== ${roundsCompleted} round(s) completed ===`);
  for (const p of state.players) {
    if (p.eliminated) {
      console.log(`  P${p.id}: ELIMINATED`);
      continue;
    }
    console.log(
      `  P${p.id}: towers=${p.ownedTowers.length} walls=${p.walls.size} interior=${p.interior.size} score=${p.score}`,
    );
  }
}

run();
