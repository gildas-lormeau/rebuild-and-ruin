/**
 * lint-test-timeouts — ban `maxTicks` and `maxFrames` tokens in test/ and
 * test fixture JSON.
 *
 * Context: the test API used to have a unit mismatch — headless budgets
 * were measured in sim frames (`maxFrames` / `maxTicks`), E2E budgets in
 * wall-clock ms (`timeoutMs`). This inconsistency caused real bugs where
 * agents mixed up units mid-flow. The API was unified on `{ timeoutMs }`
 * everywhere; this script guards the migration.
 *
 * Usage:
 *   deno run -A scripts/lint-test-timeouts.ts
 *
 * Exits 1 if any banned token appears in test/*.{ts,json}.
 *
 * Escape hatch: if you genuinely need a variable called `maxTicks`
 * (e.g. re-exporting from a third-party lib), wrap the line in a
 * `// eslint-disable` comment — this script honours it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

const SCAN_DIRS = [join(process.cwd(), "test")];
const BANNED = /\b(maxTicks|maxFrames)\b/;
const violations: Violation[] = [];

for (const dir of SCAN_DIRS) scanDir(dir);

function scanDir(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      scanDir(full);
    } else if (/\.(ts|json)$/.test(entry)) {
      scanFile(full);
    }
  }
}

function scanFile(filePath: string): void {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (line.includes("eslint-disable")) continue;
    if (BANNED.test(line)) {
      violations.push({
        file: relative(process.cwd(), filePath),
        line: li + 1,
        snippet: line.trim(),
      });
    }
  }
}

if (violations.length === 0) {
  console.log("✔ No maxTicks / maxFrames tokens in test/");
  process.exit(0);
} else {
  console.log(
    `✘ ${violations.length} maxTicks / maxFrames reference(s) — use { timeoutMs } instead:\n`,
  );
  for (const vi of violations) {
    console.log(`  ${vi.file}:${vi.line}  ${vi.snippet}`);
  }
  process.exit(1);
}
