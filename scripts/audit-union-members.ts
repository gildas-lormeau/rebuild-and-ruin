/**
 * Find string-literal-union members that never appear as a value anywhere
 * in the codebase — speculative arms that nothing produces or consumes.
 *
 * LLM agents widen unions defensively ("just in case we add one later").
 * This audit walks every top-level `type X = "a" | "b" | ...` declaration
 * with an all-string-literal union, counts string-literal-node
 * occurrences of each member project-wide (excluding type positions and
 * the type alias's own declaration), and reports members with no
 * observed value-position usage.
 *
 * Each occurrence is classified as a producer (passes/writes the value:
 * `f("a")`, `return "a"`, `{ k: "a" }`, `obj["a"] = …`, Identifier-keyed
 * Record entries) or a consumer (branches on it: `x === "a"`, `case "a":`,
 * `Map.has("a")`, `obj["a"]` lookup). Members are bucketed by
 * (producerCount, consumerCount):
 *   dead          (0, 0)   no use anywhere — safe to remove
 *   cascade-dead  (0, ≥1)  defensive code references a member nothing
 *                          produces; both the arm AND the defensive code
 *                          can go (this is the dispatch-incompleteness
 *                          symptom surfaced from the type-alias side)
 *   rare          (1-2, *) low-producer; manual review
 *   active        (≥3, *)  hidden by default, --include-active to surface
 *
 * Output is JSON for automation. Flags:
 *   --report               human-readable summary
 *   --filter <regex>       scope to type names matching regex
 *   --include-rare         show rare members in the report (else summary only)
 *   --include-active       show active members in the report
 *   --include-registries   include type aliases in `*-defs.ts` files
 *                          (skipped by default — pool registries declare
 *                          forward-looking IDs whose dead arms are
 *                          intentional per CLAUDE.md)
 *
 * Two origin shapes detected:
 *   direct           `type X = "a" | "b" | "c"`
 *   typeof-derived   `type X = typeof X_LIST[number]` etc. Resolved via
 *                    the type checker; the source const's statement range
 *                    is excluded from occurrence counting so the
 *                    literal-list declaration doesn't count as a use.
 *                    Only array-literal sources (`["a", "b"] as const`)
 *                    are accepted; object-literal and enum sources are
 *                    skipped wholesale, because consumers reach members
 *                    via property/enum access (`OBJ.A`, `Enum.A`) so the
 *                    bare literal never appears at use sites and every
 *                    member would falsely classify as dead.
 *
 * Heuristic limitations:
 *  - Top-level `type X = ...` aliases only. Inline unions
 *    (`function f(mode: "a" | "b")`) are not covered.
 *  - "Occurrence" = any string-literal node outside a LiteralType ancestor,
 *    or any Identifier-named property key (`{ title: 1 }`,
 *    `{ title }` shorthand) whose text matches the member value. The
 *    Identifier-key pass catches Record-literal producers
 *    (`Record<T, V> = { a: ..., b: ... }`) that the StringLiteral pass
 *    misses — without it, every union member used only as a Record key
 *    would falsely classify as dead. Cost: a member whose value happens
 *    to match a common key name (`id`, `title`, `name`) gets suppressed
 *    by unrelated objects, lowering precision but reducing FPs.
 *  - Producer/consumer classification is one parent-step deep and biases
 *    toward producer when uncertain. ArrayLiteralExpression children
 *    syntactically count as producers, so members used only in
 *    `[...].includes(x)` lookup tables suppress instead of cascade-deading
 *    — chosen trade-off (no false cascade-dead findings on table-driven
 *    code; cost: dead members hidden inside such arrays).
 *  - Members whose value is a common English word ("none", "all", "default")
 *    rack up unrelated occurrences. Trust the dead bucket; review rare
 *    by hand.
 */

import path from "node:path";
import process from "node:process";
import {
  Node,
  type NoSubstitutionTemplateLiteral,
  Project,
  type StringLiteral,
  SyntaxKind,
  type TypeAliasDeclaration,
} from "ts-morph";

interface OccurrenceSite {
  file: string;
  line: number;
  snippet: string;
  position: "producer" | "consumer";
}

type Classification = "dead" | "cascade-dead" | "rare" | "active";

interface MemberFinding {
  value: string;
  producerCount: number;
  consumerCount: number;
  classification: Classification;
  producers: OccurrenceSite[];
  consumers: OccurrenceSite[];
}

