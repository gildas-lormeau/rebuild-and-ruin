import { assert, assertEquals } from "@std/assert";
import seed977796DenyFatWall from "./fixtures/battle/seed977796-deny-enclosure-fat-wall.json" with {
  type: "json",
};
import mcpOverwalledPinch from "./fixtures/battle/mcp-overwalled-pinch.json" with {
  type: "json",
};
import seed977796GruntBreach from "./fixtures/battle/seed977796-grunt-breach.json" with {
  type: "json",
};
import { planDenyEnclosure } from "../../src/ai/ai-plan-deny-enclosure.ts";
import {
  GRUNT_BREACH_MAX_WALK,
  planGruntBreach,
} from "../../src/ai/ai-plan-grunt-breach.ts";
import {
  componentHoldsTower,
  countBrokenEnclosures,
  countUsableCannons,
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
  isEnclosureBroken,
} from "../../src/ai/ai-strategy-battle.ts";
import { getBattleInterior } from "../../src/shared/sim/board-occupancy.ts";
import { GAME_EVENT } from "../../src/shared/core/game-event-bus.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  type TileKey,
} from "../../src/shared/core/grid.ts";
import { isActivePlayer } from "../../src/shared/core/player-slot.ts";
import {
  computeOutside,
  forEachTowerTile,
  packTile,
  zoneAt,
} from "../../src/shared/core/spatial.ts";
import { Rng } from "../../src/shared/platform/rng.ts";
import { createPhaseScenario } from "./loader.ts";
import type { FixtureFile } from "./types.ts";

Deno.test(
  "phase-test: a deny-enclosure plan, fully executed, must breach a large enclosure (seed 977796 RED fat ring r43)",
  async () => {
    // `planDenyEnclosure` sieges the GEOGRAPHIC min-cut of the defender's
    // cheapest re-enclosure ring (computed with NO walls). When the defender's
    // live ring is 2-thick over that bottleneck, the cut lands on one layer
    // only — destroying every planned tile leaves the parallel layer
    // enclosing, so the siege costs the defender nothing (it need not even
    // repair) and donates the destroyed layer back as free interior tiles.
    //
    // The invariant under test: every plan the tactic returns must, when ALL
    // of its tiles are destroyed, breach at least one of the defender's
    // intact large enclosures. A plan that cannot breach even when fully
    // executed is a guaranteed no-op — the planner must return null instead,
    // so `planBattle` falls through to a tactic that validates its targets.
    //
    // The checkpoint is r43 BATTLE entry of the live game where BLUE spent a
    // 20-shot deny siege on RED (−20 walls) with zero enclosure impact: RED's
    // ring is 2-thick over every cheap-ring bottleneck on this board.
    const sc = await createPhaseScenario(
      seed977796DenyFatWall as unknown as FixtureFile,
    );
    assertEquals(sc.state.round, 43);
    assertEquals(sc.state.phase, Phase.BATTLE);
    const state = sc.state;
    const red = state.players[0]!;
    const blue = state.players[1]!;
    assert(isActivePlayer(red.id) && isActivePlayer(blue.id));

    // Non-vacuous: the fixture must present an enclosed defender (intact
    // large enclosure) or the invariant below would pass for the wrong reason.
    const liveOutside = computeOutside(red.walls);
    const largeEnclosures = findEnclosureComponents(getBattleInterior(red))
      .filter((comp) => comp.length > DESTROY_POCKET_MAX_SIZE)
      .filter((comp) => !isEnclosureBroken(comp, liveOutside));
    assert(
      largeEnclosures.length > 0 && red.enclosedTowers.length > 0,
      "RED has no intact large enclosure — fixture no longer exercises the deny siege, re-record",
    );

    const usableCannons = countUsableCannons(state, blue.id);
    assert(usableCannons >= 4, "BLUE lost its siege battery — re-record");

    // The planner draws from its own controller RNG (ring choice + breach
    // start rotation are weighted picks) and biases seam picks toward the
    // shooter's crosshair, so sample many rng streams AND cursor positions:
    // the invariant must hold for every ring/seam the tactic can choose.
    const noopPlans: string[] = [];
    for (let sample = 1; sample <= 30; sample++) {
      const rng = new Rng(sample * 7919);
      const cursor = {
        row: (sample * 13) % GRID_ROWS,
        col: (sample * 29) % GRID_COLS,
      };
      const plan = planDenyEnclosure(
        state,
        blue.id,
        red.id,
        usableCannons,
        rng,
        cursor,
      );
      if (!plan) continue;
      const modWalls = new Set(red.walls);
      for (const tile of plan) modWalls.delete(packTile(tile.row, tile.col));
      if (countBrokenEnclosures(modWalls, largeEnclosures) === 0) {
        noopPlans.push(
          plan.map((tile) => `(${tile.row},${tile.col})`).join(" "),
        );
      }
    }

    assertEquals(
      noopPlans.length,
      0,
      `${noopPlans.length}/30 sampled deny-enclosure plans break no large ` +
        `enclosure even when every planned tile is destroyed — the siege is ` +
        `a guaranteed no-op against this fat ring. First no-op plan: ` +
        `[${noopPlans[0]}]`,
    );
  },
);

