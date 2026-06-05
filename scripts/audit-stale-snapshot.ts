/**
 * audit-stale-snapshot — surface local snapshots of mutable struct paths
 * that are read after a function call which could mutate the snapshot's
 * source. AUDIT-ONLY: no baseline, no exit-1 logic. Findings need manual
 * review (the heuristic over-flags by design).
 *
 * Pattern:
 *
 *     const player = state.players[0];
 *     applyDamage(state, dmg);   // might mutate state.players[0]
 *     player.lives--;            // ← reading a potentially stale alias
 *
 * The snapshot `player` holds a reference into `state.players`. After
 * `applyDamage(state, …)`, the object at index 0 may have been replaced,
 * spliced out, or had its fields rewritten — so `player.lives--` either
 * reads/writes the wrong row or a now-orphaned object. Re-resolve from
 * the root (`state.players[0].lives--`) or re-snapshot after the call.
 *
 * Heuristic, not sound. We track:
 *   - `const X = <chain>` where the chain is a PropertyAccess /
 *     ElementAccess of depth ≥ 2 with an Identifier root, AND the
 *     declared type is an object (not number/string/boolean/bigint).
 *   - A mutator-named call (`apply*`, `set*`, `finalize*`, …) that
 *     passes a path-prefix-aliased access path as an argument.
 *   - A subsequent read of `X.something` or `X[i]` in the same function
 *     scope, after the call's end position.
 *
 * If a re-assignment `X = …` appears between the call and the read,
 * the snapshot is considered refreshed and the flag clears. Identifier
 * resolution uses symbol-level binding so shadowing inner-scope params
 * don't trigger.
 *
 * Known false-positive classes (review each finding):
 *   - Mutator-named call that doesn't actually write the snapshot path
 *     (e.g. `setMode(state, X)` writes only `state.mode`, snapshot of
 *     `state.players` stays valid). Effect-knowledge gap.
 *   - Intentional pre-mutation capture (`prevPivot = piece.pivot;
 *     piece = rotate(piece);` — the snapshot is taken precisely to
 *     remember the old value).
 *   - Control flow: calls inside early-return `if` branches that don't
 *     actually reach the later read.
 *   - Callbacks/closures: a read captured inside a closure that runs at a
 *     different time than the flagged call. (A mutator *call* located
 *     behind a function boundary is now excluded — it cannot run during
 *     the enclosing block's synchronous flow, so it no longer stales
 *     snapshots read synchronously after the closure's definition.)
 *
 * Scope:
 *   src/**\/*.ts (excluding *.d.ts and test files)
 *
 * Usage:
 *   deno run -A scripts/audit-stale-snapshot.ts
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  type Block,
  type Identifier,
  Node,
  type ParameterDeclaration,
  Project,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";

interface Violation {
  file: string;
  line: number;
  snapshotLine: number;
  callLine: number;
  variable: string;
  rootName: string;
  snapshotPath: string;
  snippet: string;
}

interface Snapshot {
  name: string;
  decl: VariableDeclaration;
  path: string[];
  declLine: number;
  declPos: number;
  staleSince: number | null;
  staleCallLine: number;
}

const ROOT = path.resolve(import.meta.dirname!, "..");
const SRC_DIR = path.join(ROOT, "src");
const ALLOW_MARKER = /lint:allow-stale-snapshot/;
/** Verb prefixes/suffixes that suggest a call mutates its arguments.
 *  Without effect analysis we can't prove a call is impure, so we lean
 *  on naming: in this codebase, mutators are named consistently
 *  (`applyDamage`, `finalizeRound`, `resetTowers`, …). Pure helpers
 *  (`zoneAt`, `effectivePlanTiles`, `inBounds`) don't match, which is
 *  exactly the filter we want — passing `state` to a pure read does not
 *  stale a snapshot.
 *
 *  Matched on the call's *method name* (last identifier before `(`),
 *  case-insensitive prefix. */
