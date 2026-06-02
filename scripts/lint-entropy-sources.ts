/**
 * lint-entropy-sources — flag raw entropy / wall-clock sources inside the
 * pure-simulation domains (`src/game/`, `src/ai/`).
 *
 * Why: the whole architecture rests on the simulation being deterministic —
 * the network parity gate (`test/network-vs-local.test.ts`) and the
 * byte-for-byte replays in `test/determinism-fixtures/` only pass because two
 * peers fed the same inputs compute identical state. `Math.random()`,
 * `Date.now()`, `new Date()`, and `performance.now()` are non-deterministic
 * by construction: each peer reads a different value, so any one of them
 * feeding a gameplay decision is a silent cross-peer desync.
 *
 * The sim already has the deterministic substitutes: `state.rng` (the synced
 * PRNG) for randomness and the `now` / `dt` tick parameters for time. Sibling
 * lints (`lint-ai-rng-isolation`, `lint-controller-ctor-rng`) already guard
 * *how* `state.rng` is consumed; this one guards the raw sources that bypass
 * it entirely. Like those siblings, the bug otherwise surfaces only at the
 * very bottom of the test pyramid (and only if a fixture happens to exercise
 * the path), so we catch it at edit time here.
 *
 * Scope: `src/game/**` and `src/ai/**` only. These are pure simulation. The
 * networking (`online/`), loop (`runtime/`), recorder (`input/`), and render
 * domains legitimately read the wall clock (timeouts, heartbeats, frame
 * timing, filenames) and are intentionally out of scope.
 *
 * Allowed patterns (not flagged):
 * - Mentions inside strings or comments (stripped before scanning)
 * - Sites annotated with `// lint:allow-entropy -- <reason>` on the same line,
 *   or anywhere in the contiguous `//` comment block immediately above the
 *   line (e.g. cosmetic SFX selection, which must NOT advance state.rng).
 *
 * Usage:
 *   deno run -A scripts/lint-entropy-sources.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  line: number;
  source: string;
  snippet: string;
}

const SRC = join(process.cwd(), "src");
const SCOPED_DIRS = [join(SRC, "game"), join(SRC, "ai")];
const ALLOW_MARKER = /lint:allow-entropy/;
const ENTROPY_SOURCES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "Math.random()", pattern: /\bMath\.random\s*\(/ },
  { name: "Date.now()", pattern: /\bDate\.now\s*\(/ },
  { name: "new Date()", pattern: /\bnew\s+Date\b/ },
  { name: "performance.now()", pattern: /\bperformance\.now\s*\(/ },
];

main();

function main(): void {
  const files = SCOPED_DIRS.flatMap(collectFiles);
  const violations: Violation[] = [];

  for (const filePath of files) {
    findViolations(filePath, readFileSync(filePath, "utf-8"), violations);
  }

  if (violations.length === 0) {
    console.log(
      `✔ No entropy sources in sim code (${files.length} files checked)`,
    );
    process.exit(0);
  }

  console.log(`✘ ${violations.length} entropy source(s) in sim code:\n`);
  for (const violation of violations) {
    console.log(
      `  ${violation.file}:${violation.line}: ${violation.source} — ${violation.snippet}`,
    );
  }
  console.log(
    "\nsrc/game and src/ai must be deterministic across peers. Use `state.rng`",
  );
  console.log(
    "for randomness and the `now` / `dt` tick parameters for time. If a site",
  );
  console.log(
    "is genuinely cosmetic (e.g. SFX selection that must NOT advance state.rng),",
  );
  console.log("annotate the line with `// lint:allow-entropy -- <reason>`.");
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
  const strippedLines = stripStringsAndComments(content).split("\n");
  const rawLines = content.split("\n");
  const relPath = relative(process.cwd(), filePath);

  for (let idx = 0; idx < strippedLines.length; idx++) {
    const line = strippedLines[idx]!;
    const hit = ENTROPY_SOURCES.find((source) => source.pattern.test(line));
    if (!hit) continue;
    // Allow-marker on the same line, or anywhere in the contiguous block of
    // `//` comment lines immediately preceding (so a multi-line justification
    // comment is treated as a single marker).
    if (ALLOW_MARKER.test(rawLines[idx]!)) continue;
    if (markerInLeadingCommentBlock(rawLines, idx)) continue;
    out.push({
      file: relPath,
      line: idx + 1,
      source: hit.name,
      snippet: rawLines[idx]!.trim(),
    });
  }
}

/** Walk backward through the contiguous block of `//` comment lines
 *  immediately above `idx`, returning true if any of them carries the
 *  allow-marker. Stops at the first non-comment line. */
function markerInLeadingCommentBlock(
  rawLines: readonly string[],
  idx: number,
): boolean {
  for (let i = idx - 1; i >= 0; i--) {
    const trimmed = rawLines[i]!.trim();
    if (!trimmed.startsWith("//")) return false;
    if (ALLOW_MARKER.test(trimmed)) return true;
  }
  return false;
}

/** Remove string literals and comments so entropy tokens inside them are
 *  ignored. Replaces non-newline content with spaces — preserves column AND
 *  line positions so error reports point at the correct source line. */
function stripStringsAndComments(source: string): string {
  return source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (match) => match.replace(/[^\n]/g, " "),
  );
}
