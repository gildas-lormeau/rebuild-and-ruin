/**
 * lint-raf-mainloop — ensure `mainLoop` is scheduled from exactly two sites.
 *
 * The runtime owns a single rAF chain. `mainLoop` self-schedules from
 * inside itself (assembly.ts), and `createGameRuntime` kicks the chain
 * once at startup (runtime-composition.ts). Any other site that calls
 * `requestFrame(...mainLoop...)` would create a parallel chain — the
 * exact bug class that motivated this rule (see commit history around
 * "never-stop loop" refactor).
 *
 * Usage:
 *   deno run -A scripts/lint-raf-mainloop.ts
 *
 * Exits 1 if a disallowed call site is found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

const SCAN_DIRS = [join(process.cwd(), "src"), join(process.cwd(), "server")];
/** Files allowed to call `requestFrame(mainLoop)`:
 *  - assembly.ts: the self-schedule inside `mainLoop` itself.
 *  - runtime-composition.ts: the single kickoff inside `createGameRuntime`. */
const ALLOWED_FILES = new Set([
  "src/runtime/assembly.ts",
  "src/runtime/runtime-composition.ts",
]);
/** Match `requestFrame(...mainLoop...)` across multiple lines. The argument
 *  list `([^)]*)` greedily consumes whitespace + identifiers, so calls like
 *  `timing.requestFrame(\n  runtime.mainLoop,\n);` still match. Aliasing
 *  (`const f = mainLoop; requestFrame(f);`) bypasses this — accepted as
 *  documented best-effort, since the legitimate call sites are tiny. */
const PATTERN = /requestFrame\s*\([^)]*\bmainLoop\b[^)]*\)/;

main();

function main(): void {
  const files = SCAN_DIRS.flatMap(collectFiles);
  const violations: Violation[] = [];

  for (const filePath of files) {
    findViolations(filePath, readFileSync(filePath, "utf-8"), violations);
  }

  if (violations.length === 0) {
    console.log(
      `✔ No disallowed requestFrame(mainLoop) sites (${files.length} files checked)`,
    );
    process.exit(0);
  }

  console.log(
    `✘ ${violations.length} disallowed requestFrame(mainLoop) site(s) found:\n`,
  );
  for (const violation of violations) {
    console.log(`  ${violation.file}:${violation.line}: ${violation.snippet}`);
  }
  console.log(
    `\nOnly these files may schedule mainLoop:\n  ${[...ALLOWED_FILES].join("\n  ")}`,
  );
  process.exit(1);
}

function collectFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

function findViolations(
  filePath: string,
  content: string,
  out: Violation[],
): void {
  const relPath = relative(process.cwd(), filePath);
  if (ALLOWED_FILES.has(relPath)) return;

  const stripped = stripStringsAndComments(content);
  const rawLines = content.split("\n");
  const globalPattern = new RegExp(PATTERN.source, "g");

  for (const match of stripped.matchAll(globalPattern)) {
    const lineIdx = stripped.slice(0, match.index).split("\n").length - 1;
    out.push({
      file: relPath,
      line: lineIdx + 1,
      snippet: rawLines[lineIdx]!.trim(),
    });
  }
}

/** Remove string literals and comments so matches inside them are ignored.
 *  Replaces content with spaces to preserve column positions. */
function stripStringsAndComments(source: string): string {
  return source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (match) => " ".repeat(match.length),
  );
}
