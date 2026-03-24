/**
 * Find duplicate string and numeric literals across the codebase.
 *
 * Uses the TypeScript compiler API to parse ASTs and collect literals
 * that appear in runtime expressions (comparisons, assignments, function args).
 * Skips: const/enum definitions, imports, type annotations, exports, object keys.
 *
 * Usage:
 *   npx tsx scripts/find-duplicate-literals.ts [options]
 *
 * Options:
 *   --threshold N          Minimum occurrences to report (default: 3)
 *   --files <globs...>     Only report findings with locations in these files
 *   --update-baseline      Save current findings as the baseline (exits 0)
 *   --all                  Report all findings, ignoring baseline
 *
 * Exit codes:
 *   0  No new findings (or baseline updated)
 *   1  New findings detected (not in baseline)
 *
 * Baseline: .literals-baseline.json — committed to repo, tracks known duplicates.
 * Default behavior compares against baseline and only reports/fails on NEW entries.
 */

import ts from "typescript";
import { globSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const threshold = (() => {
  const idx = process.argv.indexOf("--threshold");
  return idx >= 0 ? parseInt(process.argv[idx + 1]!, 10) || 3 : 3;
})();

const updateBaseline = process.argv.includes("--update-baseline");
const showAll = process.argv.includes("--all");

/** Parse --files: everything after --files until the next --flag or end of args. */
const filesFilter: string[] = (() => {
  const idx = process.argv.indexOf("--files");
  if (idx < 0) return [];
  const result: string[] = [];
  for (let i = idx + 1; i < process.argv.length; i++) {
    if (process.argv[i]!.startsWith("--")) break;
    result.push(process.argv[i]!);
  }
  return result;
})();

// Files to exclude from numeric analysis (sprite data tables, test fixtures)
const NUMERIC_EXCLUDED_FILES = new Set(["sprites.ts", "headless-test.ts"]);

const root = path.resolve(import.meta.dirname!, "..");
const BASELINE_PATH = path.join(root, ".literals-baseline.json");

const files = [
  ...globSync("src/**/*.ts", { cwd: root }),
  ...globSync("server/**/*.ts", { cwd: root }),
].map((f) => path.join(root, f));

const stringCounts = new Map<string, { count: number; locations: string[] }>();
const numberCounts = new Map<number, { count: number; locations: string[] }>();

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

interface BaselineEntry { type: "string" | "number"; key: string }
type Baseline = BaselineEntry[];

function loadBaseline(): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
    return new Set(data.map(e => `${e.type}:${e.key}`));
  } catch {
    return new Set();
  }
}

function saveBaseline(strings: [string, unknown][], numbers: [number, unknown][]): void {
  const entries: Baseline = [
    ...strings.map(([k]) => ({ type: "string" as const, key: k })),
    ...numbers.map(([k]) => ({ type: "number" as const, key: String(k) })),
  ];
  entries.sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key));
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(entries, null, 2) + "\n");
}

function baselineKey(type: "string" | "number", key: string | number): string {
  return `${type}:${key}`;
}

// ---------------------------------------------------------------------------
// Shared skip logic (applies to both strings and numbers)
// ---------------------------------------------------------------------------

