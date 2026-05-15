/**
 * Regression: seed 833681 modern, round 27 — bug repro for the cross-zone
 * grunt-eviction asymmetry in `evictEntitiesInZone`.
 *
 * The original code wiped every cross-zone grunt whose `targetTowerIdx`
 * pointed at a tower in the reset zone, regardless of whether the zone
 * was being reset due to elimination (towers gone forever) or just a
 * life-loss (towers revived two lines later in `resetZoneState`). The
 * life-loss case wrongly killed grunts mid-crossing whose target was
 * about to come back alive.
 *
 * In this seed: Red loses a life at end of round 27 (Gold is also
 * eliminated). Pre-fix, three grunts disappear at tick 4498 — two in
 * Red's zone (correct, in-zone wipe) plus grunt (14,19) in Blue's zone
 * targeting Red's tower 0 (wrong; Red's tower is revived this same tick).
 *
 * Post-fix, `evictEntitiesInZone` skips the cross-zone clause when the
 * zone owner is not eliminated, so the (14,19) grunt survives.
 *
 * Method: tick-by-tick snapshot of state.grunts through round 27;
 * cross-check matcher-detected disappearances against actual count drops
 * to filter out matcher artifacts (greedy 1-step matching mis-tracks
 * clustered grunt movement). Each real drop is classified against the
 * legitimate removal sites:
 *
 *   (1) GRUNT_KILLED in battle — cannonball impact.
 *   (2) ENCLOSED — grunt inside a player's interior (prev or cur tick;
 *       removeEnclosedGruntsAndRespawn).
 *   (3) MISPLACED-ON-WALL — grunt sitting on a wall tile (sweep).
 *   (4) DEAD_ZONE — grunt in an already-eliminated zone.
 *   (5) ZONE_RESET — a player lost a life this round; grunt was in their
 *       zone (or, only when that player was just eliminated, targeting
 *       one of their towers).
 *   (6) UNKNOWN — none of the above; fail only if this also corresponds
 *       to an actual `state.grunts.length` drop.
 *
 * Post-fix expectations pinned: see assertions at end of test.
 */

import { assert } from "@std/assert";
import { createScenario, waitUntilRound } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import {
  GAME_EVENT,
  type GameEventMap,
} from "../src/shared/core/game-event-bus.ts";
import { Tile } from "../src/shared/core/grid.ts";
import {
  isPlayerEliminated,
  isPlayerSeated,
} from "../src/shared/core/player-types.ts";
import { PLAYER_NAMES } from "../src/shared/ui/player-config.ts";
import { packTile } from "../src/shared/core/spatial.ts";
import type { GameState } from "../src/shared/core/types.ts";
import type { Grunt } from "../src/shared/core/battle-types.ts";

interface GruntFingerprint {
  readonly row: number;
  readonly col: number;
  readonly tile:
    | "grass"
    | "water"
    | "frozenWater"
    | "exposedRiverbed"
    | "unknown";
  readonly zone: number | null;
  readonly inInteriorOf: readonly number[]; // player ids whose interior contains the tile
  readonly inWallsOf: readonly number[]; // player ids whose walls contain the tile
  readonly targetTowerIdx: number | undefined;
  readonly targetTowerZone: number | null;
}

interface Snapshot {
  readonly tickIdx: number;
  readonly phase: Phase;
  readonly round: number;
  readonly timer: number;
  readonly grunts: readonly GruntFingerprint[];
  readonly aliveSlots: readonly number[];
  readonly eliminatedZones: readonly number[];
  /** Snapshot of every seated player's interior at this tick. Used to
   *  classify disappearances that happen on the same tick that finalize
   *  runs — the grunt was outside everyone's interior at tick T-1 but the
   *  tick-T recompute (after wall placement) folded the tile in. */
  readonly interiorByPlayer: ReadonlyMap<number, ReadonlySet<number>>;
  readonly wallsByPlayer: ReadonlyMap<number, ReadonlySet<number>>;
}

