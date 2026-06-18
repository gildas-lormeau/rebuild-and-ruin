/**
 * Audit: exports under `src/shared/` consumed by too few domains to justify
 * living in the cross-domain foundation.
 *
 * `src/shared/` is the "consumed by 2+ domains" tier (see src/shared/README.md:
 * "consumed by game/ AND at least one other domain"). An export whose entire
 * consumer profile is a SINGLE non-shared domain is mis-homed — it is not
 * shared vocabulary, it is that domain's code parked in the foundation. This
 * is the mechanical signal behind the hand-done de-sharing commits
 * (bb603d5b "de-share game-only leaves", 15754269 "fence sim internals").
 *
 * For each exported declaration under src/shared/, this computes the set of
 * DISTINCT non-shared domains that reference it (via the same ts-morph
 * reference machinery as audit-single-call-exports.ts) and flags those with
 * `consumerDomains <= --max-domains` (default 1):
 *
 *   - 1 consumer domain  → DE-SHARE candidate. Suggested home is that domain
 *                          (a type that is part of a serialized contract may
 *                          legitimately stay — reviewer judgment).
 *   - 0 consumer domains, but referenced inside shared/ → SHARED-INTERNAL.
 *                          Used only by other shared files; not foundation
 *                          vocabulary, but moving it needs its shared callers
 *                          to move too. Lower priority; shown as [internal].
 *   - 0 references anywhere → dead; knip already covers this. Skipped.
 *
 * A per-file rollup flags whole files whose every export resolves to the same
 * single domain — these are whole-file move candidates (the trajectory.ts
 * case), not extract-one-export.
 *
 * Domain of a file is read from `.import-cells.json` (the canonical
 * file→domain map the boundary linter uses), with a path-based fallback for
 * files outside the cell map (dev/, server/, root entries).
 *
 * AUDIT-ONLY: no baseline, no exit code. Heuristic — barrel re-exports can
 * undercount a consumer domain; verify each finding before moving.
 *
 * Usage:
 *   deno run -A scripts/audit-shared-domain-spread.ts [options]
 *
 * Options:
 *   --max-domains=N    Flag exports with <= N distinct consumer domains
 *                      (default 1).
 *   --include-internal Also show shared-internal exports (0 outside domains
 *                      but referenced within shared/). Off by default.
 *   --transitive       Resolve shared-internal exports through their consumer
 *                      chain: a leaf referenced only by other shared files
 *                      inherits the non-shared domains those files ultimately
 *                      serve (e.g. brandFreshInterior → game via
 *                      player-interior.ts). Inherited findings are tagged
 *                      [via-shared]. A leaf whose shared consumers fan out to
 *                      multiple domains (a genuine hub) exceeds --max-domains
 *                      and stays excluded.
 *   --functions-only   Only flag behavior (function decls + arrow/function
 *                      consts). Suppresses the dominant FP class: types,
 *                      enums, and plain constants are the game domain's shared
 *                      *vocabulary*, blessed in shared/core even at one
 *                      importer (game-constants, geometry-types, the pools).
 *   --include-cast-seams  Also flag cast seams (`return <expr> as <Brand>`).
 *                      Excluded by default: these are brand mints — the
 *                      constructor of a shared branded type (e.g.
 *                      emptyFreshInterior for FreshInterior). A type's mint
 *                      belongs with the type regardless of consumer count, the
 *                      same exclusion audit-single-call-exports.ts applies.
 *   --filter=<re>      Only show findings whose declaring file matches the re.
 *   --json             Emit JSON.
 *
 * Coverage note: src/, dev/, and server/ are loaded as consumers. test/ is
 * not — a test importing a shared export does not argue against moving it, so
 * test-only consumers are deliberately invisible. server/ IS loaded: a shared
 * export used by game/ + server/ must stay shared, since server's allowed deps
 * are only {shared, protocol} and "move to game/" would be an illegal import.
 */

import process from "node:process";
import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

interface Cell {
  domain: string;
  files: string[];
}

interface Finding {
  file: string;
  subfolder: string;
  line: number;
  name: string;
  kind: string;
  consumerDomains: string[];
  refCount: number;
  /** True when consumerDomains were inherited through a shared-internal
   *  consumer chain (--transitive) rather than observed directly. */
  transitive: boolean;
}

/** One exported declaration with its raw, un-thresholded reference profile.
 *  Keyed `file#name` so transitive resolution follows the specific
 *  symbol that holds a reference, not the whole file it lives in. */
