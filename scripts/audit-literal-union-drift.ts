/**
 * Find hand-coded string-literal-union types whose every member duplicates
 * a value from an `as const` constant map (GAME_EVENT, BATTLE_MESSAGE,
 * MODIFIER_ID, FID, MESSAGE, etc.). These unions are silent-drift hazards:
 * if anyone ever edits the constant map's string values, the type still
 * type-checks against the old values and the consumer breaks at runtime.
 *
 * Example flagged:
 *   const GAME_EVENT = { BATTLE_READY: "battleReady", ... } as const;
 *   interface AnnouncementStep {
 *     eventType: "battleReady" | "battleAim" | "battleFire";  // drift
 *   }
 *
 * Safe form (not flagged — these aren't literal unions):
 *   eventType: typeof GAME_EVENT.BATTLE_READY | typeof GAME_EVENT.BATTLE_AIM
 *   // or
 *   eventType: (typeof GAME_EVENT)[keyof typeof GAME_EVENT];
 *
 * Detection
 *   1. Harvest every `(export) const FOO = { K: "v", ... } as const` whose
 *      every property value is a string literal. Spread elements
 *      (`...OTHER`) are also accepted; the spread source's entries fan in
 *      transitively in a second pass.
 *   2. Walk every UnionTypeNode in src/, dev/, server/. Keep unions whose
 *      every member is a LiteralType wrapping a StringLiteral.
 *   3. Match: if every member of the union appears in the same harvested
 *      const map, flag the union as a drift hazard. Among candidate maps
 *      that contain all members, prefer exported ones (the public API).
 *
 * Heuristic limitations
 *  - Strict-AND match. A union with 2/3 members in `GAME_EVENT` and one
 *    unrelated literal is NOT flagged — we'd rather miss the mixed case
 *    than chase coincidences. Reduces FPs on string-typed protocol bits.
 *  - Single-member literal unions (`type X = "foo"`) are included only
 *    with --include-singletons (off by default — many DOM/library types
 *    intentionally name a single literal).
 *  - The const-map's own derived type, declared in the same `as const`
 *    initializer, is skipped (it's the const itself).
 *  - No indirection chasing (`type A = X; type B = A;`); inline literal
 *    unions only.
 *
 * Output is JSON by default for automation. Flags:
 *   --report               human-readable summary
 *   --include-singletons   include 1-member literal unions
 *   --filter <regex>       scope to files matching regex
 */

import path from "node:path";
import process from "node:process";
import {
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type UnionTypeNode,
  type VariableDeclaration,
} from "ts-morph";

interface ConstSource {
  /** Name of the const variable, e.g. "GAME_EVENT". */
  mapName: string;
  /** Property key inside the map, e.g. "BATTLE_READY". */
  key: string;
  /** File where the const was declared. */
  file: string;
  /** 1-indexed declaration line. */
  line: number;
  /** Whether the const has an `export` modifier. */
  exported: boolean;
}

interface MatchedMember {
  value: string;
  source: ConstSource;
}

interface UnionFinding {
  file: string;
  line: number;
  contextKind: string;
  contextName: string;
  unionText: string;
  members: MatchedMember[];
  /** All members map to this single const map name. */
  sourceMap: string;
}

interface HarvestedMap {
  mapName: string;
  file: string;
  line: number;
  exported: boolean;
  entries: { key: string; value: string }[];
  /** Names of other `as const` maps spread into this one. */
  spreads: string[];
  /** If the const has `... satisfies Record<K, V>`, this is `V`'s identifier
   *  text. TS already enforces value↔type parity on this shape, so a union
   *  type alias named `V` is NOT a drift hazard — it's the source of truth
   *  that the const is constrained against. */
  satisfiesValueType?: string;
}

const args = process.argv.slice(2);
const wantReport = args.includes("--report");
const includeSingletons = args.includes("--include-singletons");
const filterIdx = args.indexOf("--filter");
const filterRe =
  filterIdx >= 0 && args[filterIdx + 1]
    ? new RegExp(args[filterIdx + 1]!)
    : null;

