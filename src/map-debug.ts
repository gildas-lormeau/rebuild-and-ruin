/**
 * Debug / text-based map rendering.
 *
 * Moved out of map-generation.ts to keep generation logic separate from
 * debug display. Used only by main.ts for the ASCII sidebar.
 */

import { GRID_COLS, GRID_ROWS, Tile } from "./grid.ts";
import type { TilePos } from "./geometry-types.ts";
import type { GameMap, Tower } from "./map-generation.ts";
import {
  isCannonAlive,
  forEachCannonTile,
  forEachTowerTile,
  packTile,
} from "./spatial.ts";

export interface MapOverlay {
  walls?: Set<number>[]; // per-player wall sets (key = row*GRID_COLS+col)
  interior?: Set<number>[]; // per-player interior sets
  cannons?: { row: number; col: number; hp: number; super?: boolean }[][]; // per-player cannon arrays
  grunts?: TilePos[];
  houses?: { row: number; col: number; alive: boolean }[];
  towerAlive?: boolean[]; // parallel to map.towers
  burningPits?: TilePos[];
  bonusSquares?: TilePos[];
}

export function mapToString(map: GameMap, overlay?: MapOverlay): string {
  // Build tower labels: zone index (1-based) + tower index within zone (1-based)
  const zoneIds = [...new Set(map.towers.map((t) => t.zone))];
  const zoneTowerCount = new Map<number, number>();
  const towerLabels = new Map<Tower, string>();
  for (const t of map.towers) {
    const zi = zoneIds.indexOf(t.zone) + 1;
    const ti = (zoneTowerCount.get(t.zone) ?? 0) + 1;
    zoneTowerCount.set(t.zone, ti);
    towerLabels.set(t, `${zi}${ti}`);
  }

  // Build lookup sets from overlay
  const playerWalls = overlay?.walls ?? [];
  const playerInterior = overlay?.interior ?? [];
  const gruntSet = new Set<number>();
  for (const g of overlay?.grunts ?? []) gruntSet.add(packTile(g.row, g.col));
  const houseSet = new Set<number>();
  for (const h of overlay?.houses ?? [])
    if (h.alive) houseSet.add(packTile(h.row, h.col));
  const cannonSet = new Map<number, string>(); // key → char
  const playerChars = ["R", "B", "G"]; // Red, Blue, Gold
  for (let pi = 0; pi < (overlay?.cannons?.length ?? 0); pi++) {
    for (const c of overlay!.cannons![pi]!) {
      const ch = isCannonAlive(c)
        ? c.super
          ? (playerChars[pi]?.toUpperCase() ?? "S")
          : (playerChars[pi]?.toLowerCase() ?? "c")
        : "x";
      forEachCannonTile(c, (_r, _c, key) => cannonSet.set(key, ch));
    }
  }
  const pitSet = new Set<number>();
  for (const p of overlay?.burningPits ?? [])
    pitSet.add(packTile(p.row, p.col));
  const bonusSet = new Set<number>();
  for (const bs of overlay?.bonusSquares ?? [])
    bonusSet.add(packTile(bs.row, bs.col));

  // Dead tower set
  const deadTowerTiles = new Set<number>();
  if (overlay?.towerAlive) {
    for (let i = 0; i < map.towers.length; i++) {
      if (!overlay.towerAlive[i]) {
        const t = map.towers[i]!;
        forEachTowerTile(t, (_r, _c, key) => deadTowerTiles.add(key));
      }
    }
  }

  // Column header: tens row, then units row
  const pad = "   "; // left margin to align with row labels
  let tens = pad;
  let units = pad;
  for (let c = 0; c < GRID_COLS; c++) {
    tens += Math.floor(c / 10).toString();
    units += (c % 10).toString();
  }

  const lines: string[] = [tens, units];
  for (let r = 0; r < GRID_ROWS; r++) {
    let line = r.toString().padStart(2, "0") + " ";
    let c = 0;
    while (c < GRID_COLS) {
      const key = packTile(r, c);

      // Towers (2-char label)
      const tower = map.towers.find(
        (t) => c >= t.col && c <= t.col + 1 && r >= t.row && r <= t.row + 1,
      );
      if (tower) {
        if (c === tower.col) {
          if (deadTowerTiles.has(key)) {
            line += "XX";
          } else {
            line += towerLabels.get(tower)!;
          }
          c += 2;
        } else {
          c++;
        }
        continue;
      }

      // Grunts
      if (gruntSet.has(key)) {
        line += "G";
        c++;
        continue;
      }

      // Houses
      if (houseSet.has(key)) {
        line += "H";
        c++;
        continue;
      }

      // Burning pits
      if (pitSet.has(key)) {
        line += "*";
        c++;
        continue;
      }

      // Bonus squares
      if (bonusSet.has(key)) {
        line += "$";
        c++;
        continue;
      }

      // Cannons
      const cc = cannonSet.get(key);
      if (cc) {
        line += cc;
        c++;
        continue;
      }

      // Walls & interior (check each player)
      let found = false;
      for (let pi = 0; pi < playerWalls.length; pi++) {
        if (playerWalls[pi]!.has(key)) {
          line += "#";
          found = true;
          break;
        }
        if (playerInterior[pi]?.has(key)) {
          line += ":";
          found = true;
          break;
        }
      }
      if (found) {
        c++;
        continue;
      }

      // Terrain
      switch (map.tiles[r]![c]) {
        case Tile.Water:
          line += "~";
          break;
        default:
          line += " ";
          break;
      }
      c++;
    }
    lines.push(line);
  }
  return lines.join("\n");
}