interface UnionFinding {
  type: string;
  file: string;
  line: number;
  origin: "direct" | "typeof-derived";
  memberCount: number;
  members: MemberFinding[];
  isRegistry: boolean;
}

interface ExcludeRange {
  file: string;
  startLine: number;
  endLine: number;
}

const LOOKUP_METHODS = new Set(["has", "get", "delete", "includes", "indexOf"]);
const RARE_MAX = 2;
const REGISTRY_FILE_RE = /-defs\.ts$/;
const args = process.argv.slice(2);
const wantReport = args.includes("--report");
const includeRare = args.includes("--include-rare");
const includeActive = args.includes("--include-active");
const includeRegistries = args.includes("--include-registries");
const filterIdx = args.indexOf("--filter");
const filterRe =
  filterIdx >= 0 && args[filterIdx + 1]
    ? new RegExp(args[filterIdx + 1])
    : null;
const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});
const occurrences = new Map<string, OccurrenceSite[]>();
const unions: UnionFinding[] = [];

project.addSourceFilesAtPaths([
  "src/**/*.ts",
  "server/**/*.ts",
  "test/**/*.ts",
]);

for (const sf of project.getSourceFiles()) {
  for (const lit of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    indexLiteral(lit);
  }
  for (const lit of sf.getDescendantsOfKind(
    SyntaxKind.NoSubstitutionTemplateLiteral,
  )) {
    indexLiteral(lit);
  }
  for (const propAssign of sf.getDescendantsOfKind(
    SyntaxKind.PropertyAssignment,
  )) {
    indexIdentifierKey(propAssign.getNameNode(), propAssign);
  }
  for (const shorthand of sf.getDescendantsOfKind(
    SyntaxKind.ShorthandPropertyAssignment,
  )) {
    indexIdentifierKey(shorthand.getNameNode(), shorthand);
  }
}

for (const sf of project.getSourceFiles()) {
  for (const ta of sf.getTypeAliases()) {
    const finding = analyzeTypeAlias(ta);
    if (!finding) continue;
    if (filterRe && !filterRe.test(finding.type)) continue;
    if (finding.isRegistry && !includeRegistries) continue;
    unions.push(finding);
  }
}

unions.sort(
  (unionA, unionB) => actionableCount(unionB) - actionableCount(unionA),
);

if (wantReport) {
  printReport(unions);
} else {
  console.log(JSON.stringify(unions, null, 2));
}

function indexLiteral(
  lit: StringLiteral | NoSubstitutionTemplateLiteral,
): void {
  if (lit.getFirstAncestorByKind(SyntaxKind.LiteralType)) return;
  const value = lit.getLiteralText();
  let entry = occurrences.get(value);
  if (!entry) {
    entry = [];
    occurrences.set(value, entry);
  }
  const parent = lit.getParent();
  entry.push({
    file: path.relative(process.cwd(), lit.getSourceFile().getFilePath()),
    line: lit.getStartLineNumber(),
    snippet: trimSnippet(parent ? parent.getText() : lit.getText()),
    position: classifyPosition(lit),
  });
}

function indexIdentifierKey(nameNode: Node, host: Node): void {
  if (!Node.isIdentifier(nameNode)) return;
  if (nameNode.getFirstAncestorByKind(SyntaxKind.LiteralType)) return;
  const value = nameNode.getText();
  let entry = occurrences.get(value);
  if (!entry) {
    entry = [];
    occurrences.set(value, entry);
  }
  entry.push({
    file: path.relative(process.cwd(), host.getSourceFile().getFilePath()),
    line: host.getStartLineNumber(),
    snippet: trimSnippet(host.getText()),
    position: "producer",
  });
}

/** Walk one parent step to decide if this literal node is at a position
 *  that produces a value of its type (passed as data, written to a slot)
 *  vs consumes it (compared, branched on, looked up by key). When unsure,
 *  bias toward producer so we don't falsely mark a member cascade-dead. */