// Mutable state lives inside `main()` so biome's "hoist consts" rule
// can't reorder these initializations past their dependencies. An
// earlier version had `valueIndex = buildValueIndex()` at top-level and
// the formatter floated it above the harvest loop, silently emptying
// every result.
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

  const maps = new Map<string, HarvestedMap>();
  for (const sf of project.getSourceFiles()) harvestConsts(sf, maps);
  resolveSpreads(maps);
  const valueIndex = buildValueIndex(maps);

  const findings: UnionFinding[] = [];
  for (const sf of project.getSourceFiles()) {
    if (filterRe && !filterRe.test(sf.getFilePath())) continue;
    for (const union of sf.getDescendantsOfKind(SyntaxKind.UnionType)) {
      const finding = classifyUnion(union, maps, valueIndex);
      if (finding) findings.push(finding);
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  if (wantReport) {
    reportHuman(findings);
  } else {
    console.log(JSON.stringify({ findings }, null, 2));
  }

  process.exit(findings.length > 0 && process.env.AUDIT_EXIT_NONZERO ? 1 : 0);
}

function harvestConsts(sf: SourceFile, maps: Map<string, HarvestedMap>): void {
  for (const decl of sf.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init) continue;
    // Unwrap `expr as const satisfies T` (SatisfiesExpression wrapping
    // AsExpression). Either order is rare; we accept either.
    // Capture the satisfies-target on the way through so we can detect
    // the safe "type drives const" shape later.
    let asExpr: Node | undefined = init;
    let satisfiesType: Node | undefined;
    if (Node.isSatisfiesExpression(asExpr)) {
      satisfiesType = asExpr.getTypeNode();
      asExpr = asExpr.getExpression();
    }
    if (!asExpr || !Node.isAsExpression(asExpr)) continue;
    const typeNode = asExpr.getTypeNode();
    if (!typeNode || typeNode.getText() !== "const") continue;
    const objExpr = asExpr.getExpression();
    let inner: Node = objExpr;
    if (Node.isSatisfiesExpression(inner)) {
      satisfiesType ??= inner.getTypeNode();
      inner = inner.getExpression();
    }
    if (!Node.isObjectLiteralExpression(inner)) continue;
    const satisfiesValueType = extractSatisfiesValueType(satisfiesType);
    const mapName = decl.getName();
    if (!/^[A-Z][A-Z0-9_]*$/.test(mapName)) continue;
    const entries: { key: string; value: string }[] = [];
    const spreads: string[] = [];
    let valid = true;
    for (const prop of inner.getProperties()) {
      if (Node.isSpreadAssignment(prop)) {
        const expr = prop.getExpression();
        if (!Node.isIdentifier(expr)) {
          valid = false;
          break;
        }
        spreads.push(expr.getText());
        continue;
      }
      if (!Node.isPropertyAssignment(prop)) {
        valid = false;
        break;
      }
      const valueNode = prop.getInitializer();
      if (!valueNode || !Node.isStringLiteral(valueNode)) {
        valid = false;
        break;
      }
      const keyNode = prop.getNameNode();
      const key = Node.isIdentifier(keyNode)
        ? keyNode.getText()
        : Node.isStringLiteral(keyNode)
          ? keyNode.getLiteralText()
          : null;
      if (key === null) {
        valid = false;
        break;
      }
      entries.push({ key, value: valueNode.getLiteralText() });
    }
    if (!valid) continue;
    if (entries.length === 0 && spreads.length === 0) continue;
    maps.set(mapName, {
      mapName,
      file: sf.getFilePath(),
      line: decl.getStartLineNumber(),
      exported: isExportedDeclaration(decl),
      entries,
      spreads,
      satisfiesValueType,
    });
  }
}

