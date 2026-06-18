/**
 * Synthetic "one of every entity" overlay for shader pre-warming
 * (`renderer.warmEntityShaders`). Positions are arbitrary — only the set of
 * distinct shader PROGRAMS matters (program = defines + customProgramCacheKey,
 * not color/geometry/texture). Cannon tiers and rampart shield tiers reuse a
 * sibling's program, so we warm one entity per distinct program — not every
 * named variant (tier_1 + super_gun + one rampart cover all cannon programs).
 */

import {
  type Cannon,
  CannonMode,
  type DestroyedWall,
  type Grunt,
} from "../../shared/core/battle-types.ts";
import { WALL_DESTROY_ANIM_DURATION } from "../../shared/core/game-constants.ts";
import { Phase } from "../../shared/core/game-phase.ts";
import type { GameMap, TowerIdx } from "../../shared/core/geometry-types.ts";
import { GRID_COLS, TILE_SIZE, type TileKey } from "../../shared/core/grid.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import type {
  CastleData,
  OverlayBalloon,
  OverlayCannonball,
  RenderOverlay,
} from "../../shared/ui/overlay-types.ts";

/** Anchor the warmup cluster away from the map edges so tiles are valid. */
const WARM_ROW = 8;
const WARM_COL = 8;
const PID0 = 0 as ValidPlayerId;

/** Build a synthetic overlay containing one instance of every entity
 *  family / variant the battle phase renders. */
export function buildWarmupOverlay(map: GameMap): RenderOverlay {
  const grunts: Grunt[] = [
    { row: WARM_ROW + 6, col: WARM_COL, blockedRounds: 0, facing: 0 },
    {
      row: WARM_ROW + 6,
      col: WARM_COL + 2,
      blockedRounds: 0,
      facing: 0,
      kind: "catapult",
    },
  ];

  // Towers/houses come from the real map; mark the first couple enclosed
  // so the home_tower + secondary_tower geometry/tint variants both link.
  const enclosedTowers = new Map<TowerIdx, ValidPlayerId>();
  const homeTowerIndices = new Set<TowerIdx>();
  if (map.towers.length > 0) {
    enclosedTowers.set(0 as TowerIdx, PID0);
    homeTowerIndices.add(0 as TowerIdx);
  }
  if (map.towers.length > 1) enclosedTowers.set(1 as TowerIdx, PID0);

  return {
    phase: Phase.BATTLE,
    castles: [
      warmCastle(0, CannonMode.NORMAL, 1, true),
      warmCastle(5, CannonMode.SUPER, 2),
      warmCastle(10, CannonMode.BALLOON, 3),
      warmCastle(15, CannonMode.RAMPART, 1),
    ],
    entities: {
      grunts,
      burningPits: [{ row: WARM_ROW + 8, col: WARM_COL, roundsLeft: 3 }],
      enclosedTowers,
      homeTowerIndices,
      towerAlive: map.towers.map(() => true),
    },
    battle: {
      cannonballs: [
        warmCannonball(0, {}),
        warmCannonball(1, { incendiary: true }),
        warmCannonball(2, { mortar: true }),
      ],
      crosshairs: [
        { x: px(WARM_COL), y: px(WARM_ROW), playerId: PID0, cannonReady: true },
      ],
      impacts: [{ row: WARM_ROW, col: WARM_COL + 7, age: 0.1 }],
      destroyedWalls: warmDestroyedWalls(),
      cannonDestroys: [
        { row: WARM_ROW + 2, col: WARM_COL, size: 2, age: 0.1 },
        { row: WARM_ROW + 2, col: WARM_COL + 3, size: 3, age: 0.1 },
      ],
      gruntKills: [{ row: WARM_ROW + 4, col: WARM_COL, age: 0.1 }],
      houseDestroys: [{ row: WARM_ROW + 4, col: WARM_COL + 2, age: 0.1 }],
      balloons: [warmBalloon()],
    },
  };
}

/** A castle carrying one cannon of `mode` at the given tier, plus a short
 *  wall run so the walls manager links its tile-mesh variants. With
 *  `withDeadCannon`, an extra hp:0 cannon is added (kept separate from the
 *  live one so the live variant still links) — the debris manager builds a
 *  bucket for it, warming the shared debris shader program. */
function warmCastle(
  rowOffset: number,
  mode: CannonMode,
  cannonTier: 1 | 2 | 3,
  withDeadCannon = false,
): CastleData {
  const row = WARM_ROW + rowOffset;
  const walls = new Set<TileKey>([
    key(row, WARM_COL),
    key(row, WARM_COL + 1),
    key(row, WARM_COL + 2),
    key(row + 1, WARM_COL),
  ]);
  const cannons: Cannon[] = [
    {
      row: row + 3,
      col: WARM_COL,
      hp: 4,
      mode,
    },
  ];
  if (withDeadCannon) {
    cannons.push({
      row: row + 3,
      col: WARM_COL + 4,
      hp: 0,
      mode: CannonMode.NORMAL,
    });
  }
  return {
    walls,
    interior: new Set<TileKey>(),
    cannons,
    playerId: PID0,
    // Mark one wall as damaged so the reinforced-walls crack variant links.
    damagedWalls: new Set<TileKey>([key(row, WARM_COL + 2)]),
    cannonTier,
  };
}

function key(row: number, col: number): TileKey {
  return (row * GRID_COLS + col) as TileKey;
}

function warmCannonball(
  col: number,
  flags: { incendiary?: true; mortar?: true },
): OverlayCannonball {
  return {
    x: px(WARM_COL + col),
    y: px(WARM_ROW),
    startX: px(WARM_COL + col),
    startY: px(WARM_ROW + 4),
    progress: 0.5,
    altitude: 40,
    ...flags,
  };
}

function warmBalloon(): OverlayBalloon {
  return {
    x: px(WARM_COL),
    y: px(WARM_ROW),
    targetX: px(WARM_COL + 4),
    targetY: px(WARM_ROW),
    progress: 0.5,
  };
}

function px(tile: number): number {
  return tile * TILE_SIZE + TILE_SIZE / 2;
}

/** Two destroyed-wall entries: one fresh (drives the sink + dust meshes),
 *  one aged into the fire window (drives the wall-burn flame/smoke meshes).
 *  The wall-burns manager only builds meshes for entries inside
 *  `[WALL_DESTROY_ANIM_DURATION, +WALL_BURN_DURATION)`. */
function warmDestroyedWalls(): DestroyedWall[] {
  return [
    {
      row: WARM_ROW,
      col: WARM_COL + 5,
      age: 0.05,
      damaged: false,
      playerId: PID0,
    },
    {
      row: WARM_ROW,
      col: WARM_COL + 6,
      age: WALL_DESTROY_ANIM_DURATION + 0.05,
      damaged: true,
      playerId: PID0,
    },
  ];
}