interface RawExport {
  key: string;
  file: string;
  subfolder: string;
  line: number;
  name: string;
  kind: string;
  /** Distinct non-shared domains that reference this export directly. */
  directDomains: Set<string>;
  /** Keys of shared exported symbols whose body references this export. */
  consumerSymbols: Set<string>;
  /** Shared files with a reference NOT inside any exported symbol (module
   *  init, non-exported helper) — resolved at file granularity as a fallback. */
  consumerFallbackFiles: Set<string>;
  refCount: number;
  /** Body is exactly `return <expr> as <Brand>` — a type-construction seam
   *  (brand mint), not domain behavior. The mint of a shared type belongs
   *  with the type regardless of consumer count. Excluded by default. */
  isCastSeam: boolean;
}

/** Kinds that carry behavior (movable game logic) vs. vocabulary (types,
 *  enums, plain constants the README blesses in shared/core). `--functions-only`
 *  keeps just these. */
const BEHAVIOR_KINDS = new Set([
  "FunctionDeclaration",
  "ArrowFunction",
  "FunctionExpression",
]);

main();

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const includeInternal = args.includes("--include-internal");
  const transitive = args.includes("--transitive");
  const functionsOnly = args.includes("--functions-only");
  const includeCastSeams = args.includes("--include-cast-seams");
  const maxArg = args.find((a) => a.startsWith("--max-domains="));
  const maxDomains = maxArg
    ? parseInt(maxArg.slice("--max-domains=".length), 10)
    : 1;
  const filterArg = args.find((a) => a.startsWith("--filter="));
  const filter = filterArg
    ? new RegExp(filterArg.slice("--filter=".length))
    : null;

  const fileToDomain = loadDomainMap();

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  // server/ is loaded so its imports count as real consumers — a shared
  // export used by game/ + server/ is NOT single-domain, and "move to game/"
  // would be an illegal dep for the server (allowed: shared, protocol).
  project.addSourceFilesAtPaths([
    "src/**/*.ts",
    "dev/**/*.ts",
    "server/**/*.ts",
  ]);

  // Pass 1 — gather the raw reference profile of every shared export.
  const raw: RawExport[] = [];
  const totalExports = new Map<string, number>();
  for (const sf of project.getSourceFiles()) {
    const rel = relOf(sf);
    if (!rel.startsWith("src/shared/")) continue;
    if (filter && !filter.test(rel)) continue;
    gatherExports(sf, rel, fileToDomain, raw, totalExports);
  }

  // Pass 2 — resolve effective domains (optionally transitive) and threshold.
  const resolver = transitive ? buildResolver(raw) : null;
  const findings: Finding[] = [];
  for (const exp of raw) {
    let domains = exp.directDomains;
    let viaChain = false;
    const hasSharedConsumer =
      exp.consumerSymbols.size > 0 || exp.consumerFallbackFiles.size > 0;
    if (resolver && domains.size === 0 && hasSharedConsumer) {
      // Inherit the non-shared reach of the specific shared symbols that
      // consume this export. The gate the README implies: a shared-internal
      // helper rides along only while that chain stays narrow — if it fans
      // out to a hub, the union exceeds maxDomains and drops out.
      const inherited = resolver.reachOf(exp);
      if (inherited.size > 0) {
        domains = inherited;
        viaChain = true;
      }
    }

    if (exp.isCastSeam && !includeCastSeams) continue; // brand mint — belongs with its type
    if (functionsOnly && !BEHAVIOR_KINDS.has(exp.kind)) continue;
    if (domains.size > maxDomains) continue;
    if (domains.size === 0) {
      if (exp.refCount === 0) continue; // dead — knip's job
      if (!includeInternal) continue; // shared-internal, no resolvable chain
    }

    findings.push({
      file: exp.file,
      subfolder: exp.subfolder,
      line: exp.line,
      name: exp.name,
      kind: exp.kind,
      consumerDomains: [...domains].sort(),
      refCount: exp.refCount,
      transitive: viaChain,
    });
  }

  if (json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  report(findings, totalExports, project.getSourceFiles().length);
}

