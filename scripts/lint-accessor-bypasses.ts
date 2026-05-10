/**
 * lint-accessor-bypasses — refuse inlined deep-state lookups that already
 * have a named helper. Each rule pairs a banned shape with the accessor
 * to use instead.
 *
 * Why: when several call sites repeat the same `state.X.Y[Z]?.W[V]`
 * shape, a typo or stale-index handling drift in one of them is invisible
 * at review time. A named helper (`getCannon`, `getGruntTargetTower`,
 * `hasAliveHouseAt`) gives a single place to evolve the contract — but
 * only if the lint pins new code to it. Pure type-safety can't catch this
 * because the inlined shape and the helper return the same type.
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

const SCAN_DIR = join(process.cwd(), "src");
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
];
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
