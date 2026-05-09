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
 * Findings are grouped:
 *   dead   0 occurrences anywhere outside the type def — safe to remove
 *   rare   1-2 occurrences — manual review (often a single test fixture
 *          or a recent addition not yet wired up)
 *   active 3+ occurrences — hidden by default, --include-active to surface
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
 * Heuristic limitations:
 *  - Top-level `type X = ...` aliases only. typeof-derived unions
 *    (`type X = typeof X_LIST[number]`) and inline unions
 *    (`function f(mode: "a" | "b")`) are not covered.
 *  - "Occurrence" = any string-literal node outside a LiteralType ancestor.
 *    Producers (writes, args, returns) and consumers (===, switch case)
 *    aren't distinguished. A member referenced only by `if (x === "c")`
 *    with no producer is reported "active" here even though the arm is
 *    dead in practice; that's the cascade case, deferred.
 *  - Members whose value is a common English word ("none", "all", "default")
 *    rack up unrelated occurrences. Trust the dead bucket; review rare
 *    by hand.
 */

import path from "node:path";
import process from "node:process";
import {
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
}

type Classification = "dead" | "rare" | "active";

interface MemberFinding {
  value: string;
  occurrenceCount: number;
  classification: Classification;
  occurrences: OccurrenceSite[];
}

interface UnionFinding {
  type: string;
  file: string;
  line: number;
  memberCount: number;
  members: MemberFinding[];
  isRegistry: boolean;
}

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

unions.sort((unionA, unionB) => deadCount(unionB) - deadCount(unionA));

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
  });
}

function analyzeTypeAlias(ta: TypeAliasDeclaration): UnionFinding | null {
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
  if (memberValues.length < 2) return null;

  const file = path.relative(process.cwd(), ta.getSourceFile().getFilePath());
  const isRegistry = REGISTRY_FILE_RE.test(file);

  const memberFindings: MemberFinding[] = memberValues.map((value) => {
    const sites = occurrences.get(value) ?? [];
    return {
      value,
      occurrenceCount: sites.length,
      classification: classify(sites.length),
      occurrences: sites.slice(0, 5),
    };
  });

  return {
    type: ta.getName(),
    file,
    line: ta.getStartLineNumber(),
    memberCount: memberValues.length,
    members: memberFindings,
    isRegistry,
  };
}

function classify(count: number): Classification {
  if (count === 0) return "dead";
  if (count <= RARE_MAX) return "rare";
  return "active";
}

function trimSnippet(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 80);
}

function printReport(items: UnionFinding[]): void {
  let totalDead = 0;
  let totalRare = 0;
  for (const union of items) {
    for (const member of union.members) {
      if (member.classification === "dead") totalDead++;
      if (member.classification === "rare") totalRare++;
    }
  }

  const unionsWithDead = items.filter((union) => deadCount(union) > 0);
  console.log(
    `\n=== unions with dead members (${unionsWithDead.length} types, ${totalDead} dead arms) ===`,
  );
  for (const union of unionsWithDead) {
    console.log(`\n  ${union.type}  ${union.file}:${union.line}`);
    for (const member of union.members) {
      if (member.classification === "active" && !includeActive) continue;
      if (member.classification === "rare" && !includeRare) continue;
      const tag = member.classification.padEnd(6);
      console.log(
        `      [${tag}] "${member.value}"  (${member.occurrenceCount} occurrences)`,
      );
      for (const site of member.occurrences.slice(0, 3)) {
        console.log(`            ${site.file}:${site.line}  ${site.snippet}`);
      }
    }
  }

  if (includeRare || includeActive) {
    const otherUnions = items.filter((union) => deadCount(union) === 0);
    console.log(
      `\n=== unions with no dead members (${otherUnions.length} types, ${totalRare} rare arms) ===`,
    );
    for (const union of otherUnions) {
      const rares = union.members.filter(
        (member) => member.classification === "rare",
      );
      if (rares.length === 0 && !includeActive) continue;
      console.log(`  ${union.type}  ${union.file}:${union.line}`);
      for (const member of union.members) {
        if (member.classification === "active" && !includeActive) continue;
        if (member.classification === "rare" && !includeRare) continue;
        console.log(
          `      [${member.classification.padEnd(6)}] "${member.value}"  (${member.occurrenceCount})`,
        );
      }
    }
  }

  console.log(
    `\nTotal candidate types: ${items.length}  →  with dead arms: ${unionsWithDead.length}, dead arms: ${totalDead}, rare arms: ${totalRare}`,
  );
}

function deadCount(union: UnionFinding): number {
  return union.members.filter((member) => member.classification === "dead")
    .length;
}
