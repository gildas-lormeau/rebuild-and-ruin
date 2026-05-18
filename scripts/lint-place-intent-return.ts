/**
 * Intent-commit return-value lint.
 *
 * Two related symbol classes return a falsy value (`false` / `null`) when
 * validation rejects an intent commit:
 *
 *   1. Direct commit functions in `src/game/`:
 *      `executePlaceCannon`, `executePlacePiece`,
 *      `scheduleCannonPlacement`, `schedulePiecePlacement`.
 *   2. Commit-callback parameters inside `src/ai/ai-phase-*.ts`:
 *      `executePlace`, `executeFire` — the AI brain receives these as
 *      `(intent) => boolean` callbacks from the controller (which wires
 *      them to one of the direct functions in #1). Brain code must
 *      respect the bool just like the controller side does.
 *
 * Dropping the return value hides the failure: the brain advances its
 * state machine as if the commit succeeded, downstream invariants drift,
 * and (in the worst case) a tight loop calls the failed intent forever.
 * One observed instance: AI cannon flush spinning 4000+ iterations per
 * tick at round-4 CANNON_PLACE, dropping CPU usage to 100% and
 * preventing the phase from ever transitioning.
 *
 * Rule: a call to any of the watched identifiers used as a bare
 * expression statement (return value discarded) is a violation. Allowed:
 *   - assignment:                  `const ok = executePlaceCannon(...)`
 *   - returned:                    `return executePlaceCannon(...)`
 *   - logical:                     `if (!executeFire(...)) return;`
 *   - explicitly discarded:        `void placed; // see comment ...`
 *     (escape hatch for intentional fire-and-forget; rare — pair with
 *     a comment justifying why dropping the bool is safe.)
 *
 * Usage:
 *   deno run -A scripts/lint-place-intent-return.ts
 *
 * Exits 1 on violations.
 */

import process from "node:process";
import { Node, Project, SyntaxKind } from "ts-morph";

interface Violation {
  file: string;
  line: number;
  func: string;
  snippet: string;
}

const WATCHED = new Set([
  // Direct commit functions (game/game-actions.ts, game/scheduled-actions.ts)
  "executePlaceCannon",
  "executePlacePiece",
  "scheduleCannonPlacement",
  "schedulePiecePlacement",
  // Commit-callback parameter names inside AI brain phase functions
  // (ai/ai-phase-*.ts). These bind to one of the direct functions above
  // via the controller; same bool semantics apply.
  "executePlace",
  "executeFire",
]);

main();

function main(): void {
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths(["src/**/*.ts", "test/**/*.ts"]);

  const violations: Violation[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const callee = node.getExpression();
      if (!Node.isIdentifier(callee)) return;
      const name = callee.getText();
      if (!WATCHED.has(name)) return;

      // A bare ExpressionStatement parent means the return value is discarded.
      const parent = node.getParent();
      if (parent?.getKind() !== SyntaxKind.ExpressionStatement) return;

      violations.push({
        file: sourceFile.getFilePath(),
        line: node.getStartLineNumber(),
        func: name,
        snippet: node.getText().slice(0, 120),
      });
    });
  }

  if (violations.length === 0) {
    console.log("lint-place-intent-return: clean");
    return;
  }

  for (const v of violations) {
    const rel = v.file.replace(`${process.cwd()}/`, "");
    console.error(
      `${rel}:${v.line}: ${v.func}() return value discarded — must check the boolean / null result`,
    );
    console.error(`  ${v.snippet}`);
  }
  console.error(
    `\n${violations.length} violation(s). See scripts/lint-place-intent-return.ts header for the rule.`,
  );
  process.exit(1);
}
