/**
 * lint-tile-mutators — every modifier file that calls `setWater(` or
 * `setGrass(` must also call `recomputeMapZones(`.
 *
 * Why: `state.map.zones` is a flood-fill cache of grass connectivity.
 * After a tile mutation the array goes stale; cached `tower.zone` and
 * `state.playerZones[pid]` then disagree with the live tile grid.
 * `recomputeMapZones` re-runs the flood-fill (with tower-anchored ID
 * stability). Any tile mutator that skips it silently desyncs zones.
 *
 * Allow-list: the recompute helper itself, and the spatial helpers
 * (where setWater/setGrass are defined). Sinkhole's apply destroys
 * structures via `setWater` — the helper file scope ends inside one
 * function, so we lint per file rather than per function.
 *
 * Usage:
 *   deno run -A scripts/lint-tile-mutators.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  reason: string;
}

const SCAN_DIR = join(process.cwd(), "src/game/modifiers");
const ALLOW = new Set<string>([
  // Frozen river sets a passability flag, not tile types — never mutates
  // `state.map.tiles`. Skip.
  "frozen-river.ts",
]);
const violations: Violation[] = [];

scanDir(SCAN_DIR);

function scanDir(dir: string) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      scanDir(full);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (ALLOW.has(entry)) continue;
    const src = readFileSync(full, "utf-8");
    const mutates = /\b(setWater|setGrass)\s*\(/.test(src);
    if (!mutates) continue;
    const recomputes = /\brecomputeMapZones\s*\(/.test(src);
    if (recomputes) continue;
    violations.push({
      file: relative(process.cwd(), full),
      reason:
        "calls setWater/setGrass without recomputeMapZones — zones will go stale",
    });
  }
}

if (violations.length > 0) {
  console.error(`✗ ${violations.length} tile-mutator violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}`);
  }
  process.exit(1);
}

console.log("✓ tile-mutators: all modifier tile mutations recompute zones");