function gatherExports(
  sf: SourceFile,
  rel: string,
  fileToDomain: Map<string, string>,
  out: RawExport[],
  totalExports: Map<string, number>,
): void {
  const subfolder = rel.split("/")[2] ?? "?";
  for (const [name, decls] of sf.getExportedDeclarations()) {
    for (const decl of decls) {
      // Only consider declarations physically in this file (skip re-export
      // pass-throughs, which surface as declarations from elsewhere).
      if (relOf(decl.getSourceFile()) !== rel) continue;
      const nameNode = identifierOf(decl);
      if (!nameNode) continue;
      totalExports.set(rel, (totalExports.get(rel) ?? 0) + 1);

      const directDomains = new Set<string>();
      const consumerSymbols = new Set<string>();
      const consumerFallbackFiles = new Set<string>();
      let refCount = 0;
      for (const ref of nameNode.findReferencesAsNodes()) {
        if (ref === nameNode) continue;
        const refRel = relOf(ref.getSourceFile());
        if (refRel === rel) continue; // self-references in the declaring file
        const parent = ref.getParent();
        // Skip re-export specifiers in barrels — not a real consumer.
        if (parent && Node.isExportSpecifier(parent)) continue;
        refCount++;
        if (!refRel.startsWith("src/shared/")) {
          directDomains.add(domainOf(refRel, fileToDomain));
          continue;
        }
        // Shared consumer: attribute it to the specific enclosing exported
        // symbol so the transitive pass follows actual usage, not the whole
        // file. Import specifiers are bindings, not uses — skip them (the
        // real use elsewhere in the file carries the edge).
        if (parent && Node.isImportSpecifier(parent)) continue;
        const enc = enclosingExportName(ref);
        if (enc) consumerSymbols.add(symKey(refRel, enc));
        else consumerFallbackFiles.add(refRel);
      }

      out.push({
        key: symKey(rel, name),
        file: rel,
        subfolder,
        line: nameNode.getStartLineNumber(),
        name,
        kind: refinedKind(decl),
        directDomains,
        consumerSymbols,
        consumerFallbackFiles,
        refCount,
        isCastSeam: isCastSeam(decl),
      });
      break; // one record per exported name
    }
  }
}

function symKey(file: string, name: string): string {
  return `${file}#${name}`;
}

/** Name of the nearest exported declaration enclosing a node — the symbol
 *  whose body holds the reference. null when the reference sits at module
 *  scope or inside a non-exported helper (caller treats that as a file-level
 *  fallback). */
function enclosingExportName(ref: Node): string | null {
  let node: Node | undefined = ref.getParent();
  while (node && !Node.isSourceFile(node)) {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isClassDeclaration(node) ||
      Node.isInterfaceDeclaration(node) ||
      Node.isEnumDeclaration(node) ||
      Node.isTypeAliasDeclaration(node)
    ) {
      if (node.isExported()) return node.getName() ?? null;
    }
    if (Node.isVariableDeclaration(node)) {
      const stmt = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
      const nameNode = node.getNameNode();
      if (stmt?.isExported() && Node.isIdentifier(nameNode)) {
        return nameNode.getText();
      }
    }
    node = node.getParent();
  }
  return null;
}

/** Distinguish an exported arrow/function-expression const from a plain data
 *  const, so behavior assigned to a `const fn = () => …` is classified with
 *  the functions, not the vocabulary. */
function refinedKind(decl: Node): string {
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return init.getKindName();
    }
  }
  return decl.getKindName();
}

/** A "cast seam": a function whose whole body is `return <expr> as <Type>`
 *  (incl. chained `as unknown as Brand`) or an arrow with an `as` expression
 *  body. It exists to be the single blessed site that mints a branded type —
 *  the constructor of a shared type, which belongs with the type regardless of
 *  how many domains call it. Mirrors isCastSeam in audit-single-call-exports.ts.
 *  Content-based (the body IS a type assertion), not a name/comment proxy. */
function isCastSeam(decl: Node): boolean {
  let fn: ArrowFunction | FunctionDeclaration | FunctionExpression | undefined;
  if (Node.isFunctionDeclaration(decl)) {
    fn = decl;
  } else if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      fn = init;
    }
  }
  if (!fn) return false;
  const body = fn.getBody();
  if (!body) return false;
  // Arrow with an expression body: `(x) => x as T`.
  if (Node.isAsExpression(body)) return true;
  if (!Node.isBlock(body)) return false;
  const stmts = body.getStatements();
  if (stmts.length !== 1) return false;
  const stmt = stmts[0];
  if (!Node.isReturnStatement(stmt)) return false;
  const expr = stmt.getExpression();
  return !!expr && Node.isAsExpression(expr);
}

/** Symbol-granular transitive reach. The non-shared reach of an export is its
 *  own direct non-shared consumers, plus the reach of each shared *symbol*
 *  whose body uses it (not every export of the consumer's file), plus a
 *  file-level fallback for references outside any exported symbol. Propagated
 *  upstream along the usage edge so a leaf used only inside shared/ inherits
 *  exactly the domains it ultimately serves. Acyclic by the layer system; a
 *  visiting guard makes the DFS total regardless. */