Deno.test("seed 833681 modern round 27 — diagnose grunt disappearance", async () => {
  using sc = await createScenario({
    seed: 833681,
    mode: "modern",
    rounds: 40,
  });

  // Skip to round 27 with a generous budget — earlier rounds run unmonitored.
  // ~60s of sim-time per round, plus banners/dwell, plus headroom.
  waitUntilRound(sc, 27, { timeoutMs: 3_000_000 });
  console.log(`reached round ${sc.state.round}, phase=${sc.state.phase}`);
  console.log(
    `playerZones: ${sc.state.players
      .map(
        (p, slot) =>
          `${PLAYER_NAMES[slot]}=zone${sc.state.playerZones[p.id] ?? "?"}`,
      )
      .join(", ")}`,
  );

  // Per-round event log helps narrate cause of any UNKNOWN disappearance.
  const lifeLosses: GameEventMap["lifeLost"][] = [];
  const eliminations: GameEventMap["playerEliminated"][] = [];
  const gruntKilled: Array<{ tickIdx: number; row: number; col: number }> = [];
  let gruntKilledTickIdx = -1;

  sc.bus.on(GAME_EVENT.LIFE_LOST, (ev) => {
    if (ev.round === 27) lifeLosses.push(ev);
  });
  sc.bus.on(GAME_EVENT.PLAYER_ELIMINATED, (ev) => {
    if (ev.round === 27) eliminations.push(ev);
  });
  sc.bus.on(GAME_EVENT.GRUNT_KILLED, (ev) => {
    // Records during the current tick window only.
    gruntKilled.push({ tickIdx: gruntKilledTickIdx, row: ev.row, col: ev.col });
  });

  const snapshots: Snapshot[] = [];
  const MAX_TICKS = 30_000;
  let endRoundSeen = false;
  let postRoundEndTicks = 0;

  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    if (ev.round === 27) endRoundSeen = true;
  });

  for (let t = 0; t < MAX_TICKS; t++) {
    gruntKilledTickIdx = t;
    sc.tick(1);
    snapshots.push(snapshot(sc.state, t));
    // Stop a few ticks after ROUND_END to capture the deferred cleanup pass.
    if (endRoundSeen) {
      postRoundEndTicks++;
      if (postRoundEndTicks > 30) break;
    }
    // Defensive: round advanced past 27 — we're done.
    if (sc.state.round > 27) break;
  }

  console.log(`captured ${snapshots.length} ticks across round 27`);

  // Trace grunt-count diffs across consecutive ticks. A drop tells us
  // something actually removed grunts; a "disappearance" without a drop
  // means our position-based matcher mis-tracked a long jump (movement).
  const countDrops: Array<{ tick: number; from: number; to: number; phase: Phase }> = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const cur = snapshots[i]!;
    if (cur.grunts.length < prev.grunts.length) {
      countDrops.push({
        tick: i,
        from: prev.grunts.length,
        to: cur.grunts.length,
        phase: cur.phase,
      });
    }
  }
  console.log(`\n=== ${countDrops.length} actual count-drop tick(s) ===`);
  for (const d of countDrops) {
    console.log(
      `  tick ${d.tick} (${d.phase}): ${d.from} → ${d.to} grunts (removed ${d.from - d.to})`,
    );
  }

  console.log(
    `life losses this round: ${lifeLosses
      .map((e) => `${labelOf(e.playerId)} (lives=${e.livesRemaining})`)
      .join(", ") || "none"}`,
  );
  console.log(
    `eliminations this round: ${eliminations.map((e) => labelOf(e.playerId)).join(", ") || "none"}`,
  );

  type Disappearance = {
    grunt: GruntFingerprint;
    atTickIdx: number;
    phaseBefore: Phase;
    phaseAfter: Phase;
    classification: string;
    detail: string;
  };
  const disappearances: Disappearance[] = [];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const cur = snapshots[i]!;
    if (prev.grunts.length === 0) continue;

    // Match each prev-grunt forward to a cur-grunt:
    //   - exact same tile (stayed put), or
    //   - cur-grunt within 1 4-dir step (moved one tile).
    // Unmatched prev-grunts = disappeared during this tick.
    // Match by position only — grunts are ownerless under the new model;
    // there's no per-grunt identity to align across ticks beyond position.
    const usedCur = new Set<number>();
    for (const pg of prev.grunts) {
      let matched = -1;
      for (let j = 0; j < cur.grunts.length; j++) {
        if (usedCur.has(j)) continue;
        const cg = cur.grunts[j]!;
        if (cg.row === pg.row && cg.col === pg.col) {
          matched = j;
          break;
        }
      }
      if (matched === -1) {
        // Try a 4-dir step.
        for (let j = 0; j < cur.grunts.length; j++) {
          if (usedCur.has(j)) continue;
          const cg = cur.grunts[j]!;
          const dr = Math.abs(cg.row - pg.row);
          const dc = Math.abs(cg.col - pg.col);
          if (dr + dc === 1) {
            matched = j;
            break;
          }
        }
      }
      if (matched !== -1) {
        usedCur.add(matched);
        continue;
      }
      // No forward match — pg disappeared between tick i-1 and i.
      const classification = classify(pg, prev, cur, gruntKilled, i);
      disappearances.push({
        grunt: pg,
        atTickIdx: i,
        phaseBefore: prev.phase,
        phaseAfter: cur.phase,
        classification: classification.tag,
        detail: classification.detail,
      });
    }
  }

  console.log(`\n=== ${disappearances.length} grunt disappearance(s) ===`);
  for (const d of disappearances) {
    console.log(
      `  tick ${d.atTickIdx} (phase ${d.phaseBefore}→${d.phaseAfter}): ` +
        `grunt at (${d.grunt.row},${d.grunt.col}) ` +
        `tile=${d.grunt.tile} zone=${d.grunt.zone} ` +
        `inInteriorOf=[${d.grunt.inInteriorOf.map(labelOf).join(",")}] ` +
        `inWallsOf=[${d.grunt.inWallsOf.map(labelOf).join(",")}] ` +
        `target=${d.grunt.targetTowerIdx ?? "none"}(zone ${d.grunt.targetTowerZone ?? "?"}) ` +
        `→ ${d.classification}` +
        (d.detail ? ` — ${d.detail}` : ""),
    );
  }

  // True bugs require an ACTUAL count drop AND an unexplained
  // classification. Position-only matching mis-tracks grunt movement
  // chains where adjacent slots get reassigned (greedy-matcher artifact),
  // so we cross-check against `countDrops` — only fail when both signals
  // line up. Disappearances on ticks that didn't actually drop the grunt
  // count are pure matcher artifacts; ignore.
  const realDropTicks = new Set(countDrops.map((d) => d.tick));
  const realUnknowns = disappearances.filter(
    (d) => d.classification === "UNKNOWN" && realDropTicks.has(d.atTickIdx),
  );
  if (realUnknowns.length > 0) {
    console.log(`\n=== ${realUnknowns.length} UNEXPLAINED real disappearance(s) ===`);
    for (const d of realUnknowns) {
      console.log(
        `  grunt (${d.grunt.row},${d.grunt.col}) on ${d.grunt.tile} ` +
          `in zone ${d.grunt.zone} — not enclosed, not in walls, ` +
          `zone owner alive, no life lost`,
      );
    }
  }

  // Post-fix pin: round 27 has exactly one real count drop, at end of
  // build (tick 4498), removing exactly the two in-zone grunts of Red's
  // freshly-reset zone. The cross-zone grunt that was targeting Red's
  // tower from Blue's zone must SURVIVE (Red is alive, towers revived).
  assert(
    realUnknowns.length === 0,
    `${realUnknowns.length} grunt(s) disappeared without a known cause — see log above`,
  );
  assert(
    countDrops.length === 1,
    `Expected exactly 1 count drop in round 27, got ${countDrops.length}`,
  );
  const drop = countDrops[0]!;
  assert(
    drop.from - drop.to === 2,
    `Expected 2 grunts removed at the round-end zone reset (in-zone only, ` +
      `no cross-zone wipe on life-loss); got ${drop.from - drop.to}. ` +
      `If this is 3, the evictEntitiesInZone cross-zone clause has regressed.`,
  );
  const droppedInBlueZone = disappearances.filter(
    (d) =>
      realDropTicks.has(d.atTickIdx) &&
      d.grunt.zone !== null &&
      sc.state.playerZones[1] === d.grunt.zone,
  );
  assert(
    droppedInBlueZone.length === 0,
    `Cross-zone wipe regressed: ${droppedInBlueZone.length} grunt(s) ` +
      `removed from Blue's zone during a Red life-loss zone reset.`,
  );
});

