/**
 * Find raw `number` (or `number | undefined`) property declarations whose
 * name strongly suggests an existing branded type. Surfaces wire-format
 * and contract fields that drifted from the runtime brand they belong to.
 *
 * Example: `SerializedTower.zone: number` while `ZoneId` exists at
 * src/shared/core/zone-id.ts → flagged as a `ZoneId` candidate.
 *
 * Heuristic is purely name-based — no value-flow analysis. False positives
 * happen for genuinely-unbranded numerics that share the brand's name (e.g.
 * a fictional `Person.zoneRadius: number` would match "Zone"). The included
 * suffix list errs precise: each brand maps to one or two specific suffixes
 * (e.g. `PlayerId` matches `PlayerId`-suffixed names only, not `Player`).
 *
 * Output is JSON for automation. Use `--report` for a human-readable summary.
 */

import path from "node:path";
import process from "node:process";
import {
  type InterfaceDeclaration,
  Project,
  type PropertySignature,
  SyntaxKind,
  type TypeAliasDeclaration,
  type TypeLiteralNode,
} from "ts-morph";

interface BrandPattern {
  /** The branded type identifier (e.g. `ZoneId`). */
  brand: string;
  /** Suffix matches for property names (case-insensitive endsWith).
   *  E.g. `["Zone", "ZoneId"]` matches both `zone` and `homeZoneId`. */
  suffixes: string[];
  /** Absolute path to the file declaring the brand, for the action hint. */
  definedAt: string;
}

interface Finding {
  interface: string;
  property: string;
  file: string;
  line: number;
  declaredType: string;
  suggestedBrand: string;
  brandDefinedAt: string;
}

main();

function main(): void {
  const args = process.argv.slice(2);
  const wantReport = args.includes("--report");
  const filterIdx = args.indexOf("--filter");
  const filterRe =
    filterIdx >= 0 && args[filterIdx + 1]
      ? new RegExp(args[filterIdx + 1])
      : null;

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths(["src/**/*.ts", "server/**/*.ts"]);

  const brandPatterns = collectBrandPatterns(project);
  if (brandPatterns.length === 0) {
    console.error("No branded number types found — nothing to audit.");
    process.exit(1);
  }

  const findings: Finding[] = [];
  for (const sf of project.getSourceFiles()) {
    for (const iface of sf.getInterfaces()) {
      collectFromInterface(iface, brandPatterns, findings);
    }
    for (const ta of sf.getTypeAliases()) {
      collectFromTypeAlias(ta, brandPatterns, findings);
    }
  }

  const filtered = filterRe
    ? findings.filter((finding) =>
        filterRe.test(`${finding.interface}.${finding.property}`),
      )
    : findings;

  filtered.sort((finA, finB) => {
    if (finA.suggestedBrand !== finB.suggestedBrand) {
      return finA.suggestedBrand.localeCompare(finB.suggestedBrand);
    }
    return finA.file.localeCompare(finB.file) || finA.line - finB.line;
  });

  if (wantReport) {
    printReport(filtered);
  } else {
    console.log(JSON.stringify(filtered, null, 2));
  }
}

function collectBrandPatterns(project: Project): BrandPattern[] {
  const patterns: BrandPattern[] = [];
  const unknown: string[] = [];
  for (const sf of project.getSourceFiles()) {
    for (const ta of sf.getTypeAliases()) {
      if (!isNumberBrand(ta)) continue;
      const brand = ta.getName();
      const suffixes = brandSuffixes(brand);
      if (suffixes === null) {
        if (brand !== "ValidPlayerId") unknown.push(brand);
        continue;
      }
      patterns.push({
        brand,
        suffixes,
        definedAt: path.relative(process.cwd(), sf.getFilePath()),
      });
    }
  }
  if (unknown.length > 0) {
    console.error(
      `[audit-brand-candidates] Unknown branded types: ${unknown.join(", ")}. Add an entry in brandSuffixes() before this audit can run.`,
    );
    process.exit(1);
  }
  return patterns;
}

/** Hard-coded suffix lists — adding a new brand to the codebase requires a
 *  new entry here. The `assertAllBrandsCovered` check fails the run if a
 *  branded number type is found in source without a matching entry, so the
 *  list can't silently drift. */