function buildResolver(raw: RawExport[]): {
  reachOf: (exp: RawExport) => Set<string>;
} {
  const bySymbol = new Map<string, RawExport>();
  const byFile = new Map<string, RawExport[]>();
  for (const exp of raw) {
    bySymbol.set(exp.key, exp);
    const list = byFile.get(exp.file) ?? [];
    list.push(exp);
    byFile.set(exp.file, list);
  }

  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const reach = (exp: RawExport): Set<string> => {
    const cached = memo.get(exp.key);
    if (cached) return cached;
    if (visiting.has(exp.key)) return new Set(); // cycle backstop
    visiting.add(exp.key);
    const result = new Set(exp.directDomains);
    for (const symbolKey of exp.consumerSymbols) {
      const consumer = bySymbol.get(symbolKey);
      if (consumer) for (const d of reach(consumer)) result.add(d);
    }
    for (const file of exp.consumerFallbackFiles) {
      for (const peer of byFile.get(file) ?? []) {
        for (const d of reach(peer)) result.add(d);
      }
    }
    visiting.delete(exp.key);
    memo.set(exp.key, result);
    return result;
  };

  return { reachOf: reach };
}

function identifierOf(decl: Node): Identifier | null {
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isClassDeclaration(decl) ||
    Node.isInterfaceDeclaration(decl) ||
    Node.isTypeAliasDeclaration(decl) ||
    Node.isEnumDeclaration(decl) ||
    Node.isVariableDeclaration(decl)
  ) {
    const nameNode = decl.getNameNode();
    // VariableDeclaration name can be a binding pattern; only plain
    // identifiers are reference-findable.
    if (nameNode && Node.isIdentifier(nameNode)) return nameNode;
  }
  return null;
}

function report(
  findings: Finding[],
  totalExports: Map<string, number>,
  fileCount: number,
): void {
  if (findings.length === 0) {
    console.log(`✔ No under-shared exports found (${fileCount} files audited)`);
    return;
  }

  // Per-file rollup: every flagged export points at the same single domain.
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  console.log(
    `${findings.length} under-shared export(s) across ${byFile.size} file(s):\n`,
  );

  findings.sort(
    (a, b) =>
      a.consumerDomains.join().localeCompare(b.consumerDomains.join()) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  for (const f of findings) {
    const target =
      f.consumerDomains.length === 0
        ? "[internal]"
        : `→ ${f.consumerDomains.join("+")}`;
    const via = f.transitive ? " [via-shared]" : "";
    console.log(
      `  ${f.file}:${f.line}  ${f.name}  (${f.kind})  ${target}${via}  [${f.refCount} refs]`,
    );
  }

  // A whole-file move candidate requires EVERY export of the file to be
  // flagged (no broadly-shared export anchors it) AND all to converge on
  // one domain — otherwise a single game-only helper next to a universal
  // type (e.g. emptyFreshInterior beside Player) would falsely flag the file.
  const wholeFile: string[] = [];
  for (const [file, fs] of byFile) {
    if (fs.length !== (totalExports.get(file) ?? 0)) continue;
    const domains = new Set(fs.flatMap((f) => f.consumerDomains));
    if (domains.size === 1) wholeFile.push(`${file} → ${[...domains][0]}`);
  }
  if (wholeFile.length > 0) {
    console.log(`\nWhole-file move candidates (all exports → one domain):`);
    for (const line of wholeFile.sort()) console.log(`  ${line}`);
  }
  console.log("");
}

function loadDomainMap(): Map<string, string> {
  const cells = JSON.parse(
    Deno.readTextFileSync(".import-cells.json"),
  ) as Cell[];
  const map = new Map<string, string>();
  for (const cell of cells) {
    for (const file of cell.files) map.set(file, cell.domain);
  }
  return map;
}

function domainOf(rel: string, fileToDomain: Map<string, string>): string {
  const known = fileToDomain.get(rel);
  if (known) return known;
  if (rel.startsWith("dev/")) return "dev";
  if (rel.startsWith("server/")) return "server";
  if (rel.startsWith("test/")) return "test";
  const parts = rel.split("/");
  if (parts[0] === "src" && parts.length === 2) return "entry";
  if (parts[0] === "src") return parts[1];
  return "external";
}

function relOf(sf: SourceFile | { getFilePath(): string }): string {
  return sf.getFilePath().replace(`${process.cwd()}/`, "");
}
