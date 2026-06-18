import { assert, assertEquals } from "@std/assert";
import seed33GoldPocket from "./fixtures/battle/seed33-gold-pocket-destruction.json" with {
  type: "json",
};
import seed977796DenyFatWall from "./fixtures/battle/seed977796-deny-enclosure-fat-wall.json" with {
  type: "json",
};
import { planDenyEnclosure } from "../../src/ai/ai-plan-deny-enclosure.ts";
import {
  countBrokenEnclosures,
  countUsableCannons,
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
  isEnclosureBroken,
} from "../../src/ai/ai-strategy-battle.ts";
import { getBattleInterior } from "../../src/shared/sim/board-occupancy.ts";
import { GAME_EVENT } from "../../src/shared/core/game-event-bus.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../../src/shared/core/grid.ts";
import { isActivePlayer } from "../../src/shared/core/player-slot.ts";
import { computeOutside, packTile } from "../../src/shared/core/spatial.ts";
import { Rng } from "../../src/shared/platform/rng.ts";
import { createPhaseScenario } from "./loader.ts";
import type { FixtureFile } from "./types.ts";

Deno.test(
  "phase-test: pocket destruction self-fire never breaches a large enclosure (seed 33 GOLD r4)",
  async () => {
    // When the AI opens its own small enclosures for the build sweep, it
    // fires at its OWN pocket-border walls — observable as WALL_DESTROYED
    // with shooterId === playerId (a self-fire). The invariant under test:
    // such a self-fire must only ever open a *pocket* (≤ DESTROY_POCKET_MAX_SIZE
    // tiles); it must never breach a large enclosure (drain more than a
    // pocket's worth of a player's largest enclosed region to the outside).
    //
    // This drives the REAL round-4 battle from a recorded checkpoint and
    // watches the REAL bus event. Enclosure sizes are read with the runtime's
    // own spatial primitives (computeOutside + findEnclosureComponents) — no
    // hand-rolled territory logic, no simulated wall removal. On this seed
    // GOLD (player 2) reliably performs pocket destruction (4 self-fires);
    // each opens a separate small pocket and reduces its largest enclosed
    // region by zero tiles — the large enclosure stays fully intact.
    const sc = await createPhaseScenario(
      seed33GoldPocket as unknown as FixtureFile,
    );
    assertEquals(sc.state.round, 4);
    assertEquals(sc.state.phase, Phase.BATTLE);
    const state = sc.state;

    let selfFires = 0;
    const selfFiredThisTick = new Set<number>();
    sc.bus.on(GAME_EVENT.WALL_DESTROYED, (ev) => {
      // shooterId === playerId ⇒ the wall's owner destroyed its own wall.
      if (ev.shooterId !== undefined && ev.shooterId === ev.playerId) {
        selfFires++;
        selfFiredThisTick.add(ev.playerId);
      }
    });

    // Largest enclosed region per player, sampled before each tick.
    const largestBefore = new Map<number, number>();
    for (const player of state.players) {
      largestBefore.set(player.id, largestEnclosure(player.walls));
    }

    let breach:
      | { playerId: number; before: number; after: number }
      | null = null;

    // Step the battle one frame at a time so a self-fire on a given tick is
    // attributed to that tick's enclosure change.
    let frame = 0;
    const MAX_FRAMES = 2000;
    while (
      state.round === 4 &&
      state.phase === Phase.BATTLE &&
      frame < MAX_FRAMES
    ) {
      selfFiredThisTick.clear();
      sc.tick(1);
      frame += 1;
      for (const player of state.players) {
        const after = largestEnclosure(player.walls);
        const before = largestBefore.get(player.id)!;
        if (
          breach === null &&
          selfFiredThisTick.has(player.id) &&
          before - after > DESTROY_POCKET_MAX_SIZE
        ) {
          breach = { playerId: player.id, before, after };
        }
        largestBefore.set(player.id, after);
      }
    }

    // Non-vacuous: the seed must actually exercise pocket destruction, or the
    // invariant below would pass for the wrong reason.
    assert(
      selfFires > 0,
      "no self-fire occurred — fixture no longer exercises pocket destruction, re-record",
    );

    assertEquals(
      breach,
      null,
      breach
        ? `player ${breach.playerId} self-fire dropped its largest enclosure ` +
            `${breach.before} → ${breach.after} (lost ${breach.before - breach.after} ` +
            `tiles, more than a pocket of ${DESTROY_POCKET_MAX_SIZE}) — pocket ` +
            `destruction breached a large enclosure`
        : "",
    );
  },
);

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
    // start rotation are weighted picks), so sample many streams: the
    // invariant must hold for every ring the tactic can choose.
    const noopPlans: string[] = [];
    for (let sample = 1; sample <= 30; sample++) {
      const rng = new Rng(sample * 7919);
      const plan = planDenyEnclosure(state, blue.id, red.id, usableCannons, rng);
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

/** Size of the player's largest enclosed region, computed from its current
 *  walls with the runtime's own spatial primitives. `computeOutside` is the
 *  8-dir flood the game uses for territory; interior = non-wall, non-outside
 *  (the same derivation as build-system's recomputeInterior); components via
 *  the AI's `findEnclosureComponents`. */
function largestEnclosure(walls: ReadonlySet<TileKey>): number {
  const outside = computeOutside(walls);
  const interior = new Set<TileKey>();
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const key = packTile(row, col);
      if (!outside.has(key) && !walls.has(key)) interior.add(key);
    }
  }
  let max = 0;
  for (const component of findEnclosureComponents(interior)) {
    if (component.length > max) max = component.length;
  }
  return max;
}