Deno.test(
  "phase-test: AI breaches an over-walled castle to un-enclose EVERY tower (MCP seed 381466 RED r50)",
  async () => {
    // The "easy kill" the user pointed at: a player who has buried its zone in
    // walls (more wall than land) but whose enclosed towers are still held up
    // only by wall PLUGS in the obstacle lines — destroy those plugs and the
    // tower can only be re-enclosed with a small piece. The complaint was that
    // the AI never even *tried* to breach this. The `pinch_kill` tactic
    // (`planPinchKill`) detects it — the min-cut breach hugs the obstacle lines
    // and pays only at the plugs — and fires it deterministically at top
    // offensive priority instead of leaving it to the deny / fat_breach roll.
    //
    // Captured from the real MCP-play journal (seed 381466, modern) at round 50
    // BATTLE entry: RED has 212 walls and 2 intact tower-holding enclosures.
    // Driven forward through the REAL battle (all-AI), the invariant is that by
    // battle end EVERY one of RED's intact tower enclosures has been breached by
    // ENEMY fire — read with the runtime's own spatial primitives, no simulated
    // wall removal. Baseline (no pinch_kill) breaks only one ring here; the
    // tactic breaks both and leaves RED with zero enclosed towers.
    const sc = await createPhaseScenario(
      mcpOverwalledPinch as unknown as FixtureFile,
    );
    assertEquals(sc.state.round, 50);
    assertEquals(sc.state.phase, Phase.BATTLE);
    const state = sc.state;
    const red = state.players[0]!;
    assert(isActivePlayer(red.id));

    // Non-vacuous: RED must be over-walled with at least two intact tower
    // enclosures, or "breach every tower ring" would pass for the wrong reason.
    const liveOutside = computeOutside(red.walls);
    const towerFootprints = new Set<TileKey>();
    for (const tower of red.enclosedTowers) {
      if (state.towerAlive[tower.index]) {
        forEachTowerTile(tower, (_r, _c, key) => towerFootprints.add(key));
      }
    }
    const towerEnclosures = findEnclosureComponents(getBattleInterior(red))
      .filter((comp) => comp.length > DESTROY_POCKET_MAX_SIZE)
      .filter((comp) => !isEnclosureBroken(comp, liveOutside))
      .filter((comp) => comp.some((key) => towerFootprints.has(key)));
    assert(
      red.walls.size > 150 && towerEnclosures.length >= 2,
      `RED is not the over-walled multi-tower defender this fixture targets ` +
        `(walls=${red.walls.size}, tower-enclosures=${towerEnclosures.length}) ` +
        `— re-record`,
    );

    // Attribute the breach to ENEMY fire (shooterId an opponent), not RED's own
    // build-sweep self-fires, so the test can't pass on RED opening itself.
    let enemyDestroyedRedWalls = 0;
    sc.bus.on(GAME_EVENT.WALL_DESTROYED, (ev) => {
      if (ev.playerId === red.id && ev.shooterId !== undefined && ev.shooterId !== red.id) {
        enemyDestroyedRedWalls++;
      }
    });

    let frame = 0;
    const MAX_FRAMES = 4000;
    while (
      state.round === 50 &&
      state.phase === Phase.BATTLE &&
      frame < MAX_FRAMES
    ) {
      sc.tick(1);
      frame += 1;
    }

    const brokenNow = countBrokenEnclosures(red.walls, towerEnclosures);
    assert(
      enemyDestroyedRedWalls > 0,
      "no enemy destroyed a RED wall — the AI never attacked the over-walled castle",
    );
    assertEquals(
      brokenNow,
      towerEnclosures.length,
      `AI breached only ${brokenNow}/${towerEnclosures.length} of RED's intact ` +
        `tower enclosures (${enemyDestroyedRedWalls} RED walls destroyed by ` +
        `enemies) — the pinch-kill tactic must un-enclose EVERY tower of an ` +
        `over-walled defender it can breach`,
    );
  },
);

