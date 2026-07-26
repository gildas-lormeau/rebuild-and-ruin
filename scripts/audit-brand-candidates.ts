/**
 * Find raw `number` (or `number | undefined`) declarations whose name strongly
 * suggests an existing branded type. Surfaces wire-format and contract sites
 * that drifted from the runtime brand they belong to.
 *
 * Three declaration kinds are scanned:
 *  - `property` — interface / type-alias members.
 *      `SerializedTower.zone: number` while `ZoneId` exists → ZoneId candidate.
 *  - `parameter` — function / method / arrow / call-signature parameters.
 *      `zoneByPlayer(pid: number)` → PlayerId candidate.
 *  - `return`   — declared return types, including function-typed properties.
 *      `povPlayerId: () => number` → PlayerId candidate.
 *
 * Property-only scanning was the original scope; parameters and returns were
 * added because the brands leaked through exactly the surfaces the audit could
 * not see (`zoneByPlayer(pid: number)` shipped while every declaration of
 * `povPlayerId` outside one deps interface already said `ValidPlayerId`).
 *
 * Heuristic is purely name-based — no value-flow analysis. The suffix lists err
 * precise: each brand maps to a small set of specific suffixes matched at a
 * camelCase boundary, so `rapid` does not match `Pid` and `zoneRadius` does not
 * match `Zone`. Two structural false-positive classes are suppressed outright:
 *  - `<result>By<key>` names, where the trailing token names the lookup KEY and
 *    not the returned value (`playerByZone` returns a player id, not a zone).
 *    Applies to return positions only.
 *  - Sites in ALLOWLIST, where a raw `number` is the honest type — validator
 *    boundaries that PRODUCE a brand, and parameters that accept a sentinel.
 *
 * `GameOwned<number, "Round">`-style producer brands are deliberately out of
 * scope: they are guarded by their producer functions, not by parameter types,
 * and `round: number` parameters are legitimately raw throughout.
 *
 * Output is JSON for automation. `--report` for a human summary, `--check` to
 * fail the build on any non-allowlisted finding.
 */

import path from "node:path";
import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionTypeNode,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type MethodSignature,
  Project,
  type PropertySignature,
  type SourceFile,
  SyntaxKind,
  type TypeAliasDeclaration,
  type TypeLiteralNode,
} from "ts-morph";

type FindingKind = "property" | "parameter" | "return";

interface BrandPattern {
  /** The branded type identifier (e.g. `ZoneId`). */
  brand: string;
  /** Suffix matches for declaration names (case-insensitive endsWith, required
   *  to land on a camelCase boundary). E.g. `["Zone", "ZoneId"]` matches both
   *  `zone` and `homeZoneId`. */
  suffixes: string[];
  /** Absolute path to the file declaring the brand, for the action hint. */
  definedAt: string;
}

interface Finding {
  kind: FindingKind;
  /** Owning interface / type alias / function name. */
  container: string;
  /** Property, parameter, or (for returns) the function's own name. */
  member: string;
  file: string;
  line: number;
  declaredType: string;
  suggestedBrand: string;
  brandDefinedAt: string;
}

interface AllowEntry {
  file: string;
  container: string;
  member: string;
  reason: string;
}

type Callable =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | MethodSignature
  | FunctionTypeNode;

/** Sites where a raw `number` is the correct, deliberate type. Each entry needs
 *  a reason that explains why the brand would be WRONG here — not merely
 *  inconvenient. "Not worth changing yet" is not a reason; fix it or leave it
 *  reported. */
const ALLOWLIST: readonly AllowEntry[] = [
  // The three perf-trace parsers read the Chrome Trace Event Format, where
  // `pid`/`tid` are the OS process and thread ids of the emitting renderer.
  // Nothing to do with a player slot — the name collision is total.
  ...["analyze-perf-peaks", "analyze-perf-window", "analyze-trace"].map(
    (script) => ({
      file: `scripts/${script}.ts`,
      container: "TraceEvent",
      member: "pid",
      reason:
        "Chrome Trace Event Format field: the OS process id of the emitting " +
        "renderer, paired with `tid` (thread id). Not a player slot.",
    }),
  ),
  {
    file: "src/online/online-server-events.ts",
    container: "validPid",
    member: "pid",
    reason:
      "Validator boundary. Accepts an unvalidated integer off the wire and " +
      "decides whether it addresses a real slot; branding the input would " +
      "assume the very property this function exists to establish. The brand " +
      "is produced downstream, at the callers that pass the check.",
  },
  {
    file: "src/input/input-touch-ui.ts",
    container: "zoomButtonBg",
    member: "pid",
    reason:
      "Accepts the -1 sentinel from `playerByZone(...) ?? -1` (no player owns " +
      "the previewed zone), so the parameter is deliberately WIDER than " +
      "PlayerId. Narrowing it would push the sentinel handling onto the one " +
      "caller for no gain.",
  },
];

