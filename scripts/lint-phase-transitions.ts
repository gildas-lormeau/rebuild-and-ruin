/**
 * Phase-transition lint — enforce that banner subtitle constants are only
 * used by the canonical phase-transition machine.
 *
 * BANNER_*_SUB constants define the subtitle text for each phase banner.
 * Under the clone-everywhere model there is a single transition table
 * (src/runtime/phase-machine.ts) whose display steps own them; any other
 * reference means phase-banner text is leaking out of the machine.
 *
 * Any mention of a BANNER_*_SUB identifier outside the allowlist is a
 * violation — matching bare references (not just import lines) is what
 * keeps multi-line import statements from slipping through.
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
/** Files allowed to reference BANNER_*_SUB constants: the definition site
 *  and the one transition table that consumes them. */
const ALLOWED_SUB_FILES = new Set(["banner-messages.ts", "phase-machine.ts"]);

main();

function main(): void {
  const violations: Violation[] = [];
  const files = collectFiles(SRC);

  for (const filePath of files) {
    const base = basename(filePath);
    if (ALLOWED_SUB_FILES.has(base)) continue;

    const content = readFileSync(filePath, "utf-8");
    const relPath = relative(process.cwd(), filePath);

    // No file (except allowed) should reference BANNER_*_SUB at all —
    // a bare-identifier match catches multi-line imports, re-exports,
    // and direct uses alike.
    if (/BANNER_\w+_SUB/.test(content)) {
      const lines = content.split("\n");
      for (let idx = 0; idx < lines.length; idx++) {
        if (/BANNER_\w+_SUB/.test(lines[idx]!)) {
          violations.push({
            file: relPath,
            message: `Line ${idx + 1}: references BANNER_*_SUB — phase-banner subtitles belong to the phase machine only`,
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