function brandSuffixes(brand: string): string[] | null {
  switch (brand) {
    case "ZoneId":
      return ["Zone", "ZoneId"];
    case "PlayerId":
      return ["PlayerId"];
    case "ValidPlayerId":
      return null; // Subset of PlayerId; covered by the PlayerId entry.
    case "TowerIdx":
      return ["TowerIdx"];
    case "CannonIdx":
      return ["CannonIdx"];
    case "TileKey":
      return ["TileKey"];
    case "ShotKey":
      return ["ShotKey"];
    default:
      return null;
  }
}

function isNumberBrand(ta: TypeAliasDeclaration): boolean {
  const typeNode = ta.getTypeNode();
  if (!typeNode || !typeNode.isKind(SyntaxKind.IntersectionType)) return false;
  const text = typeNode.getText();
  // `number & { readonly __Foo: true }` pattern (and variants with newlines)
  return /\bnumber\b/.test(text) && /readonly\s+__/.test(text);
}

function collectFromInterface(
  iface: InterfaceDeclaration,
  brandPatterns: BrandPattern[],
  findings: Finding[],
): void {
  for (const member of iface.getProperties()) {
    maybeRecord(member, iface.getName(), brandPatterns, findings);
  }
}

function collectFromTypeAlias(
  ta: TypeAliasDeclaration,
  brandPatterns: BrandPattern[],
  findings: Finding[],
): void {
  const node = ta.getTypeNode();
  if (!node || !node.isKind(SyntaxKind.TypeLiteral)) return;
  const lit = node.asKindOrThrow(SyntaxKind.TypeLiteral) as TypeLiteralNode;
  for (const member of lit.getProperties()) {
    maybeRecord(member, ta.getName(), brandPatterns, findings);
  }
}

function maybeRecord(
  sig: PropertySignature,
  container: string,
  brandPatterns: BrandPattern[],
  findings: Finding[],
): void {
  const declaredType = sig.getTypeNode()?.getText();
  if (!declaredType || !isPlainNumber(declaredType)) return;
  const propName = sig.getName();
  const match = matchBrand(propName, brandPatterns);
  if (!match) return;
  findings.push({
    interface: container,
    property: propName,
    file: path.relative(process.cwd(), sig.getSourceFile().getFilePath()),
    line: sig.getStartLineNumber(),
    declaredType,
    suggestedBrand: match.brand,
    brandDefinedAt: match.definedAt,
  });
}

/** Accept `number`, `number | undefined`, `undefined | number`. Reject any
 *  intersection, branded alias, or union with another type — only raw
 *  numerics + the optional-undefined sugar should suggest re-branding. */
function isPlainNumber(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  return (
    normalized === "number" ||
    normalized === "number|undefined" ||
    normalized === "undefined|number"
  );
}

function matchBrand(
  propName: string,
  brandPatterns: BrandPattern[],
): BrandPattern | null {
  const lower = propName.toLowerCase();
  for (const pattern of brandPatterns) {
    for (const suffix of pattern.suffixes) {
      const suffixLower = suffix.toLowerCase();
      if (lower === suffixLower || lower.endsWith(suffixLower)) {
        // Guard against accidental substring hits inside an unrelated word
        // (e.g. `zoneRadius` ending in `Zone` would be wrong, but
        // `homeZone` is correct). Require the matched suffix to start at a
        // word boundary — i.e. the char before it is either nothing or
        // lowercase→Uppercase transition (camelCase boundary).
        if (lower === suffixLower) return pattern;
        const boundaryIdx = propName.length - suffix.length;
        const charBefore = propName[boundaryIdx - 1];
        const firstOfSuffix = propName[boundaryIdx];
        if (
          charBefore &&
          firstOfSuffix &&
          charBefore === charBefore.toLowerCase() &&
          firstOfSuffix === firstOfSuffix.toUpperCase()
        ) {
          return pattern;
        }
      }
    }
  }
  return null;
}

function printReport(items: Finding[]): void {
  if (items.length === 0) {
    console.log("No brand candidates found — wire/contract types align.");
    return;
  }
  const byBrand = new Map<string, Finding[]>();
  for (const item of items) {
    const bucket = byBrand.get(item.suggestedBrand) ?? [];
    bucket.push(item);
    byBrand.set(item.suggestedBrand, bucket);
  }
  for (const [brand, group] of byBrand) {
    const definedAt = group[0]!.brandDefinedAt;
    console.log(
      `\n=== ${brand} candidates (${group.length}) — ${definedAt} ===`,
    );
    for (const item of group) {
      console.log(
        `  ${item.interface}.${item.property}: ${item.declaredType}  ${item.file}:${item.line}`,
      );
    }
  }
  console.log(`\nTotal candidates: ${items.length}`);
}
