/**
 * Phase-transition lint — enforce that banner subtitle constants are only
 * used in the two canonical transition files (host + watcher).
 *
 * BANNER_*_SUB constants define the subtitle text for each phase banner.
 * They should only appear in the files that orchestrate phase transitions.
 *
 * Usage:
 *   deno run -A scripts/lint-phase-transitions.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  message: string;
}

const SRC = join(process.cwd(), "src");
/** Files allowed to import BANNER_*_SUB constants. */
const ALLOWED_SUB_FILES = new Set([
  "banner-messages.ts",
  "runtime-phase-ticks.ts",
  "online-phase-transitions.ts",
]);

main();

function main(): void {
  const violations: Violation[] = [];
  const files = collectFiles(SRC);

  for (const filePath of files) {
    const base = basename(filePath);
    if (ALLOWED_SUB_FILES.has(base)) continue;

    const content = readFileSync(filePath, "utf-8");
    const relPath = relative(process.cwd(), filePath);

    // No file (except allowed) should import BANNER_*_SUB
    if (/BANNER_\w+_SUB/.test(content)) {
      const lines = content.split("\n");
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx]!;
        if (/BANNER_\w+_SUB/.test(line) && /import/.test(line)) {
          violations.push({
            file: relPath,
            message: `Line ${idx + 1}: imports BANNER_*_SUB directly — only transition files should use these`,
          });
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `\u2714 No phase-transition violations (${files.length} files checked)`,
    );
    process.exit(0);
  }

  console.log(
    `\u2718 ${violations.length} phase-transition violation(s) found:\n`,
  );
  for (const violation of violations) {
    console.log(`  ${violation.file}: ${violation.message}`);
  }
  process.exit(1);
}

function collectFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...collectFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      result.push(full);
    }
  }
  return result;
}