function isExportedDeclaration(decl: VariableDeclaration): boolean {
  const stmt = decl.getVariableStatement();
  return !!stmt && stmt.hasExportKeyword();
}

/** Extract `V` from a `Record<K, V>` satisfies target. Returns undefined
 *  for any other shape (we only need this to detect the safe "type drives
 *  const" pattern, not arbitrary satisfies clauses). */
function extractSatisfiesValueType(
  typeNode: Node | undefined,
): string | undefined {
  if (!typeNode || !Node.isTypeReference(typeNode)) return undefined;
  const name = typeNode.getTypeName();
  if (!Node.isIdentifier(name) || name.getText() !== "Record") return undefined;
  const args = typeNode.getTypeArguments();
  if (args.length !== 2) return undefined;
  const valueArg = args[1]!;
  if (Node.isTypeReference(valueArg)) {
    const refName = valueArg.getTypeName();
    if (Node.isIdentifier(refName)) return refName.getText();
  }
  return undefined;
}

/** Fan in spread sources transitively. Each map's `entries` is grown so
 *  it includes every value reachable through `spreads` (including
 *  through chains). Cycles are skipped via a visited set. The
 *  attribution `key` for inherited entries is preserved from the source
 *  map — drift in the source still points at the source's slot. */
function resolveSpreads(maps: Map<string, HarvestedMap>): void {
  for (const map of maps.values()) {
    const visited = new Set<string>([map.mapName]);
    const stack = [...map.spreads];
    while (stack.length > 0) {
      const sourceName = stack.pop()!;
      if (visited.has(sourceName)) continue;
      visited.add(sourceName);
      const source = maps.get(sourceName);
      if (!source) continue;
      for (const entry of source.entries) map.entries.push(entry);
      for (const next of source.spreads) stack.push(next);
    }
  }
}

function buildValueIndex(
  maps: Map<string, HarvestedMap>,
): Map<string, ConstSource[]> {
  const idx = new Map<string, ConstSource[]>();
  for (const map of maps.values()) {
    for (const { key, value } of map.entries) {
      const source: ConstSource = {
        mapName: map.mapName,
        key,
        file: map.file,
        line: map.line,
        exported: map.exported,
      };
      let list = idx.get(value);
      if (!list) {
        list = [];
        idx.set(value, list);
      }
      list.push(source);
    }
  }
  return idx;
}

function classifyUnion(
  union: UnionTypeNode,
  maps: Map<string, HarvestedMap>,
  valueIndex: Map<string, ConstSource[]>,
): UnionFinding | null {
  const types = union.getTypeNodes();
  if (types.length < 1) return null;
  if (types.length === 1 && !includeSingletons) return null;

  const literals: string[] = [];
  for (const member of types) {
    if (!Node.isLiteralTypeNode(member)) return null;
    const lit = member.getLiteral();
    if (!Node.isStringLiteral(lit)) return null;
    literals.push(lit.getLiteralText());
  }

  // Collect candidate map names that contain EVERY literal in the union.
  const perLiteralMaps: Set<string>[] = literals.map((value) => {
    const sources = valueIndex.get(value);
    return new Set((sources ?? []).map((s) => s.mapName));
  });
  if (perLiteralMaps.some((set) => set.size === 0)) return null;
  let intersection = new Set(perLiteralMaps[0]!);
  for (let i = 1; i < perLiteralMaps.length; i++) {
    intersection = new Set(
      [...intersection].filter((name) => perLiteralMaps[i]!.has(name)),
    );
  }
  if (intersection.size === 0) return null;

  // Pick the best candidate map: exported wins, then the one with the
  // largest entry-count (most public superset).
  const candidates = [...intersection]
    .map((name) => maps.get(name)!)
    .sort((a, b) => {
      if (a.exported !== b.exported) return a.exported ? -1 : 1;
      return b.entries.length - a.entries.length;
    });
  const chosenMap = candidates[0]!;

  // Build per-member sources pointing at the chosen map.
  const matched: MatchedMember[] = literals.map((value) => {
    const all = valueIndex.get(value)!;
    const source = all.find((s) => s.mapName === chosenMap.mapName) ?? all[0]!;
    return { value, source };
  });

  // Skip unions embedded inside the source map's own `as const`.
  if (insideAsConst(union)) return null;

  const containing = describeContext(union);

  // Safe "type drives const" shape: the chosen const has
  // `satisfies Record<K, V>` where V === this union's type name.
  // TypeScript enforces value↔type parity, so there's no drift hazard.
  // Also covers any candidate map with the same shape — if ANY candidate
  // protects this union via satisfies, suppress.
  if (containing.kind === "type") {
    const unionTypeName = containing.name;
    for (const cand of candidates) {
      if (cand.satisfiesValueType === unionTypeName) return null;
    }
  }

  return {
    file: union.getSourceFile().getFilePath(),
    line: union.getStartLineNumber(),
    contextKind: containing.kind,
    contextName: containing.name,
    unionText: union.getText(),
    members: matched,
    sourceMap: chosenMap.mapName,
  };
}

