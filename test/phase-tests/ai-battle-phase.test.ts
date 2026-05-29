import { assert, assertEquals } from "@std/assert";
import seed33GoldPocket from "./fixtures/battle/seed33-gold-pocket-destruction.json" with {
  type: "json",
};
import {
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
} from "../../src/ai/ai-strategy-battle.ts";
import { GAME_EVENT } from "../../src/shared/core/game-event-bus.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../../src/shared/core/grid.ts";
import { computeOutside, packTile } from "../../src/shared/core/spatial.ts";
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