const MUTATION_VERB_PREFIXES = [
  "apply",
  "set",
  "reset",
  "clear",
  "init",
  "prepare",
  "finalize",
  "commit",
  "advance",
  "tick",
  "run",
  "process",
  "handle",
  "update",
  "mutate",
  "push",
  "pop",
  "splice",
  "shift",
  "unshift",
  "add",
  "insert",
  "remove",
  "delete",
  "destroy",
  "kill",
  "revive",
  "enclose",
  "enter",
  "exit",
  "start",
  "stop",
  "begin",
  "end",
  "rebuild",
  "regenerate",
  "rotate",
  "rollback",
  "promote",
  "demote",
  "swap",
  "move",
  "sync",
  "load",
  "save",
  "fire",
  "spawn",
  "destroy",
  "do",
  "perform",
  "execute",
  "emit",
  "dispatch",
];
/** Property names that virtually always resolve to a primitive — used as
 *  a cheap fallback when the type checker can't be cleanly consulted.
 *  We rely on real `getType()` first; this is belt-and-suspenders. */
const PRIMITIVE_NAME_HINTS = new Set([
  "length",
  "size",
  "id",
  "row",
  "col",
  "x",
  "y",
  "lives",
  "score",
  "round",
  "phase",
  "timer",
]);

main();

function main(): void {
  const files = collectSourceFiles(SRC_DIR);
  if (files.length === 0) {
    console.log("✔ No source files to scan");
    process.exit(0);
  }

  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of files) project.addSourceFileAtPath(file);

  const violations: Violation[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    scanFile(sourceFile, violations);
  }
  dedupe(violations);

  if (violations.length === 0) {
    console.log(
      `No stale-snapshot reads found (${files.length} files scanned).`,
    );
    return;
  }

  console.log(
    `${violations.length} potential stale-snapshot read(s) — review each:\n`,
  );
  for (const v of violations) {
    console.log(
      `  ${v.file}:${v.line}  ${v.variable}  (path ${v.snapshotPath}, snapshot at L${v.snapshotLine}, intervening call at L${v.callLine})`,
    );
    console.log(`    ${v.snippet}`);
  }
  console.log("");
  console.log("Each finding is a snapshot whose source could have been");
  console.log("rewritten by an intervening mutator-named call. Heuristic,");
  console.log("not sound — verify the called function actually writes the");
  console.log("snapshot's path before treating any finding as a bug.");
  console.log("");
  console.log("If a finding is real:");
  console.log("  - Re-resolve from the root after the call, or");
  console.log("  - Re-snapshot after the call.");
}