function insideAsConst(union: UnionTypeNode): boolean {
  let parent: Node | undefined = union.getParent();
  while (parent) {
    if (Node.isAsExpression(parent)) {
      const t = parent.getTypeNode();
      if (t && t.getText() === "const") return true;
    }
    parent = parent.getParent();
  }
  return false;
}

function describeContext(union: UnionTypeNode): {
  kind: string;
  name: string;
} {
  let node: Node | undefined = union.getParent();
  while (node) {
    if (Node.isTypeAliasDeclaration(node))
      return { kind: "type", name: node.getName() };
    if (Node.isPropertySignature(node) || Node.isPropertyDeclaration(node)) {
      const owner = findOwnerTypeName(node);
      const propName = node.getName();
      return {
        kind: "property",
        name: owner ? `${owner}.${propName}` : propName,
      };
    }
    if (Node.isParameterDeclaration(node)) {
      const fn = node.getParent();
      const fnName =
        Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)
          ? fn.getName()
          : "<anon>";
      return {
        kind: "param",
        name: `${fnName ?? "<anon>"}(${node.getName()})`,
      };
    }
    node = node.getParent();
  }
  return { kind: "<unknown>", name: "<unknown>" };
}

function findOwnerTypeName(node: Node): string | undefined {
  let parent: Node | undefined = node.getParent();
  while (parent) {
    if (Node.isInterfaceDeclaration(parent)) return parent.getName();
    if (Node.isTypeAliasDeclaration(parent)) return parent.getName();
    if (Node.isTypeLiteral(parent)) {
      const grand = parent.getParent();
      if (grand && Node.isTypeAliasDeclaration(grand)) return grand.getName();
    }
    parent = parent.getParent();
  }
  return undefined;
}

function reportHuman(findings: readonly UnionFinding[]): void {
  if (findings.length === 0) {
    console.log("audit-literal-union-drift: no drift-prone unions found");
    return;
  }
  console.log(
    `audit-literal-union-drift: ${findings.length} drift-prone union${findings.length === 1 ? "" : "s"} found\n`,
  );
  for (const f of findings) {
    const rel = path.relative(process.cwd(), f.file);
    console.log(`  ${rel}:${f.line}  ${f.contextKind} ${f.contextName}`);
    console.log(`    members: ${f.unionText}`);
    console.log(
      `    source:  ${f.sourceMap}  (keys: ${f.members.map((m) => m.source.key).join(", ")})`,
    );
    const declFile = path.relative(process.cwd(), f.members[0]!.source.file);
    console.log(`    declared at ${declFile}:${f.members[0]!.source.line}`);
    console.log(
      `    suggest: (typeof ${f.sourceMap})[keyof typeof ${f.sourceMap}]   // or the explicit member union`,
    );
    console.log();
  }
}