function snapshot(state: GameState, tickIdx: number): Snapshot {
  const aliveSlots: number[] = [];
  const eliminatedZones: number[] = [];
  const interiorByPlayer = new Map<number, ReadonlySet<number>>();
  const wallsByPlayer = new Map<number, ReadonlySet<number>>();
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    if (isPlayerEliminated(player)) {
      const zone = state.playerZones[player.id];
      if (zone !== undefined) eliminatedZones.push(zone);
    } else {
      aliveSlots.push(player.id);
    }
    if (player.interior) {
      interiorByPlayer.set(player.id, new Set(player.interior));
    }
    wallsByPlayer.set(player.id, new Set(player.walls));
  }
  return {
    tickIdx,
    phase: state.phase,
    round: state.round,
    timer: state.timer,
    grunts: state.grunts.map((g) => fingerprint(state, g)),
    aliveSlots,
    eliminatedZones,
    interiorByPlayer,
    wallsByPlayer,
  };
}

function fingerprint(state: GameState, grunt: Grunt): GruntFingerprint {
  const key = packTile(grunt.row, grunt.col);
  const tileEnum = state.map.tiles[grunt.row]?.[grunt.col];
  const tile = tileEnumLabel(tileEnum, state, grunt.row, grunt.col);
  const zone = state.map.zones?.[grunt.row]?.[grunt.col] ?? null;
  const inInteriorOf: number[] = [];
  const inWallsOf: number[] = [];
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    // Reading player.interior is safe — finalize calls recompute it; we only
    // observe between ticks, never mid-mutation.
    if (player.interior?.has(key)) inInteriorOf.push(player.id);
    if (player.walls.has(key)) inWallsOf.push(player.id);
  }
  let targetTowerZone: number | null = null;
  if (grunt.targetTowerIdx !== undefined) {
    const tower = state.map.towers[grunt.targetTowerIdx];
    if (tower) targetTowerZone = tower.zone;
  }
  return {
    row: grunt.row,
    col: grunt.col,
    tile,
    zone,
    inInteriorOf,
    inWallsOf,
    targetTowerIdx: grunt.targetTowerIdx,
    targetTowerZone,
  };
}