function dedupe(violations: Violation[]): void {
  const seen = new Set<string>();
  let write = 0;
  for (const v of violations) {
    const key = `${v.file}:${v.line}:${v.variable}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations[write++] = v;
  }
  violations.length = write;
}

function scanFile(sourceFile: SourceFile, out: Violation[]): void {
  const relPath = path.relative(ROOT, sourceFile.getFilePath());
  const rawLines = sourceFile.getFullText().split("\n");

  for (const block of sourceFile.getDescendantsOfKind(SyntaxKind.Block)) {
    scanBlock(block, relPath, rawLines, out);
  }
}

function scanBlock(
  block: Block,
  relPath: string,
  rawLines: readonly string[],
  out: Violation[],
): void {
  const snapshots = new Map<string, Snapshot>();

  for (const node of block.getDescendants()) {
    if (Node.isVariableDeclaration(node)) {
      tryRegisterSnapshot(node, snapshots);
    } else if (Node.isCallExpression(node)) {
      markStaleFromCall(node, block, snapshots);
    } else if (Node.isIdentifier(node)) {
      recordStaleRead(node, snapshots, relPath, rawLines, out);
    }
  }
}

/** Mark any aliased snapshot stale at a mutator-named call's end position. */
function markStaleFromCall(
  node: Node,
  block: Block,
  snapshots: Map<string, Snapshot>,
): void {
  if (!Node.isCallExpression(node)) return;
  if (!isMutationCall(node)) return;
  // A mutation call lexically nested inside a closure/function defined
  // within this block cannot run during the block's synchronous flow — it
  // fires later (or never), when that callback is invoked. Treating it as
  // "intervening" reverses the timeline: the synchronous reads after the
  // closure definition actually execute BEFORE the call. Skip it so it
  // never stales a snapshot in the enclosing scope.
  if (isInsideNestedFunction(node, block)) return;
  const callEnd = node.getEnd();
  const callLine = node.getStartLineNumber();
  for (const arg of node.getArguments()) {
    const argPath = extractAccessPath(arg);
    if (!argPath) continue;
    for (const snap of snapshots.values()) {
      if (!pathsAlias(argPath, snap.path)) continue;
      if (callEnd <= snap.declPos) continue;
      if (snap.staleSince === null) {
        snap.staleSince = callEnd;
        snap.staleCallLine = callLine;
      }
    }
  }
}

/** Record a read of a snapshot that has gone stale since an intervening
 *  call — or clear staleness if the identifier is a re-assignment. */
function recordStaleRead(
  node: Identifier,
  snapshots: Map<string, Snapshot>,
  relPath: string,
  rawLines: readonly string[],
  out: Violation[],
): void {
  const snap = snapshots.get(node.getText());
  if (!snap) return;
  if (snap.staleSince === null) return;
  if (node.getPos() <= snap.staleSince) return;
  if (!identifierResolvesTo(node, snap.decl)) return;
  if (isWriteToSnapshotRoot(node)) {
    snap.staleSince = null;
    return;
  }
  if (!isMemberAccessOf(node)) return;
  const line = node.getStartLineNumber();
  if (hasAllowMarker(rawLines, line - 1)) return;
  out.push({
    file: relPath,
    line,
    snapshotLine: snap.declLine,
    callLine: snap.staleCallLine,
    variable: snap.name,
    rootName: snap.path[0]!,
    snapshotPath: snap.path.join("."),
    snippet: rawLines[line - 1]!.trim(),
  });
}

/** True if `node` sits behind a function boundary relative to `block` —
 *  i.e. an arrow/function/method body encloses it before reaching `block`.
 *  Such a node does not run in `block`'s synchronous flow. */
function isInsideNestedFunction(node: Node, block: Block): boolean {
  let cursor = node.getParent();
  while (cursor && cursor !== block) {
    if (
      Node.isArrowFunction(cursor) ||
      Node.isFunctionExpression(cursor) ||
      Node.isFunctionDeclaration(cursor) ||
      Node.isMethodDeclaration(cursor) ||
      Node.isGetAccessorDeclaration(cursor) ||
      Node.isSetAccessorDeclaration(cursor) ||
      Node.isConstructorDeclaration(cursor)
    ) {
      return true;
    }
    cursor = cursor.getParent();
  }
  return false;
}

function tryRegisterSnapshot(
  decl: VariableDeclaration,
  out: Map<string, Snapshot>,
): void {
  const statement = decl.getVariableStatement();
  if (!statement) return;
  if (
    !statement.getDeclarationKindKeywords().some((k) => k.getText() === "const")
  ) {
    return;
  }
  const nameNode = decl.getNameNode();
  if (!Node.isIdentifier(nameNode)) return;
  const initializer = decl.getInitializer();
  if (!initializer) return;
  if (
    !Node.isPropertyAccessExpression(initializer) &&
    !Node.isElementAccessExpression(initializer)
  ) {
    return;
  }
  const snapPath = extractAccessPath(initializer);
  if (!snapPath) return;
  if (snapPath.length < 2) return;
  const lastSegment = getLastSegmentName(initializer);
  if (lastSegment && PRIMITIVE_NAME_HINTS.has(lastSegment)) return;
  if (!isObjectLikeType(decl)) return;
  out.set(nameNode.getText(), {
    name: nameNode.getText(),
    decl,
    path: snapPath,
    declLine: decl.getStartLineNumber(),
    declPos: decl.getEnd(),
    staleSince: null,
    staleCallLine: 0,
  });
}

/** Extract a dotted access path from a node. Property accesses become
 *  named segments; element accesses are treated as wildcard subscripts
 *  (not added as segments) so `state.players` and `state.players[0]`
 *  resolve to the same path — both refer to "any element of
 *  state.players." Returns null for non-aliasable roots (imported
 *  bindings, function calls). */
function extractAccessPath(node: Node): string[] | null {
  const segments: string[] = [];
  let cursor: Node = node;
  while (
    Node.isPropertyAccessExpression(cursor) ||
    Node.isElementAccessExpression(cursor)
  ) {
    if (Node.isPropertyAccessExpression(cursor)) {
      segments.unshift(cursor.getName());
    }
    cursor = cursor.getExpression();
  }
  if (!Node.isIdentifier(cursor)) return null;
  if (isImportedBinding(cursor)) return null;
  return [cursor.getText(), ...segments];
}

/** Two access paths alias iff one is a prefix of the other. `state`
 *  aliases `state.players[0]` (a function receiving the whole state can
 *  write to any subpath). `state.rng` does NOT alias `state.players` —
 *  the function only gets the rng subtree. This is the core filter that
 *  distinguishes "received the root" from "received an unrelated branch." */
function pathsAlias(a: readonly string[], b: readonly string[]): boolean {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True iff `id` is a reference to the variable declared at `decl`. Uses
 *  ts-morph's symbol resolution rather than name comparison so that
 *  shadowing parameters or inner-scope rebindings of the same name are
 *  correctly excluded. */
function identifierResolvesTo(
  id: Identifier,
  decl: VariableDeclaration,
): boolean {
  const symbol = id.getSymbol();
  if (!symbol) return false;
  for (const symDecl of symbol.getDeclarations()) {
    if (symDecl === decl) return true;
  }
  return false;
}

function isMutationCall(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false;
  const callee = call.getExpression();
  let name: string | null = null;
  if (Node.isIdentifier(callee)) {
    name = callee.getText();
  } else if (Node.isPropertyAccessExpression(callee)) {
    name = callee.getName();
  }
  if (!name) return false;
  const lower = name.toLowerCase();
  for (const prefix of MUTATION_VERB_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

function getLastSegmentName(node: Node): string | null {
  if (Node.isPropertyAccessExpression(node)) return node.getName();
  return null;
}

function isObjectLikeType(decl: VariableDeclaration): boolean {
  try {
    const type = decl.getType();
    if (type.isString() || type.isStringLiteral()) return false;
    if (type.isNumber() || type.isNumberLiteral()) return false;
    if (type.isBoolean() || type.isBooleanLiteral()) return false;
    if (type.isUndefined() || type.isNull()) return false;
    if (type.isEnumLiteral() || type.isEnum()) return false;
    if (type.getText() === "bigint" || type.getText() === "symbol")
      return false;
    return true;
  } catch {
    return true;
  }
}

function isImportedBinding(id: Identifier): boolean {
  const defs = id.getDefinitions();
  for (const def of defs) {
    const declNode = def.getDeclarationNode();
    if (!declNode) continue;
    if (
      Node.isImportSpecifier(declNode) ||
      Node.isImportClause(declNode) ||
      Node.isNamespaceImport(declNode)
    ) {
      return true;
    }
    if (Node.isFunctionDeclaration(declNode)) return true;
    if (Node.isClassDeclaration(declNode)) return true;
    if (
      Node.isParameterDeclaration(declNode) ||
      Node.isVariableDeclaration(declNode)
    ) {
      const param = declNode as ParameterDeclaration | VariableDeclaration;
      if (Node.isParameterDeclaration(param)) return false;
      const stmt = (param as VariableDeclaration).getVariableStatement();
      if (stmt?.hasExportKeyword()) return true;
    }
  }
  return false;
}

function isMemberAccessOf(id: Identifier): boolean {
  const parent = id.getParent();
  if (!parent) return false;
  if (
    Node.isPropertyAccessExpression(parent) &&
    parent.getExpression() === id
  ) {
    return true;
  }
  if (Node.isElementAccessExpression(parent) && parent.getExpression() === id) {
    return true;
  }
  return false;
}

function isWriteToSnapshotRoot(id: Identifier): boolean {
  const parent = id.getParent();
  if (!parent) return false;
  if (Node.isBinaryExpression(parent)) {
    const op = parent.getOperatorToken().getKind();
    if (op === SyntaxKind.EqualsToken && parent.getLeft() === id) return true;
  }
  return false;
}

function hasAllowMarker(rawLines: readonly string[], idx: number): boolean {
  if (idx < 0 || idx >= rawLines.length) return false;
  if (ALLOW_MARKER.test(rawLines[idx]!)) return true;
  for (let i = idx - 1; i >= 0; i--) {
    const trimmed = rawLines[i]!.trim();
    if (!trimmed.startsWith("//")) return false;
    if (ALLOW_MARKER.test(trimmed)) return true;
  }
  return false;
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  walk(dir, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const entryStat = statSync(full, { throwIfNoEntry: false });
    if (!entryStat) continue;
    if (entryStat.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entryStat.isFile()) continue;
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".d.ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
}