function classifyPosition(
  lit: StringLiteral | NoSubstitutionTemplateLiteral,
): "producer" | "consumer" {
  const parent = lit.getParent();
  if (!parent) return "producer";

  if (parent.isKind(SyntaxKind.BinaryExpression)) {
    const bin = parent.asKindOrThrow(SyntaxKind.BinaryExpression);
    const op = bin.getOperatorToken().getKind();
    if (
      op === SyntaxKind.EqualsEqualsEqualsToken ||
      op === SyntaxKind.ExclamationEqualsEqualsToken ||
      op === SyntaxKind.EqualsEqualsToken ||
      op === SyntaxKind.ExclamationEqualsToken
    ) {
      return "consumer";
    }
  }

  if (parent.isKind(SyntaxKind.CaseClause)) return "consumer";

  if (parent.isKind(SyntaxKind.ElementAccessExpression)) {
    const access = parent.asKindOrThrow(SyntaxKind.ElementAccessExpression);
    if (access.getArgumentExpression() === lit) return "consumer";
  }

  if (parent.isKind(SyntaxKind.CallExpression)) {
    const call = parent.asKindOrThrow(SyntaxKind.CallExpression);
    if (call.getArguments().includes(lit)) {
      const callee = call.getExpression();
      if (callee.isKind(SyntaxKind.PropertyAccessExpression)) {
        const methodName = callee
          .asKindOrThrow(SyntaxKind.PropertyAccessExpression)
          .getName();
        if (LOOKUP_METHODS.has(methodName)) return "consumer";
      }
    }
  }

  return "producer";
}

function analyzeTypeAlias(ta: TypeAliasDeclaration): UnionFinding | null {
  let memberValues: string[] | null;
  let origin: "direct" | "typeof-derived";
  let excludeRanges: ExcludeRange[];

  memberValues = extractDirectStringUnion(ta);
  if (memberValues) {
    origin = "direct";
    excludeRanges = [];
  } else {
    const resolved = resolveTypeofDerived(ta);
    if (!resolved) return null;
    memberValues = resolved.members;
    origin = "typeof-derived";
    excludeRanges = resolved.excludeRanges;
  }
  if (memberValues.length < 2) return null;

  const file = path.relative(process.cwd(), ta.getSourceFile().getFilePath());
  const isRegistry = REGISTRY_FILE_RE.test(file);

  const memberFindings: MemberFinding[] = memberValues.map((value) => {
    const allSites = occurrences.get(value) ?? [];
    const sites = filterByExcludeRanges(allSites, excludeRanges);
    const producers = sites.filter((site) => site.position === "producer");
    const consumers = sites.filter((site) => site.position === "consumer");
    return {
      value,
      producerCount: producers.length,
      consumerCount: consumers.length,
      classification: classify(producers.length, consumers.length),
      producers: producers.slice(0, 5),
      consumers: consumers.slice(0, 5),
    };
  });

  return {
    type: ta.getName(),
    file,
    line: ta.getStartLineNumber(),
    origin,
    memberCount: memberValues.length,
    members: memberFindings,
    isRegistry,
  };
}

function extractDirectStringUnion(ta: TypeAliasDeclaration): string[] | null {
  const node = ta.getTypeNode();
  if (!node?.isKind(SyntaxKind.UnionType)) return null;
  const union = node.asKindOrThrow(SyntaxKind.UnionType);
  const memberValues: string[] = [];
  for (const memberType of union.getTypeNodes()) {
    if (!memberType.isKind(SyntaxKind.LiteralType)) return null;
    const literalNode = memberType
      .asKindOrThrow(SyntaxKind.LiteralType)
      .getLiteral();
    if (
      !literalNode.isKind(SyntaxKind.StringLiteral) &&
      !literalNode.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
    ) {
      return null;
    }
    const literal = literalNode as
      | StringLiteral
      | NoSubstitutionTemplateLiteral;
    memberValues.push(literal.getLiteralText());
  }
  return memberValues;
}

function resolveTypeofDerived(
  ta: TypeAliasDeclaration,
): { members: string[]; excludeRanges: ExcludeRange[] } | null {
  const typeNode = ta.getTypeNode();
  if (!typeNode) return null;
  const typeQueries = typeNode.getDescendantsOfKind(SyntaxKind.TypeQuery);
  if (typeQueries.length === 0) return null;

  const type = ta.getType();
  if (!type.isUnion()) return null;
  const members: string[] = [];
  for (const unionMember of type.getUnionTypes()) {
    if (!unionMember.isStringLiteral()) return null;
    const value = unionMember.getLiteralValue();
    if (typeof value !== "string") return null;
    members.push(value);
  }

  const excludeRanges: ExcludeRange[] = [];
  for (const tq of typeQueries) {
    const exprName = tq.getExprName();
    if (!Node.isIdentifier(exprName)) continue;
    for (const def of exprName.getDefinitionNodes()) {
      // Only array-literal sources (`["a", "b"] as const`) survive.
      // Object-literal sources have consumers reach members via
      // property-access (`OBJ.A`), enum sources via member-access
      // (`Enum.A`). Bare-literal use is rare for those, so
      // literal-counting produces false-positive "dead" findings on
      // every member. Whitelist arrays; skip everything else.
      if (!sourceIsArrayLiteralConst(def)) return null;
      const stmt =
        def.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? def;
      excludeRanges.push({
        file: path.relative(process.cwd(), stmt.getSourceFile().getFilePath()),
        startLine: stmt.getStartLineNumber(),
        endLine: stmt.getEndLineNumber(),
      });
    }
  }

  return { members, excludeRanges };
}

