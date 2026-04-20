/**
 * lint-typeof — flag type-level `typeof` anti-patterns.
 *
 * Catches three categories of `typeof` misuse in type positions:
 *
 * Cat C: `typeof SOME_CONST` in discriminated unions / type aliases
 *        → use string/number literals directly
 * Cat D: `ReturnType<typeof myFunction>` (non-builtin)
 *        → export a named type from the source module
 * Cat F: `typeof someVar.prop` as a type shorthand
 *        → use the actual type name
 *
 * Allowed `typeof` patterns (not flagged):
 * - Runtime checks:  `typeof window !== "undefined"`
 * - Timer builtins:  `ReturnType<typeof setTimeout/setInterval/...>`
 * - Key extraction:  `keyof typeof SomeObj`
 * - Value types:     `(typeof OBJ)[...]`  (indexed access)
 *
 * Usage:
 *   deno run -A scripts/lint-typeof.ts
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

const SCAN_DIRS = [join(process.cwd(), "src"), join(process.cwd(), "server")];
/** Runtime typeof check: `typeof X === "..."` or `typeof X !== "..."` */
const RUNTIME_CHECK = /typeof\s+\S+\s*[!=]==?\s/;
/** Timer builtins: `ReturnType<typeof setTimeout/setInterval/...>` */
const TIMER_BUILTIN =
  /ReturnType<typeof\s+(setTimeout|setInterval|setImmediate|clearTimeout|clearInterval)>/;
/** Key extraction: `keyof typeof X` */
const KEYOF_TYPEOF = /keyof\s+typeof\b/;
/** Value-type indexed access: `(typeof X)[` */
const INDEXED_ACCESS = /\(typeof\s+\S+\)\[/;
/** Dynamic import module type: `typeof import("...")` */
const DYNAMIC_IMPORT_TYPE = /typeof\s+import\(/;
/** Namespace-import module type: `typeof THREE` where THREE is from
 *  `import * as THREE from "three"`. The sprite scene builders accept
 *  an injected `typeof THREE` param so each *-scene.ts can be consumed
 *  from either the main bundle (which does `import * as THREE`) or the
 *  design sandbox (which importmaps a different THREE build). This is
 *  the legitimate "whole module as value" typing use-case typeof was
 *  designed for, not the anti-pattern the rule targets. */
const NAMESPACE_IMPORT_TYPE = /typeof\s+THREE\b/;
const ALLOWED_PATTERNS = [
  RUNTIME_CHECK,
  TIMER_BUILTIN,
  KEYOF_TYPEOF,
  INDEXED_ACCESS,
  DYNAMIC_IMPORT_TYPE,
  NAMESPACE_IMPORT_TYPE,
];

main();

function main(): void {
  const files = SCAN_DIRS.flatMap(collectFiles);
  const violations: Violation[] = [];

  for (const filePath of files) {
    findViolations(filePath, readFileSync(filePath, "utf-8"), violations);
  }

  if (violations.length === 0) {
    console.log(
      `\u2714 No type-level typeof violations (${files.length} files checked)`,
    );
    process.exit(0);
  }

  console.log(
    `\u2718 ${violations.length} type-level typeof violation(s) found:\n`,
  );
  for (const violation of violations) {
    console.log(`  ${violation.file}:${violation.line}: ${violation.snippet}`);
  }
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
  const stripped = stripStringsAndComments(content);
  const rawLines = content.split("\n");
  const strippedLines = stripped.split("\n");
  const relPath = relative(process.cwd(), filePath);

  for (let idx = 0; idx < strippedLines.length; idx++) {
    const line = strippedLines[idx]!;
    if (!line.includes("typeof ")) continue;

    // Remove all allowed patterns; if `typeof ` survives, it's a violation
    let cleaned = line;
    for (const pattern of ALLOWED_PATTERNS) {
      cleaned = cleaned.replace(new RegExp(pattern.source, "g"), "");
    }

    if (cleaned.includes("typeof ")) {
      out.push({
        file: relPath,
        line: idx + 1,
        snippet: rawLines[idx]!.trim(),
      });
    }
  }
}

/** Remove string literals and comments so `typeof` inside them is ignored.
 *  Replaces content with spaces to preserve column positions. */
function stripStringsAndComments(source: string): string {
  // Single pass: match strings (single/double/template), block comments, line comments
  return source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (match) => " ".repeat(match.length),
  );
}
