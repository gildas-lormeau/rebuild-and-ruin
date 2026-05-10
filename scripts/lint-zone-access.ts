/**
 * lint-zone-access — every reference to `map.zones` must go through the
 * `zoneAt(map, row, col)` accessor. Both raw reads (`map.zones[r][c]`) and
 * raw aliases (`const zones = state.map.zones`) are banned: aliasing the
 * 2D array is the same loophole, just one indirection later.
 *
 * Why: `state.map.zones[row][col]` returns a `ZoneCell` (`ZoneId | 0`),
 * where `0` is the water sentinel. Direct grid reads silently let that
 * sentinel flow into APIs expecting a validated `ZoneId`, sidestepping
 * the brand. `zoneAt` filters water + out-of-bounds and returns
 * `ZoneId | undefined`, encoding the intent at the type level.
 *
 * Allow-list:
 *   - spatial.ts        — defines `zoneAt`; the in-allow-list raw access
 *   - zone-id.ts        — docstring reference
 *   - map-generation.ts — fresh flood-fill allocates raw ids
 *   - zone-recompute.ts — re-flood-fill writes raw cells (trust boundary)
 *   - dev-console-grid.ts — debug surface for raw cells
 *   - runtime-camera.ts, render-ui-overlays.ts — pass the raw 2D array
 *     into `castleCenterPx` (a spatial helper that takes the array shape).
 *     If `castleCenterPx` is ever refactored to take `GameMap`, drop these.
 *
 * Usage:
 *   deno run -A scripts/lint-zone-access.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  line: number;
  text: string;
}

const SCAN_DIR = join(process.cwd(), "src");
const ALLOW = new Set<string>([
  "src/shared/core/spatial.ts",
  "src/shared/core/zone-id.ts",
  "src/game/map-generation.ts",
  "src/game/zone-recompute.ts",
  "src/runtime/dev-console-grid.ts",
  "src/runtime/runtime-camera.ts",
  "src/render/render-ui-overlays.ts",
]);
const PATTERN = /\bmap\.zones\b/;
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
    const rel = relative(process.cwd(), full);
    if (ALLOW.has(rel)) continue;
    const src = readFileSync(full, "utf-8");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      )
        continue;
      if (PATTERN.test(line)) {
        violations.push({ file: rel, line: i + 1, text: trimmed });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`✗ ${violations.length} zone-access violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error(
    "  Use `zoneAt(map, row, col)` from spatial.ts instead of raw `map.zones`",
  );
  console.error(
    "  access (including `const zones = state.map.zones` aliases).",
  );
  process.exit(1);
}

console.log("✓ zone-access: all grid reads go through zoneAt()");
