/**
 * lint-ai-rng-isolation — flag direct `state.rng.` reads inside AI/animation
 * code paths.
 *
 * Why: `state.rng` is the per-game shared RNG. Every peer must consume it
 * identically or the network parity gate (`test/network-vs-local.test.ts`)
 * fails. AI controllers use `strategy.rng` instead — for pure-AI controllers
 * it equals `state.rng` (lockstep across peers); for `AiAssistedHumanController`
 * it's a private Rng (because animation runs only on the slot-owning peer).
 *
 * Drawing from `state.rng` directly inside AI tick code therefore breaks
 * assisted-human parity even though it works in pure-AI tests. The bug only
 * surfaces at the very end of the test pyramid, so we catch it earlier here.
 *
 * Allowed patterns (not flagged):
 * - Doc-comment mentions of `state.rng` (stripped before scanning)
 * - String literal mentions
 * - Sites annotated with `// lint:allow-state-rng -- <reason>` on the same
 *   or previous line (e.g., AI logic invoked from a state-mutation hook
 *   that fires symmetrically on every peer)
 *
 * Scope:
 *   src/ai/**\/*.ts
 *   src/controllers/controller-ai*.ts
 *
 * Usage:
 *   deno run -A scripts/lint-ai-rng-isolation.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

const SRC_AI = join(process.cwd(), "src", "ai");
const SRC_CONTROLLERS = join(process.cwd(), "src", "controllers");
const STATE_RNG = /\bstate\.rng\b/;
const ALLOW_MARKER = /lint:allow-state-rng/;

main();

function main(): void {
  const files = [
    ...collectFiles(SRC_AI),
    ...collectControllerAiFiles(SRC_CONTROLLERS),
  ];
  const violations: Violation[] = [];

  for (const filePath of files) {
    findViolations(filePath, readFileSync(filePath, "utf-8"), violations);
  }

  if (violations.length === 0) {
    console.log(
      `✔ No state.rng violations in AI code (${files.length} files checked)`,
    );
    process.exit(0);
  }

  console.log(`✘ ${violations.length} state.rng violation(s) in AI code:\n`);
  for (const violation of violations) {
    console.log(`  ${violation.file}:${violation.line}: ${violation.snippet}`);
  }
  console.log(
    "\nAI code must use `strategy.rng` (or a passed-in Rng parameter).",
  );
  console.log(
    "If a draw must come from state.rng (e.g. invoked from a state-mutation",
  );
  console.log(
    "hook that runs symmetrically on every peer), annotate the line with",
  );
  console.log("`// lint:allow-state-rng -- <reason>`.");
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

function collectControllerAiFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (
      entry.startsWith("controller-ai") &&
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts")
    ) {
      results.push(join(dir, entry));
    }
  }
  return results;
}

function findViolations(
  filePath: string,
  content: string,
  out: Violation[],
): void {
  const stripped = stripStringsAndComments(content);
  const rawLines = content.split("\n");
  const strippedLines = stripped.split("\n");
  const relPath = relative(process.cwd(), filePath);

  for (let idx = 0; idx < strippedLines.length; idx++) {
    const line = strippedLines[idx]!;
    if (!STATE_RNG.test(line)) continue;
    // Allow-marker on the same line, or anywhere in the contiguous block
    // of `//` comment lines immediately preceding (so a multi-line
    // justification comment is treated as a single marker).
    if (ALLOW_MARKER.test(rawLines[idx]!)) continue;
    if (markerInLeadingCommentBlock(rawLines, idx)) continue;
    out.push({
      file: relPath,
      line: idx + 1,
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

/** Remove string literals and comments so `state.rng` inside them is ignored.
 *  Replaces non-newline content with spaces — preserves column AND line
 *  positions so error reports point at the correct source line. */
function stripStringsAndComments(source: string): string {
  return source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (match) => match.replace(/[^\n]/g, " "),
  );
}