Deno.test(
  "phase-test: a grunt-breach plan opens the defender's tower ring within grunt-walking reach (seed 977796 RED r43 + grunt cluster)",
  async () => {
    // `planGruntBreach` drills the ring seam NEAREST the defender's in-zone
    // grunts — not the global min-cut — betting on the grunt march through the
    // gap next build (grunts block reseal tiles and are the only tower
    // killers). The fixture is the deny-enclosure fat-ring checkpoint with a
    // 3-grunt cluster authored just outside RED's western ring wall.
    //
    // The invariant: the plan must (a) target only the defender's live walls,
    // (b) breach an intact tower enclosure when fully executed, and (c) sit
    // within one build-phase's grunt walk of the cluster — otherwise the
    // corridor opens where no grunt will ever march and the tactic is just a
    // worse deny_enclosure.
    const sc = await createPhaseScenario(
      seed977796GruntBreach as unknown as FixtureFile,
    );
    assertEquals(sc.state.round, 43);
    assertEquals(sc.state.phase, Phase.BATTLE);
    const state = sc.state;
    const red = state.players[0]!;
    const blue = state.players[1]!;
    assert(isActivePlayer(red.id) && isActivePlayer(blue.id));

    // Non-vacuous: RED must present an intact tower ring AND a grunt cluster
    // in its zone, or the proximity assertion below passes for the wrong reason.
    const liveOutside = computeOutside(red.walls);
    const towerRings = findEnclosureComponents(getBattleInterior(red)).filter(
      (comp) =>
        componentHoldsTower(comp, red) && !isEnclosureBroken(comp, liveOutside),
    );
    const redZoneGrunts = state.grunts.filter(
      (grunt) =>
        zoneAt(state.map, grunt.row, grunt.col) === state.playerZones[red.id],
    );
    assert(
      towerRings.length > 0 && redZoneGrunts.length >= 2,
      `fixture drifted: RED tower rings=${towerRings.length}, in-zone ` +
        `grunts=${redZoneGrunts.length} — re-record`,
    );

    const usableCannons = countUsableCannons(state, blue.id);
    assert(usableCannons >= 4, "BLUE lost its siege battery — re-record");

    // Focused target → the planner is deterministic (the rng draw is only for
    // the unfocused uniform enemy pick), so one call IS the spec. The cursor
    // only rotates where the drill STARTS, never which tiles it contains.
    const plan = planGruntBreach(state, blue.id, red.id, usableCannons, new Rng(1), {
      row: 0,
      col: 0,
    });
    assert(plan && plan.length > 0, "planner found no drillable seam — re-record");

    for (const tile of plan) {
      assert(
        red.walls.has(packTile(tile.row, tile.col)),
        `plan tile (${tile.row},${tile.col}) is not a RED wall`,
      );
    }

    const modWalls = new Set(red.walls);
    for (const tile of plan) modWalls.delete(packTile(tile.row, tile.col));
    assert(
      countBrokenEnclosures(modWalls, towerRings) > 0,
      "fully-executed grunt breach opens no intact tower ring — a guaranteed no-op",
    );

    const minGruntDist = Math.min(
      ...plan.map((tile) =>
        Math.min(
          ...redZoneGrunts.map(
            (grunt) =>
              Math.abs(grunt.row - tile.row) + Math.abs(grunt.col - tile.col),
          ),
        ),
      ),
    );
    assert(
      minGruntDist <= GRUNT_BREACH_MAX_WALK,
      `breach is ${minGruntDist} tiles from the nearest grunt (max ` +
        `${GRUNT_BREACH_MAX_WALK}) — the corridor opens where no grunt will march`,
    );
  },
);