main();

function main(): void {
  const args = process.argv.slice(2);
  const wantReport = args.includes("--report");
  const wantCheck = args.includes("--check");
  const filterIdx = args.indexOf("--filter");
  const filterRe =
    filterIdx >= 0 && args[filterIdx + 1]
      ? new RegExp(args[filterIdx + 1]!)
      : null;

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  // `scripts/` is included: the mcp-play harness and the debug/report CLIs are
  // real consumers of the branded APIs, and a brand that stops at the src/
  // boundary stops being enforced exactly where hand-written tooling calls in.
  project.addSourceFilesAtPaths([
    "src/**/*.ts",
    "dev/**/*.ts",
    "server/**/*.ts",
    "scripts/**/*.ts",
  ]);

  const brandPatterns = collectBrandPatterns(project);
  if (brandPatterns.length === 0) {
    console.error("No branded number types found — nothing to audit.");
    process.exit(1);
  }

  const findings: Finding[] = [];
  for (const sf of project.getSourceFiles()) {
    collectProperties(sf, brandPatterns, findings);
    collectParameters(sf, brandPatterns, findings);
    collectReturns(sf, brandPatterns, findings);
  }

  const allowed: Finding[] = [];
  const flagged: Finding[] = [];
  for (const finding of findings) {
    if (isAllowlisted(finding)) allowed.push(finding);
    else flagged.push(finding);
  }

  const filtered = filterRe
    ? flagged.filter((finding) =>
        filterRe.test(`${finding.container}.${finding.member}`),
      )
    : flagged;

  filtered.sort(
    (finA, finB) =>
      finA.suggestedBrand.localeCompare(finB.suggestedBrand) ||
      finA.file.localeCompare(finB.file) ||
      finA.line - finB.line,
  );

  if (wantCheck) {
    runCheck(filtered, allowed.length);
    return;
  }
  if (wantReport) {
    printReport(filtered, allowed.length);
    return;
  }
  console.log(JSON.stringify(filtered, null, 2));
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

/** Hard-coded suffix lists — adding a new branded number type to the codebase
 *  requires a new entry here. `collectBrandPatterns` fails the run if a brand
 *  is found in source without a matching entry, so the list cannot drift. */
function brandSuffixes(brand: string): string[] | null {
  switch (brand) {
    case "ZoneId":
      return ["Zone", "ZoneId"];
    case "PlayerId":
      // `Pid` catches the idiomatic short forms (`pid`, `myPid`, `ownerPid`).
      // `Player` alone is deliberately absent — far too broad.
      return ["PlayerId", "Pid"];
    case "ValidPlayerId":
      return null; // Subset of PlayerId; covered by the PlayerId entry.
    case "TowerIdx":
      return ["TowerIdx", "TowerIndex"];
    case "CannonIdx":
      return ["CannonIdx", "CannonIndex"];
    case "TileKey":
      return ["TileKey"];
    case "ShotKey":
      return ["ShotKey"];
    default:
      return null;
  }
}

function collectProperties(
  sf: SourceFile,
  brandPatterns: BrandPattern[],
  findings: Finding[],
): void {
  for (const iface of sf.getInterfaces()) {
    collectFromInterface(iface, brandPatterns, findings);
  }
  for (const ta of sf.getTypeAliases()) {
    collectFromTypeAlias(ta, brandPatterns, findings);
  }
}

/** Parameters of every callable form: declarations, methods, arrows, function
 *  expressions, plus the *type-level* callables (method signatures, function
 *  types) that define deps-object and controller contracts. */
function collectParameters(
  sf: SourceFile,
  brandPatterns: BrandPattern[],
  findings: Finding[],
): void {
  for (const fn of callableNodes(sf)) {
    const container = callableName(fn);
    for (const param of fn.getParameters()) {
      const declaredType = param.getTypeNode()?.getText();
      if (!declaredType || !isPlainNumber(declaredType)) continue;
      const match = matchBrand(param.getName(), brandPatterns);
      if (!match) continue;
      findings.push({
        kind: "parameter",
        container,
        member: param.getName(),
        file: relFile(param.getSourceFile()),
        line: param.getStartLineNumber(),
        declaredType,
        suggestedBrand: match.brand,
        brandDefinedAt: match.definedAt,
      });
    }
  }
}

/** Declared return types, keyed on the callable's own name. Covers plain
 *  functions (`function povPlayerId(): number`) and function-typed contract
 *  members (`povPlayerId: () => number`), which the property scan skips
 *  because their declared type is `() => number`, not `number`. */
function collectReturns(
  sf: SourceFile,
  brandPatterns: BrandPattern[],
  findings: Finding[],
): void {
  for (const fn of callableNodes(sf)) {
    const declaredType = fn.getReturnTypeNode()?.getText();
    if (!declaredType || !isPlainNumber(declaredType)) continue;
    const name = callableName(fn);
    if (name === "<anon>") continue;
    const match = matchBrand(name, brandPatterns);
    if (!match) continue;
    // `<result>By<key>` — the trailing token names the lookup key, not the
    // returned value. `playerByZone` returns a player id; suggesting ZoneId
    // here would be actively wrong.
    if (isLookupByName(name, match)) continue;
    findings.push({
      kind: "return",
      container: name,
      member: name,
      file: relFile(fn.getSourceFile()),
      line: fn.getStartLineNumber(),
      declaredType,
      suggestedBrand: match.brand,
      brandDefinedAt: match.definedAt,
    });
  }
}

function isAllowlisted(finding: Finding): boolean {
  return ALLOWLIST.some(
    (entry) =>
      entry.file === finding.file &&
      entry.container === finding.container &&
      entry.member === finding.member,
  );
}

function runCheck(flagged: Finding[], allowedCount: number): void {
  if (flagged.length === 0) {
    console.log(
      `audit-brand-candidates: clean (${allowedCount} allowlisted site(s)).`,
    );
    return;
  }
  console.error(
    `audit-brand-candidates: ${flagged.length} raw-number declaration(s) whose name implies an existing brand.\n`,
  );
  for (const item of flagged) {
    console.error(
      `  ${item.file}:${item.line}  ${item.kind.padEnd(9)} ${item.container}.${item.member}: ${item.declaredType}  ->  ${item.suggestedBrand}`,
    );
  }
  console.error(
    "\nFix: change the declaration to the branded type (see " +
      "`npm run refactor2 -- change type --params-named <name> --from-type number --to <Brand>`).\n" +
      "If the raw number is genuinely correct — a validator boundary that " +
      "produces the brand, or a parameter accepting a sentinel — add an " +
      "ALLOWLIST entry in scripts/audit-brand-candidates.ts with the reason.",
  );
  process.exit(1);
}

function isNumberBrand(ta: TypeAliasDeclaration): boolean {
  const typeNode = ta.getTypeNode();
  if (!typeNode || !typeNode.isKind(SyntaxKind.IntersectionType)) return false;
  const text = typeNode.getText();
  // `number & { readonly __Foo: true }` pattern (and variants with newlines)
  return /\bnumber\b/.test(text) && /readonly\s+__/.test(text);
}

function callableNodes(sf: SourceFile): Callable[] {
  return [
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sf.getDescendantsOfKind(SyntaxKind.MethodSignature),
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionType),
  ];
}