function filterByExcludeRanges(
  sites: OccurrenceSite[],
  ranges: ExcludeRange[],
): OccurrenceSite[] {
  if (ranges.length === 0) return sites;
  return sites.filter(
    (site) =>
      !ranges.some(
        (range) =>
          range.file === site.file &&
          site.line >= range.startLine &&
          site.line <= range.endLine,
      ),
  );
}

function sourceIsArrayLiteralConst(def: Node): boolean {
  const varDecl = Node.isVariableDeclaration(def)
    ? def
    : def.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (!varDecl) return false;
  let init = varDecl.getInitializer();
  if (!init) return false;
  if (init.isKind(SyntaxKind.AsExpression)) {
    init = init.asKindOrThrow(SyntaxKind.AsExpression).getExpression();
  }
  return init.isKind(SyntaxKind.ArrayLiteralExpression);
}

function classify(producers: number, consumers: number): Classification {
  if (producers === 0 && consumers === 0) return "dead";
  if (producers === 0) return "cascade-dead";
  if (producers <= RARE_MAX) return "rare";
  return "active";
}

function trimSnippet(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 80);
}

function printReport(items: UnionFinding[]): void {
  let totalDead = 0;
  let totalCascade = 0;
  let totalRare = 0;
  for (const union of items) {
    for (const member of union.members) {
      if (member.classification === "dead") totalDead++;
      if (member.classification === "cascade-dead") totalCascade++;
      if (member.classification === "rare") totalRare++;
    }
  }

  const unionsWithCascade = items.filter(
    (union) => memberCount(union, "cascade-dead") > 0,
  );
  console.log(
    `\n=== cascade-dead arms (${unionsWithCascade.length} types, ${totalCascade} arms) — defensive code consumes a member nothing produces ===`,
  );
  for (const union of unionsWithCascade) {
    console.log(
      `\n  ${union.type}  ${union.file}:${union.line}  [${union.origin}]`,
    );
    for (const member of union.members) {
      if (member.classification !== "cascade-dead") continue;
      console.log(
        `      [cascade-dead] "${member.value}"  (0 producers, ${member.consumerCount} consumers)`,
      );
      for (const site of member.consumers.slice(0, 3)) {
        console.log(`            ${site.file}:${site.line}  ${site.snippet}`);
      }
    }
  }

  const unionsWithDead = items.filter(
    (union) => memberCount(union, "dead") > 0,
  );
  console.log(
    `\n=== fully dead arms (${unionsWithDead.length} types, ${totalDead} arms) — no producer, no consumer ===`,
  );
  for (const union of unionsWithDead) {
    console.log(
      `\n  ${union.type}  ${union.file}:${union.line}  [${union.origin}]`,
    );
    for (const member of union.members) {
      if (member.classification !== "dead") continue;
      console.log(`      [dead] "${member.value}"`);
    }
  }

  if (includeRare || includeActive) {
    console.log(
      `\n=== other (${totalRare} rare-producer arms across all types) ===`,
    );
    for (const union of items) {
      const interesting = union.members.filter((member) => {
        if (member.classification === "rare") return includeRare;
        if (member.classification === "active") return includeActive;
        return false;
      });
      if (interesting.length === 0) continue;
      console.log(`  ${union.type}  ${union.file}:${union.line}`);
      for (const member of interesting) {
        console.log(
          `      [${member.classification.padEnd(13)}] "${member.value}"  (${member.producerCount} producers, ${member.consumerCount} consumers)`,
        );
      }
    }
  }

  console.log(
    `\nTotal candidate types: ${items.length}  →  cascade-dead: ${totalCascade}, fully dead: ${totalDead}, rare-producer: ${totalRare}`,
  );
}

function actionableCount(union: UnionFinding): number {
  return memberCount(union, "cascade-dead") + memberCount(union, "dead");
}

function memberCount(union: UnionFinding, cls: Classification): number {
  return union.members.filter((member) => member.classification === cls).length;
}