function isDefinitionContext(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const parent = node.parent;
  if (!parent) return true;

  // Skip imports
  if (ts.isImportDeclaration(parent) || ts.isImportSpecifier(parent) ||
      ts.isExportDeclaration(parent)) return true;
  if (parent.kind === ts.SyntaxKind.ImportDeclaration ||
      parent.kind === ts.SyntaxKind.ExportDeclaration) return true;

  // Skip: import("...")
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;

  // Skip: `as const` initializers
  if (ts.isAsExpression(parent)) {
    const typeNode = parent.type;
    if (ts.isTypeReferenceNode(typeNode) && typeNode.typeName.getText(sourceFile) === "const") return true;
  }

  // Skip: const X = <literal> (top-level constant definitions)
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    const declList = parent.parent;
    if (ts.isVariableDeclarationList(declList) &&
        (declList.flags & ts.NodeFlags.Const) !== 0) {
      return true;
    }
  }

  // Skip: enum member values
  if (ts.isEnumMember(parent)) return true;

  // Skip: property assignments in const object literals
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const objLit = parent.parent;
    if (ts.isObjectLiteralExpression(objLit)) {
      const objParent = objLit.parent;
      if (ts.isVariableDeclaration(objParent) && objParent.initializer === objLit) {
        const declList = objParent.parent;
        if (ts.isVariableDeclarationList(declList) &&
            (declList.flags & ts.NodeFlags.Const) !== 0) {
          return true;
        }
      }
    }
  }

  // Skip: object literal keys (property names)
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;

  // Skip: type annotations and interface members
  if (ts.isLiteralTypeNode(parent)) return true;

  // Skip: const array literal elements (e.g., const TABLE: readonly number[] = [100, 200])
  if (ts.isArrayLiteralExpression(parent)) {
    const arrParent = parent.parent;
    if (ts.isVariableDeclaration(arrParent) && arrParent.initializer === parent) {
      const declList = arrParent.parent;
      if (ts.isVariableDeclarationList(declList) &&
          (declList.flags & ts.NodeFlags.Const) !== 0) {
        return true;
      }
    }
  }

  // Skip: elements inside const tuple arrays (e.g., const T: readonly [number, number][] = [[100, 1000]])
  if (ts.isArrayLiteralExpression(parent)) {
    const outerArr = parent.parent;
    if (ts.isArrayLiteralExpression(outerArr)) {
      const outerParent = outerArr.parent;
      if (ts.isVariableDeclaration(outerParent) && outerParent.initializer === outerArr) {
        const declList = outerParent.parent;
        if (ts.isVariableDeclarationList(declList) &&
            (declList.flags & ts.NodeFlags.Const) !== 0) {
          return true;
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// String-specific skips
// ---------------------------------------------------------------------------

function isSkippedString(node: ts.StringLiteral, sourceFile: ts.SourceFile): boolean {
  const text = node.text;

  // Skip very short strings (1-2 chars)
  if (text.length < 3) return true;

  if (isDefinitionContext(node, sourceFile)) return true;

  const parent = node.parent!;

  // Skip: template literal parts
  if (ts.isTemplateSpan(parent) || ts.isNoSubstitutionTemplateLiteral(node as ts.Node as ts.NoSubstitutionTemplateLiteral)) return true;

  // Skip: addEventListener/removeEventListener first arg (DOM event names)
  if (ts.isCallExpression(parent)) {
    const expr = parent.expression;
    if (ts.isPropertyAccessExpression(expr)) {
      const method = expr.name.text;
      if ((method === "addEventListener" || method === "removeEventListener") &&
          parent.arguments[0] === node) return true;
      if (method === "createElement" || method === "getElementById" ||
          method === "querySelector" || method === "querySelectorAll") return true;
    }
  }

  // Skip: property assignments to known DOM/Canvas properties
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === node && ts.isPropertyAccessExpression(parent.left)) {
    const prop = parent.left.name.text;
    const domProps = new Set([
      "display", "position", "textAlign", "textBaseline", "fillStyle",
      "strokeStyle", "font", "cursor", "overflow", "visibility",
      "pointerEvents", "touchAction", "userSelect", "className",
      "textContent", "innerHTML", "id", "type", "textDecoration",
    ]);
    if (domProps.has(prop)) return true;
  }

  // Skip: hex color strings
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return true;

  // Skip: well-known CSS/DOM values and HTML tag/attribute names
  const CSS_DOM_STRINGS = new Set([
    "none", "block", "flex", "grid", "inline", "inline-block",
    "absolute", "relative", "fixed", "sticky",
    "hidden", "visible", "scroll", "auto",
    "center", "left", "right", "top", "bottom", "middle",
    "bold", "normal", "italic", "underline",
    "pointer", "default", "grab", "crosshair",
    "solid", "dashed", "dotted",
    "transparent", "inherit", "initial", "unset",
    "div", "span", "button", "input", "canvas", "img", "label",
    "click", "touchstart", "touchmove", "touchend", "touchcancel",
    "keydown", "keyup", "mousedown", "mouseup", "mousemove",
    "resize", "wheel", "contextmenu", "pointerdown", "pointerup",
    "active", "disabled", "checked", "focus", "hover",
    "row", "col", "column",
  ]);
  if (CSS_DOM_STRINGS.has(text)) return true;

  // Skip: typeof comparisons
  if (ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
       parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
    const other = parent.left === node ? parent.right : parent.left;
    if (ts.isTypeOfExpression(other)) return true;
  }

  // Skip strings with uppercase, spaces, dots, slashes (UI text, paths, etc.)
  if (/[A-Z /.]/.test(text)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Number-specific skips
// ---------------------------------------------------------------------------

function isSkippedNumber(node: ts.NumericLiteral, sourceFile: ts.SourceFile): boolean {
  const value = Number(node.text);

  // Skip small integers (0-15) and -1 — too common to be meaningful
  if (Number.isInteger(value) && value >= -1 && value <= 15) return true;

  // Skip small decimals (0–2) — alpha, lerp factors, scale ratios
  if (!Number.isInteger(value) && value >= 0 && value <= 2) return true;

  if (isDefinitionContext(node, sourceFile)) return true;

  const parent = node.parent!;

  // Skip: array index access (arr[3] is not a magic number worth extracting)
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;

  // Skip: negative prefix expressions — we'll catch the inner literal
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.MinusToken) return true;

  // Skip: bit shift / bitwise operations (commonly use small constants)
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.LessThanLessThanToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
        op === ts.SyntaxKind.AmpersandToken ||
        op === ts.SyntaxKind.BarToken ||
        op === ts.SyntaxKind.CaretToken) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Walk all files
// ---------------------------------------------------------------------------

for (const filePath of files) {
  const sourceFile = ts.createSourceFile(
    filePath,
    ts.sys.readFile(filePath) ?? "",
    ts.ScriptTarget.Latest,
    true,
  );

  function record(map: Map<string | number, { count: number; locations: string[] }>, key: string | number, node: ts.Node) {
    const rel = path.relative(root, filePath);
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const loc = `${rel}:${line}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { count: 0, locations: [] };
      map.set(key, entry);
    }
    entry.count++;
    entry.locations.push(loc);
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && !isSkippedString(node, sourceFile)) {
      record(stringCounts as Map<string | number, { count: number; locations: string[] }>, node.text, node);
    } else if (ts.isNumericLiteral(node) && !NUMERIC_EXCLUDED_FILES.has(path.basename(filePath)) && !isSkippedNumber(node, sourceFile)) {
      record(numberCounts as Map<string | number, { count: number; locations: string[] }>, Number(node.text), node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

// ---------------------------------------------------------------------------
// Filter & report
// ---------------------------------------------------------------------------

/** Check if any location matches the --files filter. */
function matchesFileFilter(locations: string[]): boolean {
  if (filesFilter.length === 0) return true;
  return locations.some(loc => {
    const file = loc.split(":")[0]!;
    return filesFilter.some(pattern => {
      // Support simple glob: "src/render-*.ts" or exact match "src/game-engine.ts"
      if (pattern.includes("*")) {
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        return regex.test(file);
      }
      return file === pattern;
    });
  });
}

const stringResults = [...stringCounts.entries()]
  .filter(([, v]) => v.count >= threshold && matchesFileFilter(v.locations))
  .sort((a, b) => b[1].count - a[1].count);

const numberResults = [...numberCounts.entries()]
  .filter(([, v]) => v.count >= threshold && matchesFileFilter(v.locations))
  .sort((a, b) => b[1].count - a[1].count);

// --update-baseline: save and exit
if (updateBaseline) {
  saveBaseline(stringResults, numberResults);
  const total = stringResults.length + numberResults.length;
  console.log(`Baseline updated: ${total} entries saved to .literals-baseline.json`);
  process.exit(0);
}

// Compare against baseline (unless --all)
const baseline = showAll ? new Set<string>() : loadBaseline();

const newStrings = stringResults.filter(([k]) => !baseline.has(baselineKey("string", k)));
const newNumbers = numberResults.filter(([k]) => !baseline.has(baselineKey("number", k)));
const knownStrings = stringResults.filter(([k]) => baseline.has(baselineKey("string", k)));
const knownNumbers = numberResults.filter(([k]) => baseline.has(baselineKey("number", k)));

const newCount = newStrings.length + newNumbers.length;
const knownCount = knownStrings.length + knownNumbers.length;

function printFindings(
  label: string,
  strings: [string, { count: number; locations: string[] }][],
  numbers: [number, { count: number; locations: string[] }][],
): void {
  if (strings.length > 0) {
    console.log(`${label} string literals:\n`);
    for (const [text, { count, locations }] of strings) {
      console.log(`  "${text}" × ${count}`);
      for (const loc of locations) {
        console.log(`    ${loc}`);
      }
      console.log();
    }
  }
  if (numbers.length > 0) {
    console.log(`${label} numeric literals:\n`);
    for (const [num, { count, locations }] of numbers) {
      console.log(`  ${num} × ${count}`);
      for (const loc of locations) {
        console.log(`    ${loc}`);
      }
      console.log();
    }
  }
}

if (showAll) {
  // --all: show everything with a flat label (no new/known distinction)
  const allStrings = stringResults;
  const allNumbers = numberResults;
  const total = allStrings.length + allNumbers.length;
  if (total > 0) {
    printFindings(`Duplicate`, allStrings, allNumbers);
  } else {
    console.log(`No duplicate literals found with ${threshold}+ occurrences.`);
  }
} else {
  if (newCount > 0) {
    printFindings(`NEW duplicate`, newStrings, newNumbers);
  }
  if (knownCount > 0 && newCount === 0) {
    console.log(`${knownCount} known duplicate literals (in baseline). Run with --all to see them.`);
  } else if (knownCount > 0) {
    console.log(`(+ ${knownCount} known duplicate literals in baseline)`);
  }
  if (newCount === 0 && knownCount === 0) {
    console.log(`No duplicate literals found with ${threshold}+ occurrences.`);
  }
}

// --all is informational (always exit 0); default exits 1 only for NEW findings
process.exit(!showAll && newCount > 0 ? 1 : 0);