/** Best-effort declaration name for a callable. Arrow functions and function
 *  types borrow the name of the variable or property they are assigned to —
 *  that is what carries the brand signal (`povPlayerId: () => number`). */
function callableName(fn: Callable): string {
  if (
    fn.isKind(SyntaxKind.FunctionDeclaration) ||
    fn.isKind(SyntaxKind.MethodDeclaration) ||
    fn.isKind(SyntaxKind.MethodSignature)
  ) {
    return fn.getName() ?? "<anon>";
  }
  const named = fn.getFirstAncestor(
    (anc) =>
      anc.isKind(SyntaxKind.VariableDeclaration) ||
      anc.isKind(SyntaxKind.PropertySignature) ||
      anc.isKind(SyntaxKind.PropertyAssignment) ||
      anc.isKind(SyntaxKind.PropertyDeclaration),
  );
  if (!named) return "<anon>";
  const nameNode = (
    named as unknown as { getName?: () => string | undefined }
  ).getName?.();
  return nameNode ?? "<anon>";
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
    kind: "property",
    container,
    member: propName,
    file: relFile(sig.getSourceFile()),
    line: sig.getStartLineNumber(),
    declaredType,
    suggestedBrand: match.brand,
    brandDefinedAt: match.definedAt,
  });
}

function relFile(sf: SourceFile): string {
  return path.relative(process.cwd(), sf.getFilePath());
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

/** True when `name` follows the `<result>By<key>` lookup convention and the
 *  matched suffix is the KEY half. Such a function returns the result, so the
 *  key's brand says nothing about its return type. */
function isLookupByName(name: string, pattern: BrandPattern): boolean {
  for (const suffix of pattern.suffixes) {
    if (!name.toLowerCase().endsWith(suffix.toLowerCase())) continue;
    const boundaryIdx = name.length - suffix.length;
    if (boundaryIdx >= 2 && name.slice(boundaryIdx - 2, boundaryIdx) === "By") {
      return true;
    }
  }
  return false;
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

function printReport(items: Finding[], allowedCount: number): void {
  if (items.length === 0) {
    console.log(
      `No brand candidates found — wire/contract types align (${allowedCount} allowlisted site(s)).`,
    );
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
        `  [${item.kind}] ${item.container}.${item.member}: ${item.declaredType}  ${item.file}:${item.line}`,
      );
    }
  }
  console.log(
    `\nTotal candidates: ${items.length} (${allowedCount} allowlisted site(s) not shown)`,
  );
}
