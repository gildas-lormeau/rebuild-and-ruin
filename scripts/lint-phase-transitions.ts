/**
 * Phase-transition lint — enforce that banner subtitles are only set via
 * shared helpers in phase-transition-shared.ts, and that showBanner is not
 * called directly in online phase-transition files.
 *
 * Checks:
 * 1. BANNER_*_SUB constants must only be imported by phase-transition-shared.ts.
 *    Any other file importing them is bypassing the shared helpers.
 * 2. online-phase-transitions.ts must not call showBanner directly — all banner
 *    calls should go through showCannonPhaseBanner / showBattlePhaseBanner /
 *    showBuildPhaseBanner.
 *
 * Usage:
 *   npx tsx scripts/lint-phase-transitions.ts
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import process from "node:process";

const SRC = join(process.cwd(), "src");

/** The only file allowed to import BANNER_*_SUB constants. */
const SHARED_FILE = "phase-transition-shared.ts";

/** Files that may re-export or define BANNER_*_SUB (the source of truth). */
const DEFINITION_FILES = new Set(["phase-banner.ts", SHARED_FILE]);

/** Online transition files that must use shared helpers instead of raw showBanner. */
/** Files that must use shared helpers instead of raw showBanner for phase transitions. */
const GUARDED_TRANSITION_FILES = new Set([
  "online-phase-transitions.ts",
  "runtime-host-battle-ticks.ts",
  "runtime-phase-ticks.ts",
  "runtime-selection.ts",
]);

interface Violation {
  file: string;
  message: string;
}

function main(): void {
  const violations: Violation[] = [];
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

  for (const file of files) {
    if (DEFINITION_FILES.has(file)) continue;

    const content = readFileSync(join(SRC, file), "utf-8");

    // Check 1: No file (except shared + definition) should import BANNER_*_SUB
    if (/BANNER_\w+_SUB/.test(content)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/BANNER_\w+_SUB/.test(line) && /import/.test(line)) {
          violations.push({
            file,
            message: `Line ${i + 1}: imports BANNER_*_SUB directly — use shared helpers from ${SHARED_FILE} instead`,
          });
        }
      }
    }

    // Check 2: Guarded files must not call showBanner directly for phase transitions
    if (GUARDED_TRANSITION_FILES.has(file)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Match direct showBanner calls (not imports, not type annotations, not comments)
        if (
          /\.showBanner\(/.test(line) &&
          !/^\s*\/\//.test(line) &&
          !/import/.test(line)
        ) {
          violations.push({
            file,
            message: `Line ${i + 1}: direct showBanner() call — use shared helpers (showCannonPhaseBanner, showBattlePhaseBanner, showBuildPhaseBanner)`,
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
  for (const v of violations) {
    console.log(`  ${v.file}: ${v.message}`);
  }
  process.exit(1);
}

main();
