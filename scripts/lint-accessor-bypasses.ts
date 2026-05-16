/**
 * lint-accessor-bypasses — refuse inlined deep-state lookups that already
 * have a named helper. Each rule pairs a banned shape with the accessor
 * to use instead.
 *
 * Why: when several call sites repeat the same `state.X.Y[Z]?.W[V]`
 * shape, a typo or stale-index handling drift in one of them is invisible
 * at review time. A named helper (`getCannon`, `getGruntTargetTower`,
 * `hasAliveHouseAt`, `zoneAt`) gives a single place to evolve the contract
 * — but only if the lint pins new code to it. Pure type-safety can't catch
 * this because the inlined shape and the helper return the same type.
 *
 * The `map.zones` rule additionally bans raw aliases (`const zones =
 * state.map.zones`): aliasing the 2D array is the same loophole, just one
 * indirection later. `state.map.zones[row][col]` returns a `ZoneCell`
 * (`ZoneId | 0`, where `0` is the water sentinel); direct grid reads
 * silently let that sentinel flow into APIs expecting a validated
 * `ZoneId`. `zoneAt` filters water + out-of-bounds and returns
 * `ZoneId | undefined`, encoding the intent at the type level.
 *
 * Usage:
 *   deno run -A scripts/lint-accessor-bypasses.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

interface Rule {
  pattern: RegExp;
  helper: string;
  allow: ReadonlySet<string>;
}

interface Violation {
  rule: Rule;
  file: string;
  line: number;
  text: string;
}

/** Directories to scan for accessor-bypass violations. `dev/` and
 *  `scripts/` are included because dev-only browser tools and CLI
 *  fixture/debug scripts read the same GameState shape and would
 *  otherwise bypass the lint silently. */
const SCAN_DIRS = [
  join(process.cwd(), "src"),
  join(process.cwd(), "dev"),
  join(process.cwd(), "scripts"),
];
const RULES: Rule[] = [
  {
    pattern: /state\.map\.towers\[\w+\.targetTowerIdx\]/,
    helper: "getGruntTargetTower(state, grunt)",
    allow: new Set(["src/game/grunt-movement.ts"]),
  },
  {
    pattern: /state\.players\[[^\]]+\]\??\.cannons\[[^\]]+\]/,
    helper: "getCannon(state, playerId, cannonIdx)",
    allow: new Set(["src/shared/core/occupancy-queries.ts"]),
  },
  {
    pattern: /state\.map\.houses\.some\(/,
    helper: "hasAliveHouseAt(state, r, c)",
    allow: new Set(["src/shared/core/board-occupancy.ts"]),
  },
  {
    // Catches both `map.zones[r][c]` reads and `const zones = state.map.zones`
    // aliases. Allow-list:
    //   - spatial.ts             — defines `zoneAt`; the in-allow-list raw access
    //   - zone-id.ts             — docstring reference
    //   - map-generation.ts      — fresh flood-fill allocates raw ids
    //   - zone-recompute.ts      — re-flood-fill writes raw cells (trust boundary)
    //   - runtime-camera.ts, render-ui-overlays.ts — pass the raw 2D array
    //     into `castleCenterPx` (a spatial helper that takes the array shape).
    //     If `castleCenterPx` is ever refactored to take `GameMap`, drop these.
    //   - dev/dev-console-grid.ts — debug surface for raw cells
    //   - scripts/fixture-cli.ts   — fixture/debug CLI does its own
    //     zone-boundary flood-fill validation
    pattern: /\bmap\.zones\b/,
    helper: "zoneAt(map, row, col)",
    allow: new Set([
      "src/shared/core/spatial.ts",
      "src/shared/core/zone-id.ts",
      "src/game/map-generation.ts",
      "src/game/zone-recompute.ts",
      "src/runtime/runtime-camera.ts",
      "src/render/render-ui-overlays.ts",
      "dev/dev-console-grid.ts",
      "scripts/fixture-cli.ts",
    ]),
  },
];
const violations: Violation[] = [];

for (const dir of SCAN_DIRS) scanDir(dir);

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
      for (const rule of RULES) {
        if (rule.allow.has(rel)) continue;
        if (rule.pattern.test(line)) {
          violations.push({ rule, file: rel, line: i + 1, text: trimmed });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`✗ ${violations.length} accessor-bypass violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
    console.error(`    → use \`${v.rule.helper}\``);
  }
  process.exit(1);
}

console.log(
  "✓ accessor-bypasses: no inlined deep-state lookups that have a helper",
);
