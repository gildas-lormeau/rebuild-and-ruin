/**
 * lint-raw-playwright — forbid raw `page.waitForFunction(` outside the
 * dedicated wrapper in `test/e2e-helpers.ts`.
 *
 * Context: Playwright's `page.waitForFunction(fn, arg?, options?)` treats
 * a 2nd-arg options object as `arg`, silently dropping custom timeouts
 * to the 30s default. This bit us once already (online-game-over.test.ts
 * was timing out with an intended 120s budget that was actually 30s).
 *
 * Use `waitForPageFn(page, fn, timeoutMs)` or `waitForPageExpr(page,
 * expression, timeoutMs)` from `test/e2e-helpers.ts` instead.
 *
 * Usage:
 *   deno run -A scripts/lint-raw-playwright.ts
 *
 * Exits 1 if any forbidden call appears in test/ or scripts/.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

const SCAN_DIRS = [join(process.cwd(), "test"), join(process.cwd(), "scripts")];
const ALLOWED_FILES = new Set([
  "test/e2e-helpers.ts", // the wrapper itself
  "scripts/lint-raw-playwright.ts", // this lint script's own docs reference the pattern
]);
const BANNED = /\.waitForFunction\s*\(/;
const violations: Violation[] = [];

for (const dir of SCAN_DIRS) scanDir(dir);

function scanDir(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      scanDir(full);
    } else if (entry.endsWith(".ts")) {
      scanFile(full);
    }
  }
}

function scanFile(filePath: string): void {
  const rel = relative(process.cwd(), filePath);
  if (ALLOWED_FILES.has(rel)) return;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (line.includes("eslint-disable")) continue;
    if (BANNED.test(line)) {
      violations.push({
        file: rel,
        line: li + 1,
        snippet: line.trim(),
      });
    }
  }
}

if (violations.length === 0) {
  console.log("✔ No raw page.waitForFunction calls outside e2e-helpers.ts");
  process.exit(0);
} else {
  console.log(
    `✘ ${violations.length} raw page.waitForFunction call(s) — use waitForPageFn / waitForPageExpr from test/e2e-helpers.ts instead:\n`,
  );
  for (const vi of violations) {
    console.log(`  ${vi.file}:${vi.line}  ${vi.snippet}`);
  }
  process.exit(1);
}
