/**
 * lint-controller-ctor-rng — flag RNG draws inside controller constructors.
 *
 * Why: A draw inside a controller constructor advances whichever Rng instance
 * the strategy was built with. In the host/watcher pair, a slot can be wired
 * to different controller variants (e.g., AssistedHumanController on host with
 * a privateRng strategy vs. plain AiController on the watcher with state.rng).
 * The construction-time draw then lands on different Rngs across peers — the
 * watcher's state.rng advances by one extra step while the host's privateRng
 * absorbs the draw. That's the parity asymmetry that broke
 * `test/network-vs-local.test.ts` for assisted-human scenarios.
 *
 * Construction must therefore be RNG-free. Defer randomness to a hook that
 * runs symmetrically (e.g. `onResetBattle`, which fires only for *local*
 * controllers, so remote-slot placeholders never draw and both peers stay in
 * lockstep).
 *
 * Allowed patterns (not flagged):
 * - Sites annotated with `// lint:allow-ctor-rng -- <reason>` on the same
 *   or previous line.
 *
 * Scope:
 *   src/controllers/controller-*.ts
 *
 * Usage:
 *   deno run -A scripts/lint-controller-ctor-rng.ts
 *
 * Exits 1 if violations found.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Node, Project, SyntaxKind } from "ts-morph";

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

const ROOT = path.resolve(import.meta.dirname!, "..");
const SRC_CONTROLLERS = path.join(ROOT, "src", "controllers");
/** Methods on `Rng` that advance internal state. Bare property reads (e.g.
 *  `this.strategy.rng` to store the reference) are fine — only call sites
 *  consume randomness. */
const RNG_METHODS = new Set(["next", "int", "bool", "pick", "shuffle"]);
const ALLOW_MARKER = /lint:allow-ctor-rng/;

main();

function main(): void {
  const files = collectControllerFiles(SRC_CONTROLLERS);
  if (files.length === 0) {
    console.log(`✔ No controller files to scan`);
    process.exit(0);
  }

  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of files) project.addSourceFileAtPath(file);

  const violations: Violation[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    const relPath = path.relative(ROOT, filePath);
    const rawLines = sourceFile.getFullText().split("\n");

    for (const ctor of sourceFile.getDescendantsOfKind(
      SyntaxKind.Constructor,
    )) {
      const body = ctor.getBody();
      if (!body) continue;
      for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) continue;
        const methodName = expr.getName();
        if (!RNG_METHODS.has(methodName)) continue;
        // The receiver of the call must be (or end with) a `.rng` access —
        // catches `this.strategy.rng.next()`, `privateRng.int()`,
        // `opts.rng.pick()`, `state.rng.bool()`, etc.
        const receiver = expr.getExpression();
        if (!isRngExpression(receiver)) continue;

        const lineIdx = call.getStartLineNumber() - 1;
        if (ALLOW_MARKER.test(rawLines[lineIdx]!)) continue;
        if (markerInLeadingCommentBlock(rawLines, lineIdx)) continue;
        violations.push({
          file: relPath,
          line: lineIdx + 1,
          snippet: rawLines[lineIdx]!.trim(),
        });
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `✔ No constructor RNG draws in controllers (${files.length} files checked)`,
    );
    process.exit(0);
  }

  console.log(
    `✘ ${violations.length} constructor RNG draw(s) in controllers:\n`,
  );
  for (const violation of violations) {
    console.log(`  ${violation.file}:${violation.line}: ${violation.snippet}`);
  }
  console.log(
    "\nController constructors must be RNG-free — host/watcher can install",
  );
  console.log(
    "different controller variants for the same slot, so a constructor draw",
  );
  console.log(
    "lands on different Rngs and breaks parity. Move the draw to a hook that",
  );
  console.log(
    "fires only on local controllers (e.g. `onResetBattle`), or annotate the",
  );
  console.log("line with `// lint:allow-ctor-rng -- <reason>`.");
  process.exit(1);
}

function collectControllerFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (
      entry.startsWith("controller-") &&
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts")
    ) {
      results.push(path.join(dir, entry));
    }
  }
  return results;
}

/** Whether `node` resolves to an Rng-typed expression for our purposes —
 *  identified syntactically by the trailing `.rng` access or an identifier
 *  ending in `Rng`/`rng`. We don't use the type checker here to keep the
 *  lint cheap (no full TS resolve), and the receiver pattern is uniform
 *  across the codebase. */
function isRngExpression(node: Node): boolean {
  if (Node.isPropertyAccessExpression(node)) {
    return node.getName() === "rng";
  }
  if (Node.isIdentifier(node)) {
    return /[Rr]ng$/.test(node.getText());
  }
  return false;
}

/** Walk backward through the contiguous block of `//` comment lines
 *  immediately above `idx`, returning true if any of them carries the
 *  allow-marker. */
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
