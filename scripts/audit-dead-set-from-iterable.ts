/**
 * Find `new Set(iter)` allocations whose only downstream operations are
 * iteration — the Set serves no semantic purpose beyond the iterable it
 * was built from, and the allocation + hash work is wasted.
 *
 * Example flagged (from the AI strategy):
 *   const enclosureTileSet = new Set(enclosure.tiles);
 *   for (const key of enclosureTileSet) { ... }   // never .has() / .add()
 *
 * The Set is allocated, every tile is hashed into a hash table, and the
 * code iterates the Set as if it were the source array. Replace with
 * `for (const key of enclosure.tiles)`.
 *
 * Sibling to `audit-dead-map-from-record.ts`, which targets the
 * Map<K,V> = new Map(Object.entries(RECORD)) shape specifically. This
 * one targets Sets and is broader: any local `new Set(simpleIterable)`
 * iteration-only consumer.
 *
 * Detection
 *   1. Find `new Set(arg)` expressions assigned to a local `const`/`let`.
 *      Argument must be a "simple iterable":
 *        - Identifier              `new Set(arr)`
 *        - PropertyAccess          `new Set(player.cannons)`
 *        - Element access          `new Set(map.values())`
 *      Complex sources (spreads, filters, ternaries) are SKIPPED — those
 *      shapes often imply intentional dedup that doesn't need `.has()`
 *      at the call site.
 *   2. Walk every reference to the variable.
 *   3. Classify each reference:
 *        - SET_OP    `.add` `.delete` `.has` `.size`            (kept)
 *        - ITER      `for…of`, `[...set]`, `Array.from(set)`,
 *                    `.values()` `.keys()` `.entries()`
 *                    `.forEach(...)`                            (iter-only)
 *        - ESCAPE    returned, passed to fn, aliased, assigned  (skip case)
 *   4. Flag when every non-decl reference is ITER and no ESCAPE happened.
 *
 * Skips
 *   - Empty `new Set()` (no source — clearly intended to be populated later)
 *   - `new Set<T>()` with no args
 *   - Module-scope const Sets (intentional dedupe registries — see
 *     SCRIPT_DIRS, ALLOWED_PATTERNS style consts)
 *   - Sets passed to / returned from anywhere (can't reason about escape)
 *
 * Output is JSON by default. Flags:
 *   --report               human-readable
 *   --filter <regex>       scope to files matching regex
 */