function tileEnumLabel(
  tileEnum: Tile | undefined,
  state: GameState,
  row: number,
  col: number,
): GruntFingerprint["tile"] {
  if (tileEnum === Tile.Grass) return "grass";
  if (tileEnum === Tile.Water) {
    const key = packTile(row, col);
    if (state.modern?.frozenTiles?.has(key)) return "frozenWater";
    return "water";
  }
  return "unknown";
}

function classify(
  grunt: GruntFingerprint,
  prev: Snapshot,
  cur: Snapshot,
  killedEvents: ReadonlyArray<{ tickIdx: number; row: number; col: number }>,
  curTickIdx: number,
): { tag: string; detail: string } {
  const key = packTile(grunt.row, grunt.col);
  // (1) GRUNT_KILLED event fired this tick at the grunt's tile.
  const killed = killedEvents.find(
    (e) =>
      e.tickIdx === curTickIdx && e.row === grunt.row && e.col === grunt.col,
  );
  if (killed) {
    return { tag: "GRUNT_KILLED (cannonball)", detail: "" };
  }
  // (2) Enclosed at PREV tick or fresh-enclosed at CUR tick. Finalize
  //     recomputes interior the same tick grunts disappear, so the
  //     "just got enclosed" case shows up only in cur.
  const enclosedPrev: number[] = [];
  const enclosedCur: number[] = [];
  for (const [pid, interior] of prev.interiorByPlayer) {
    if (interior.has(key)) enclosedPrev.push(pid);
  }
  for (const [pid, interior] of cur.interiorByPlayer) {
    if (interior.has(key)) enclosedCur.push(pid);
  }
  if (enclosedPrev.length > 0) {
    return {
      tag: "ENCLOSED (prev)",
      detail: `inside ${enclosedPrev.map(labelOf).join("+")}'s interior at T-1`,
    };
  }
  if (enclosedCur.length > 0) {
    return {
      tag: "ENCLOSED (cur recompute)",
      detail: `fresh interior at T includes the tile (${enclosedCur.map(labelOf).join("+")})`,
    };
  }
  // (3) Sitting on a wall tile (prev or cur).
  if (grunt.inWallsOf.length > 0) {
    return {
      tag: "MISPLACED-ON-WALL (prev)",
      detail: `wall owned by ${grunt.inWallsOf.map(labelOf).join("+")}`,
    };
  }
  const onCurWall: number[] = [];
  for (const [pid, walls] of cur.wallsByPlayer) {
    if (walls.has(key)) onCurWall.push(pid);
  }
  if (onCurWall.length > 0) {
    return {
      tag: "MISPLACED-ON-WALL (cur)",
      detail: `wall placed this tick by ${onCurWall.map(labelOf).join("+")}`,
    };
  }
  // (4) In a zone owned by an already-eliminated player at PREVIOUS tick.
  if (grunt.zone !== null && prev.eliminatedZones.includes(grunt.zone)) {
    return {
      tag: "DEAD_ZONE_SWEEP",
      detail: `zone ${grunt.zone} was already eliminated`,
    };
  }
  // (5) Targeting a tower in a now-eliminated zone (cross-zone via frozen).
  if (
    grunt.targetTowerZone !== null &&
    prev.eliminatedZones.includes(grunt.targetTowerZone)
  ) {
    return {
      tag: "DEAD_ZONE_TARGET_SWEEP",
      detail: `targeted tower in dead zone ${grunt.targetTowerZone}`,
    };
  }
  // (6) A player just lost a life or was eliminated this tick, and the
  //     grunt was in their zone or targeting one of their towers.
  const aliveDelta = prev.aliveSlots.filter(
    (s) => !cur.aliveSlots.includes(s),
  );
  if (aliveDelta.length > 0) {
    return {
      tag: "ZONE_RESET (life lost mid-tick)",
      detail: `players newly out: ${aliveDelta.map(labelOf).join(",")}`,
    };
  }
  return { tag: "UNKNOWN", detail: "no classified cause" };
}

function labelOf(playerId: number): string {
  return PLAYER_NAMES[playerId] ?? `slot${playerId}`;
}