import path from "node:path";
import process from "node:process";
import {
  type Identifier,
  type NewExpression,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";

interface Finding {
  file: string;
  line: number;
  /** Variable name, e.g. "enclosureTileSet". */
  name: string;
  /** Source iterable expression text, e.g. "enclosure.tiles". */
  source: string;
  /** Count of each reference category — for the human-readable report. */
  uses: Record<string, number>;
}

const args = process.argv.slice(2);
const wantReport = args.includes("--report");
const filterIdx = args.indexOf("--filter");
const filterRe =
  filterIdx >= 0 && args[filterIdx + 1]
    ? new RegExp(args[filterIdx + 1]!)
    : null;

main();

function main(): void {
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([
    "src/**/*.ts",
    "dev/**/*.ts",
    "server/**/*.ts",
  ]);

  const findings: Finding[] = [];
  for (const sf of project.getSourceFiles()) {
    if (filterRe && !filterRe.test(sf.getFilePath())) continue;
    auditFile(sf, findings);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  if (wantReport) reportHuman(findings);
  else console.log(JSON.stringify({ findings }, null, 2));

  process.exit(findings.length > 0 && process.env.AUDIT_EXIT_NONZERO ? 1 : 0);
}

function auditFile(sf: SourceFile, findings: Finding[]): void {
  for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer();
    if (!init || !Node.isNewExpression(init)) continue;
    if (init.getExpression().getText() !== "Set") continue;

    // Skip module-scope (intentional registries).
    if (!isFunctionScoped(vd)) continue;

    const source = simpleIterableSource(init);
    if (!source) continue;

    const nameNode = vd.getNameNode();
    if (!Node.isIdentifier(nameNode)) continue;

    const finding = classifyUses(nameNode, vd, source, sf.getFilePath());
    if (finding) findings.push(finding);
  }
}

/** Variable lives inside a function/method body, not at module scope. */
function isFunctionScoped(vd: VariableDeclaration): boolean {
  let parent: Node | undefined = vd.getParent();
  while (parent) {
    if (
      Node.isFunctionDeclaration(parent) ||
      Node.isFunctionExpression(parent) ||
      Node.isArrowFunction(parent) ||
      Node.isMethodDeclaration(parent)
    ) {
      return true;
    }
    parent = parent.getParent();
  }
  return false;
}

/** Accept only "simple" iterable arguments where dedup is unlikely to be
 *  the unstated motive. */
function simpleIterableSource(newExpr: NewExpression): string | null {
  const args = newExpr.getArguments();
  if (args.length !== 1) return null;
  const arg = args[0]!;
  if (
    Node.isIdentifier(arg) ||
    Node.isPropertyAccessExpression(arg) ||
    Node.isElementAccessExpression(arg)
  ) {
    return arg.getText();
  }
  return null;
}

function classifyUses(
  nameNode: Identifier,
  selfDecl: VariableDeclaration,
  source: string,
  filePath: string,
): Finding | null {
  const refs = nameNode.findReferencesAsNodes();
  const declStart = selfDecl.getStart();
  const uses: Record<string, number> = {};
  let nonDeclRefs = 0;
  let allIter = true;

  for (const ref of refs) {
    // Skip the declaration's own name binding.
    if (
      ref.getSourceFile().getFilePath() === filePath &&
      ref.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getStart() ===
        declStart
    ) {
      continue;
    }

    nonDeclRefs++;
    const category = categorizeReference(ref);
    uses[category] = (uses[category] ?? 0) + 1;

    if (
      category === "ESCAPE" ||
      category === "SET_OP" ||
      category === "UNKNOWN"
    ) {
      allIter = false;
    }
  }

  if (nonDeclRefs === 0) return null;
  if (!allIter) return null;

  return {
    file: filePath,
    line: selfDecl.getStartLineNumber(),
    name: nameNode.getText(),
    source,
    uses,
  };
}

/** Classify a single reference to the Set variable. */
function categorizeReference(ref: Node): string {
  const parent = ref.getParent();
  if (!parent) return "UNKNOWN";

  // for (… of set) — iteration use.
  if (Node.isForOfStatement(parent) && parent.getExpression() === ref) {
    return "ITER_FOR_OF";
  }

  // [...set] in array literal or function call — iteration use.
  if (Node.isSpreadElement(parent)) return "ITER_SPREAD";

  // Array.from(set) — iteration use.
  if (Node.isCallExpression(parent)) {
    const callee = parent.getExpression();
    if (
      Node.isPropertyAccessExpression(callee) &&
      callee.getExpression().getText() === "Array" &&
      callee.getName() === "from" &&
      parent.getArguments()[0] === ref
    ) {
      return "ITER_ARRAY_FROM";
    }
    // ref passed as an argument to some other function — escape.
    if (parent.getArguments().includes(ref)) return "ESCAPE";
  }

  // set.X(...) or set.X access — discriminate by member name.
  if (
    Node.isPropertyAccessExpression(parent) &&
    parent.getExpression() === ref
  ) {
    const member = parent.getName();
    switch (member) {
      case "add":
      case "delete":
      case "clear":
      case "has":
      case "size":
        return "SET_OP";
      case "values":
      case "keys":
      case "entries":
      case "forEach":
        return "ITER_METHOD";
      default:
        // Some other property — unknown, treat as escape.
        return "UNKNOWN";
    }
  }

  // return set; — escape.
  if (Node.isReturnStatement(parent)) return "ESCAPE";

  // const alias = set; — escape (would need to follow the alias).
  if (Node.isVariableDeclaration(parent)) return "ESCAPE";

  // foo.bar = set; or { x: set } — escape.
  if (
    Node.isBinaryExpression(parent) ||
    Node.isPropertyAssignment(parent) ||
    Node.isShorthandPropertyAssignment(parent)
  ) {
    return "ESCAPE";
  }

  return "UNKNOWN";
}

function reportHuman(findings: readonly Finding[]): void {
  if (findings.length === 0) {
    console.log("audit-dead-set-from-iterable: no iteration-only Sets found");
    return;
  }
  console.log(
    `audit-dead-set-from-iterable: ${findings.length} dead Set${findings.length === 1 ? "" : "s"} found\n`,
  );
  for (const f of findings) {
    const rel = path.relative(process.cwd(), f.file);
    const usesStr = Object.entries(f.uses)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`  ${rel}:${f.line}  const ${f.name} = new Set(${f.source})`);
    console.log(`    uses: ${usesStr}`);
    console.log(`    suggest: iterate ${f.source} directly`);
    console.log();
  }
}
