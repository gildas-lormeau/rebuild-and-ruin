/**
 * AST-based refactoring CLI for reliable multi-file edits.
 *
 * Commands:
 *   rename-symbol  <file> <name> <newName>   — Rename a symbol across all files
 *   move-export    <from> <to> <name>        — Move an exported declaration between files
 *   rename-prop    <typeName> <prop> <newProp> — Rename an interface/type property across all files (also accepts <file> <typeName> <prop> <newProp>)
 *   rename-in-file <name> <newName> <file...> — Rename ALL declarations of a name within specific files (also accepts <file...> <name> <newName>)
 *   rename-file    <oldPath> <newPath>        — Rename/move a file and update all imports
 *   merge-imports  <file...> | --all         — Merge duplicate imports from same module specifier
 *
 * Usage: deno run -A scripts/refactor.ts <command> [...args] [--dry-run]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  type ExportedDeclarations,
  type Identifier,
  type ImportDeclaration,
  type ImportSpecifier,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

interface ImportInfo {
  moduleSpecifier: string;
  namedImports: string[];
  isTypeOnly: boolean;
}

interface BarrelEntry {
  sourceRelPath: string; // project-relative path (for display / grouping)
  moduleSpecifier: string; // relative specifier from outFile to sourceFile
  valueSymbols: Set<string>;
  typeSymbols: Set<string>;
}

/**
 * Resolution of one named import going *through* a re-export-only barrel.
 * `underlyingPath` is the absolute path of the file that truly defines
 * (or further re-exports) the symbol, and `originalName` is the name used
 * at that definition site (stripping any `as` alias the barrel applied).
 */
interface BarrelResolution {
  underlyingPath: string;
  originalName: string;
}

interface BarrelReexportMap {
  /** alias-seen-by-importer → underlying source + original symbol name */
  named: Map<string, BarrelResolution>;
  /**
   * Absolute paths of files targeted by `export * from "..."`. We can't
   * resolve a specific symbol through these without scanning each target's
   * exported declarations, so we fall back to a warning for unknown symbols.
   */
  namespaceTargets: string[];
}

interface BulkRedirectEntry {
  symbol: string;
  from: string;
  to: string;
}

interface CrossDomainRecord {
  importer: string;
  imported: string;
  symbols: string[];
  kind: "value" | "type";
}

interface PublicSurfaceRecord {
  symbol: string;
  source: string;
  consumers: number;
  consumerFiles: string[];
}

type BoolEval = "true" | "false" | "unknown";

interface FoldResult {
  folded: boolean;
  outcome: BoolEval;
  action: string;
}

interface FoldRecord {
  file: string;
  line: number;
  outcome: BoolEval;
  action: string;
}

type FunctionLike =
  | import("ts-morph").FunctionDeclaration
  | import("ts-morph").MethodDeclaration
  | import("ts-morph").ArrowFunction
  | import("ts-morph").FunctionExpression;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allFlag = args.includes("--all");
const cascadeFlag = args.includes("--cascade");
// Parsed once so top-level state doesn't rely on a top-level for-loop —
// reorder-file.ts hoists `const` declarations above loose imperative code,
// which would otherwise destructure from an empty array.
const parsed = parseArgv(args);
const flagMap = parsed.flagMap;
const flagMulti = parsed.flagMulti;
const positionalArgs = parsed.positionalArgs;
const [command, ...commandArgs] = positionalArgs;

if (!command) {
  printUsage();
  process.exit(1);
}

switch (command) {
  case "rename-symbol": {
    const file = flagMap.get("file") ?? commandArgs[0];
    const name =
      flagMap.get("name") ??
      flagMap.get("symbol") ??
      flagMap.get("old") ??
      commandArgs[1];
    const newName =
      flagMap.get("new-name") ??
      flagMap.get("newName") ??
      flagMap.get("new") ??
      commandArgs[2];
    if (!file || !name || !newName) {
      console.error("Usage: rename-symbol <file> <name> <newName>");
      process.exit(1);
    }
    renameSymbol(file, name, newName);
    break;
  }
  case "move-export": {
    let from = flagMap.get("from") ?? commandArgs[0];
    let to = flagMap.get("to") ?? commandArgs[1];
    // Support multiple symbols: --symbol A --symbol B, or single positional
    let symbols =
      flagMulti.get("symbol") ??
      flagMulti.get("name") ??
      (commandArgs[2] ? [commandArgs[2]] : []);

    // Smart reorder: if 'from' doesn't look like a file path, assume user passed <name> <from> <to>
    if (
      from &&
      !from.includes("/") &&
      !from.endsWith(".ts") &&
      commandArgs.length >= 3
    ) {
      const reorderedFrom = commandArgs[1]!;
      const reorderedTo = commandArgs[2]!;
      const reorderedSymbol = commandArgs[0]!;
      // Only reorder if the swapped values look like paths
      if (reorderedFrom.includes("/") || reorderedFrom.endsWith(".ts")) {
        from = reorderedFrom;
        to = reorderedTo;
        symbols = [reorderedSymbol];
      }
    }

    if (!from || !to || symbols.length === 0) {
      console.error(
        "Usage: move-export <from> <to> <name> OR --from <from> --to <to> --symbol <name> [--symbol <name2>]",
      );
      process.exit(1);
    }
    for (const name of symbols) {
      moveExport(from, to, name);
    }
    break;
  }
  case "rename-prop": {
    let typeName =
      flagMap.get("type") ?? flagMap.get("typeName") ?? commandArgs[0];
    let prop = flagMap.get("prop") ?? flagMap.get("old") ?? commandArgs[1];
    let newProp =
      flagMap.get("new-prop") ??
      flagMap.get("newProp") ??
      flagMap.get("new") ??
      commandArgs[2];

    // Smart reorder: if first arg looks like a file path, assume user passed <file> <type> <prop> <newProp>
    if (
      typeName &&
      (typeName.includes("/") || typeName.endsWith(".ts")) &&
      commandArgs.length >= 4
    ) {
      typeName = commandArgs[1];
      prop = commandArgs[2];
      newProp = commandArgs[3];
    }

    if (!typeName || !prop || !newProp) {
      console.error("Usage: rename-prop <typeName> <prop> <newProp>");
      process.exit(1);
    }
    renameProp(typeName, prop, newProp);
    break;
  }
  case "rename-in-file": {
    let name =
      flagMap.get("name") ??
      flagMap.get("symbol") ??
      flagMap.get("old") ??
      commandArgs[0];
    let newName =
      flagMap.get("new-name") ??
      flagMap.get("newName") ??
      flagMap.get("new") ??
      commandArgs[1];
    let files = flagMap.has("files")
      ? flagMap.get("files")!.split(",")
      : commandArgs.slice(2);

    // Smart reorder: if first arg looks like a file path, assume user passed <file...> <name> <newName>
    if (
      name &&
      (name.includes("/") || name.endsWith(".ts")) &&
      !flagMap.has("name") &&
      !flagMap.has("symbol") &&
      !flagMap.has("old")
    ) {
      // Find where file paths end and identifiers begin
      const firstNonFile = commandArgs.findIndex(
        (a) => !a.includes("/") && !a.endsWith(".ts"),
      );
      if (firstNonFile >= 0 && firstNonFile + 1 < commandArgs.length) {
        files = commandArgs.slice(0, firstNonFile);
        name = commandArgs[firstNonFile];
        newName = commandArgs[firstNonFile + 1];
      }
    }

    if (!name || !newName || files.length === 0) {
      console.error("Usage: rename-in-file <name> <newName> <file...>");
      process.exit(1);
    }
    console.log(
      `Renaming all "${name}" → "${newName}" in ${files.length} file(s)`,
    );
    renameInFile(name, newName, files);
    break;
  }
  case "rename-file": {
    const oldFile = flagMap.get("from") ?? flagMap.get("old") ?? commandArgs[0];
    const newFile = flagMap.get("to") ?? flagMap.get("new") ?? commandArgs[1];
    if (!oldFile || !newFile) {
      console.error("Usage: rename-file <oldPath> <newPath>");
      process.exit(1);
    }
    renameFile(oldFile, newFile);
    break;
  }
  case "merge-imports": {
    const files = allFlag ? [] : commandArgs;
    if (!allFlag && files.length === 0) {
      console.error("Usage: merge-imports <file...> | --all [--dry-run]");
      process.exit(1);
    }
    mergeImports(files);
    break;
  }
  case "find-symbol": {
    const name = flagMap.get("name") ?? flagMap.get("symbol") ?? commandArgs[0];
    if (!name) {
      console.error("Usage: find-symbol <name>");
      process.exit(1);
    }
    findSymbol(name);
    break;
  }
  case "list-exports": {
    const file = flagMap.get("file") ?? commandArgs[0];
    if (!file) {
      console.error("Usage: list-exports <file>");
      process.exit(1);
    }
    listExports(file);
    break;
  }
  case "list-references": {
    const file = flagMap.get("file") ?? flagMap.get("from") ?? commandArgs[0];
    const name = flagMap.get("name") ?? flagMap.get("symbol") ?? commandArgs[1];
    if (!file || !name) {
      console.error("Usage: list-references <file> <name>");
      process.exit(1);
    }
    listReferences(file, name);
    break;
  }
  case "generate-barrel": {
    const sourceDir =
      flagMap.get("source") ?? flagMap.get("dir") ?? commandArgs[0];
    const outFile =
      flagMap.get("out") ?? flagMap.get("output") ?? commandArgs[1];
    if (!sourceDir || !outFile) {
      console.error("Usage: generate-barrel <sourceDir> <outFile> [--dry-run]");
      process.exit(1);
    }
    generateBarrel(sourceDir, outFile);
    break;
  }
  case "redirect-import": {
    const symbol =
      flagMap.get("symbol") ?? flagMap.get("name") ?? commandArgs[0];
    const oldSource =
      flagMap.get("from") ?? flagMap.get("old") ?? commandArgs[1];
    const newSource = flagMap.get("to") ?? flagMap.get("new") ?? commandArgs[2];
    if (!symbol || !oldSource || !newSource) {
      console.error(
        "Usage: redirect-import <symbol> <oldSource> <newSource> [--dry-run]",
      );
      process.exit(1);
    }
    redirectImport(symbol, oldSource, newSource);
    break;
  }
  case "bulk-redirect": {
    const manifest =
      flagMap.get("manifest") ?? flagMap.get("file") ?? commandArgs[0];
    if (!manifest) {
      console.error("Usage: bulk-redirect <manifestFile> [--dry-run]");
      process.exit(1);
    }
    bulkRedirect(manifest);
    break;
  }
  case "list-cross-domain-imports": {
    const projectRoot = flagMap.get("root") ?? commandArgs[0] ?? "src";
    listCrossDomainImports(projectRoot);
    break;
  }
  case "compute-public-surface": {
    const sourceDir =
      flagMap.get("source") ?? flagMap.get("dir") ?? commandArgs[0];
    if (!sourceDir) {
      console.error("Usage: compute-public-surface <sourceDir>");
      process.exit(1);
    }
    computePublicSurface(sourceDir);
    break;
  }
  case "add-reexport": {
    const barrelFile = flagMap.get("barrel") ?? commandArgs[0];
    const sourceFile =
      flagMap.get("source") ?? flagMap.get("from") ?? commandArgs[1];
    const symbol =
      flagMap.get("symbol") ?? flagMap.get("name") ?? commandArgs[2];
    const typeOnly = args.includes("--type");
    if (!barrelFile || !sourceFile || !symbol) {
      console.error(
        "Usage: add-reexport <barrelFile> <sourceFile> <symbol> [--type] [--dry-run]",
      );
      process.exit(1);
    }
    addReexport(barrelFile, sourceFile, symbol, typeOnly);
    break;
  }
  case "list-callsites": {
    const file = flagMap.get("file") ?? flagMap.get("from") ?? commandArgs[0];
    const name = flagMap.get("name") ?? flagMap.get("symbol") ?? commandArgs[1];
    if (!file || !name) {
      console.error("Usage: list-callsites <file> <symbol>");
      process.exit(1);
    }
    listCallsites(file, name);
    break;
  }
  case "remove-export": {
    const file = flagMap.get("file") ?? flagMap.get("from") ?? commandArgs[0];
    const name = flagMap.get("name") ?? flagMap.get("symbol") ?? commandArgs[1];
    if (!file || !name) {
      console.error("Usage: remove-export <file> <name> [--dry-run]");
      process.exit(1);
    }
    removeExport(file, name);
    break;
  }
  case "fold-constant": {
    const file = flagMap.get("file") ?? commandArgs[0];
    const name = flagMap.get("name") ?? flagMap.get("symbol") ?? commandArgs[1];
    const value = flagMap.get("value") ?? commandArgs[2];
    if (!file || !name || !value) {
      console.error(
        "Usage: fold-constant <file> <name> <true|false> [--dry-run]",
      );
      process.exit(1);
    }
    foldConstant(file, name, value);
    break;
  }
  case "inline-param": {
    const file = flagMap.get("file") ?? commandArgs[0];
    const fn = flagMap.get("fn") ?? flagMap.get("function") ?? commandArgs[1];
    const param =
      flagMap.get("param") ?? flagMap.get("parameter") ?? commandArgs[2];
    const value = flagMap.get("value") ?? commandArgs[3];
    const dropParam = args.includes("--drop-param");
    if (!file || !fn || !param || !value) {
      console.error(
        "Usage: inline-param <file> <fn> <param> <true|false> [--drop-param] [--dry-run]",
      );
      process.exit(1);
    }
    inlineParam(file, fn, param, value, dropParam);
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

function listCallsites(filePath: string, symbolName: string): void {
  const project = createProject();
  addAllSources(project);

  const sf = project.getSourceFileOrThrow(resolve(filePath));
  const declId = findDeclarationIdentifier(sf, symbolName);
  if (!declId) {
    console.error(`❌ Symbol "${symbolName}" not found in ${filePath}`);
    process.exit(1);
  }

  const declPath = sf.getFilePath();
  const declLine = declId.getStartLineNumber();

  interface Site {
    file: string;
    line: number;
    kind: string;
    context: string;
  }
  const sites: Site[] = [];

  for (const ref of declId.findReferencesAsNodes()) {
    const refSf = ref.getSourceFile();
    const refFile = refSf.getFilePath();
    const line = ref.getStartLineNumber();

    // Skip the declaration site itself
    if (refFile === declPath && line === declLine) continue;

    const kind = classifyReferenceKind(ref);
    const context = enclosingContext(ref);

    sites.push({
      file: path.relative(process.cwd(), refFile),
      line,
      kind,
      context,
    });
  }

  if (sites.length === 0) {
    console.log(`No call sites for "${symbolName}" from ${filePath}`);
    return;
  }

  sites.sort((aa, bb) => aa.file.localeCompare(bb.file) || aa.line - bb.line);

  let currentFile = "";
  for (const s of sites) {
    if (s.file !== currentFile) {
      console.log(`\n${s.file}`);
      currentFile = s.file;
    }
    console.log(`  :${s.line}  [${s.kind}]  ${s.context}`);
  }
  console.log(
    `\n${sites.length} call site(s) across ${new Set(sites.map((s) => s.file)).size} file(s)`,
  );
}

/** Return the nearest named function/method/class containing this node, or
 *  the closest statement kind if none exists. Helps the reader see *which*
 *  code path holds a given reference without having to open the file. */
function enclosingContext(node: import("ts-morph").Node): string {
  let cursor: import("ts-morph").Node | undefined = node.getParent();
  while (cursor) {
    if (cursor.isKind(SyntaxKind.FunctionDeclaration)) {
      return (
        cursor.asKindOrThrow(SyntaxKind.FunctionDeclaration).getName() ??
        "<anon fn>"
      );
    }
    if (cursor.isKind(SyntaxKind.MethodDeclaration)) {
      const method = cursor.asKindOrThrow(SyntaxKind.MethodDeclaration);
      const cls = method.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
      const clsName = cls?.getName() ?? "?";
      return `${clsName}.${method.getName()}`;
    }
    if (
      cursor.isKind(SyntaxKind.ArrowFunction) ||
      cursor.isKind(SyntaxKind.FunctionExpression)
    ) {
      // Walk up to a named parent if any (variable decl, property assignment)
      const parent = cursor.getParent();
      if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
        return parent.asKindOrThrow(SyntaxKind.VariableDeclaration).getName();
      }
      if (parent?.isKind(SyntaxKind.PropertyAssignment)) {
        return parent.asKindOrThrow(SyntaxKind.PropertyAssignment).getName();
      }
      return "<arrow>";
    }
    if (cursor.isKind(SyntaxKind.ClassDeclaration)) {
      return (
        cursor.asKindOrThrow(SyntaxKind.ClassDeclaration).getName() ??
        "<anon class>"
      );
    }
    if (cursor.isKind(SyntaxKind.SourceFile)) return "<top-level>";
    cursor = cursor.getParent();
  }
  return "<unknown>";
}

function removeExport(filePath: string, symbolName: string): void {
  const project = createProject();
  addAllSources(project);

  const sf = project.getSourceFileOrThrow(resolve(filePath));
  const declarations = sf.getExportedDeclarations().get(symbolName);
  if (!declarations || declarations.length === 0) {
    console.error(`❌ Export "${symbolName}" not found in ${filePath}`);
    process.exit(1);
  }

  const decl = declarations[0]!;

  // Re-export? Point user at the canonical source.
  const declSf = decl.getSourceFile();
  if (declSf.getFilePath() !== sf.getFilePath()) {
    const canonicalPath = path.relative(process.cwd(), declSf.getFilePath());
    console.error(
      `❌ "${symbolName}" in ${filePath} is a re-export from ${canonicalPath}`,
    );
    console.error(`   Remove it from the canonical source instead.`);
    process.exit(1);
  }

  // Find the declaration's own name identifier so we can enumerate references
  // without including the declaration site itself.
  const declId = findDeclarationIdentifier(sf, symbolName);
  if (!declId) {
    console.error(
      `❌ Could not resolve declaration identifier for "${symbolName}"`,
    );
    process.exit(1);
  }
  const declPath = sf.getFilePath();
  const declLine = declId.getStartLineNumber();

  // Collect references. Split into:
  //   - import specifiers (safe to remove)
  //   - non-import references (block the delete)
  interface Blocker {
    file: string;
    line: number;
    kind: string;
  }
  const blockers: Blocker[] = [];
  const importSpecs: ImportSpecifier[] = [];

  for (const ref of declId.findReferencesAsNodes()) {
    const refSf = ref.getSourceFile();
    const refPath = refSf.getFilePath();
    const line = ref.getStartLineNumber();
    if (refPath === declPath && line === declLine) continue; // declaration itself

    const parent = ref.getParent();
    if (parent?.isKind(SyntaxKind.ImportSpecifier)) {
      importSpecs.push(parent.asKindOrThrow(SyntaxKind.ImportSpecifier));
      continue;
    }
    if (parent?.isKind(SyntaxKind.ExportSpecifier)) {
      // Re-export: treat as a blocker — removing a re-export silently could
      // break downstream barrels. User should delete the re-export first.
      blockers.push({
        file: path.relative(process.cwd(), refPath),
        line,
        kind: "re-export",
      });
      continue;
    }

    blockers.push({
      file: path.relative(process.cwd(), refPath),
      line,
      kind: classifyReferenceKind(ref),
    });
  }

  if (blockers.length > 0) {
    console.error(
      `❌ "${symbolName}" has ${blockers.length} non-import reference(s) — remove them first:`,
    );
    blockers.sort(
      (aa, bb) => aa.file.localeCompare(bb.file) || aa.line - bb.line,
    );
    for (const b of blockers) {
      console.error(`   ${b.file}:${b.line}  [${b.kind}]`);
    }
    process.exit(1);
  }

  console.log(
    `Removing export "${symbolName}" from ${filePath} (${importSpecs.length} import site(s))`,
  );

  // Remove import specifiers. Clean up now-empty import declarations.
  const touchedImportDecls = new Set<ImportDeclaration>();
  for (const spec of importSpecs) {
    const imp = spec.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (imp) touchedImportDecls.add(imp);
    spec.remove();
  }
  for (const imp of touchedImportDecls) {
    if (imp.wasForgotten()) continue;
    if (
      imp.getNamedImports().length === 0 &&
      !imp.getDefaultImport() &&
      !imp.getNamespaceImport()
    ) {
      imp.remove();
    }
  }

  // Remove the declaration.
  removeDeclaration(decl);

  const changedFiles = saveChanges(project);
  console.log(`✅ Removed "${symbolName}" — ${changedFiles} file(s) changed`);
}

/** Classify what a reference identifier is doing at its use site. */
function classifyReferenceKind(ref: import("ts-morph").Node): string {
  const parent = ref.getParent();
  if (!parent) return "ref";

  // Import specifier: `import { foo } from '...'`
  if (parent.isKind(SyntaxKind.ImportSpecifier)) return "import";
  if (parent.isKind(SyntaxKind.ImportClause)) return "import-default";
  if (parent.isKind(SyntaxKind.NamespaceImport)) return "import-ns";

  // Export specifier: `export { foo }` or `export { foo } from '...'`
  if (parent.isKind(SyntaxKind.ExportSpecifier)) return "re-export";

  // Call: `foo(...)` — ref is the expression of a CallExpression
  if (parent.isKind(SyntaxKind.CallExpression)) {
    const call = parent.asKindOrThrow(SyntaxKind.CallExpression);
    if (call.getExpression() === ref) return "call";
  }

  // Property access: `obj.foo` or `foo.bar`
  if (parent.isKind(SyntaxKind.PropertyAccessExpression)) {
    const pa = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pa.getExpression() === ref) return "receiver";
    return "property";
  }

  // Type reference: `x: Foo`
  if (parent.isKind(SyntaxKind.TypeReference)) return "type-ref";

  // Assignment target
  if (parent.isKind(SyntaxKind.BinaryExpression)) {
    const be = parent.asKindOrThrow(SyntaxKind.BinaryExpression);
    if (
      be.getLeft() === ref &&
      be.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    )
      return "assign";
  }

  return "read";
}

function foldConstant(
  filePath: string,
  symbolName: string,
  rawValue: string,
): void {
  if (rawValue !== "true" && rawValue !== "false") {
    console.error(
      `❌ fold-constant currently supports boolean literals only (got "${rawValue}")`,
    );
    process.exit(1);
  }
  const value = rawValue === "true";

  const project = createProject();
  addAllSources(project);

  const sf = project.getSourceFileOrThrow(resolve(filePath));
  const declId = findDeclarationIdentifier(sf, symbolName);
  if (!declId) {
    console.error(`❌ Symbol "${symbolName}" not found in ${filePath}`);
    process.exit(1);
  }

  const declPath = sf.getFilePath();
  const declLine = declId.getStartLineNumber();

  // Group references by source file so we can process each file in a stable
  // pass. Collect blocked references (cross-file ones we can reach) and
  // in-file property-access references separately — property accesses like
  // `this.flag` don't show up via findReferencesAsNodes on the declaration
  // identifier of a plain variable, but if the symbol is a class field they
  // will. We fold them the same way.
  const refNodes = declId.findReferencesAsNodes().filter((ref) => {
    const refSf = ref.getSourceFile();
    return !(
      refSf.getFilePath() === declPath && ref.getStartLineNumber() === declLine
    );
  });

  if (refNodes.length === 0) {
    console.log(`No references to "${symbolName}" from ${filePath}`);
    return;
  }

  console.log(
    `Folding "${symbolName}" = ${value} across ${refNodes.length} reference(s)`,
  );

  const { folded, unfoldable } = foldReferences(refNodes, value);
  reportFoldResults(folded, unfoldable);

  const changedFiles = saveChanges(project);
  console.log(`\n✅ Fold complete — ${changedFiles} file(s) changed`);
  if (unfoldable.length === 0) {
    console.log(
      `   All references folded. Consider: remove-export ${filePath} ${symbolName}`,
    );
  }
}

function inlineParam(
  filePath: string,
  fnName: string,
  paramName: string,
  rawValue: string,
  dropParam: boolean,
): void {
  if (rawValue !== "true" && rawValue !== "false") {
    console.error(
      `❌ inline-param currently supports boolean literals only (got "${rawValue}")`,
    );
    process.exit(1);
  }
  const value = rawValue === "true";

  const project = createProject();
  addAllSources(project);

  const sf = project.getSourceFileOrThrow(resolve(filePath));
  const fn = findFunctionLikeByName(sf, fnName);
  if (!fn) {
    console.error(`❌ Function "${fnName}" not found in ${filePath}`);
    process.exit(1);
  }

  const parameters = fn.getParameters();
  const paramIndex = parameters.findIndex((p) => p.getName() === paramName);
  if (paramIndex === -1) {
    console.error(
      `❌ Parameter "${paramName}" not found on "${fnName}" in ${filePath}`,
    );
    process.exit(1);
  }
  const paramNode = parameters[paramIndex]!;
  if (paramNode.isRestParameter()) {
    console.error(`❌ Cannot inline a rest parameter (${paramName})`);
    process.exit(1);
  }

  const body = fn.isKind(SyntaxKind.ArrowFunction)
    ? fn.asKindOrThrow(SyntaxKind.ArrowFunction).getBody()
    : (
        fn as
          | import("ts-morph").FunctionDeclaration
          | import("ts-morph").MethodDeclaration
          | import("ts-morph").FunctionExpression
      ).getBody();
  if (!body) {
    console.error(`❌ "${fnName}" has no body (overload or abstract)`);
    process.exit(1);
  }
  const bodyStart = body.getStart();
  const bodyEnd = body.getEnd();

  // Parameter name identifier — find references, keep only those that live
  // inside the function body (default-value expressions would also match).
  const nameNode = paramNode.getNameNode();
  if (!nameNode.isKind(SyntaxKind.Identifier)) {
    console.error(
      `❌ Cannot inline a destructured parameter — give the parameter a plain name first`,
    );
    process.exit(1);
  }
  const nameId = nameNode.asKindOrThrow(SyntaxKind.Identifier);
  const refsInBody = nameId.findReferencesAsNodes().filter((ref) => {
    if (ref === nameId) return false;
    if (ref.getSourceFile() !== sf) return false;
    const pos = ref.getStart();
    return pos >= bodyStart && pos <= bodyEnd;
  });

  console.log(
    `Inlining ${fnName}(${paramName}) = ${value} across ${refsInBody.length} body reference(s)`,
  );

  const { folded, unfoldable } = foldReferences(refsInBody, value);
  reportFoldResults(folded, unfoldable);

  // Drop the param + matching argument at every call site.
  let droppedCalls = 0;
  let skippedCalls = 0;
  if (dropParam) {
    const fnId = getFunctionLikeNameId(fn);
    if (!fnId) {
      console.error(
        `⚠️  --drop-param: can't resolve name identifier for ${fnName}; signature + call sites left untouched`,
      );
    } else {
      const callRefs = fnId.findReferencesAsNodes().filter((r) => r !== fnId);
      interface CallSite {
        call: import("ts-morph").CallExpression;
        file: string;
        line: number;
      }
      const callSites: CallSite[] = [];
      for (const ref of callRefs) {
        const call = findEnclosingCall(ref);
        if (!call) continue;
        callSites.push({
          call,
          file: path.relative(process.cwd(), ref.getSourceFile().getFilePath()),
          line: ref.getStartLineNumber(),
        });
      }

      // Sort descending by position within each file so earlier mutations
      // don't invalidate later call nodes.
      callSites.sort((aa, bb) => {
        const fileCmp = aa.file.localeCompare(bb.file);
        if (fileCmp !== 0) return fileCmp;
        return bb.call.getStart() - aa.call.getStart();
      });

      for (const { call, file, line } of callSites) {
        const args = call.getArguments();
        if (args.length <= paramIndex) {
          // Caller already omits this argument (optional/default) — nothing to do.
          continue;
        }
        const arg = args[paramIndex]!;
        const argText = arg.getText();
        // Warn (but still remove) if the caller passes a non-literal — user
        // asserted the parameter is invariantly `value`, so any other arg is
        // already dead, but we surface it so they can double-check.
        if (argText !== rawValue) {
          console.log(
            `  ⚠️  ${file}:${line}  call passes "${truncate(argText, 30)}" (not ${rawValue}) — removing anyway`,
          );
          skippedCalls++;
        }
        call.removeArgument(paramIndex);
        droppedCalls++;
      }

      paramNode.remove();
      console.log(
        `\nDropped param "${paramName}" from signature + ${droppedCalls} call site(s)${
          skippedCalls > 0
            ? ` (${skippedCalls} passed a non-${rawValue} argument)`
            : ""
        }`,
      );
    }
  }

  const changedFiles = saveChanges(project);
  console.log(`\n✅ Inline complete — ${changedFiles} file(s) changed`);
}

/** Run tryFoldAtReference on every node in `refNodes`, grouped per file in
 *  reverse document order (so a later fold doesn't invalidate an earlier
 *  ref's position). Shared by fold-constant and inline-param. */
function foldReferences(
  refNodes: import("ts-morph").Node[],
  value: boolean,
): { folded: FoldRecord[]; unfoldable: FoldRecord[] } {
  const folded: FoldRecord[] = [];
  const unfoldable: FoldRecord[] = [];

  const byFile = new Map<string, import("ts-morph").Node[]>();
  for (const ref of refNodes) {
    const key = ref.getSourceFile().getFilePath();
    const arr = byFile.get(key) ?? [];
    arr.push(ref);
    byFile.set(key, arr);
  }
  for (const arr of byFile.values()) {
    arr.sort((aa, bb) => bb.getStart() - aa.getStart());
  }

  for (const [, refs] of byFile) {
    for (const ref of refs) {
      if (ref.wasForgotten()) continue;
      const refFile = path.relative(
        process.cwd(),
        ref.getSourceFile().getFilePath(),
      );
      const line = ref.getStartLineNumber();
      const result = tryFoldAtReference(ref, "", value);
      const record: FoldRecord = {
        file: refFile,
        line,
        outcome: result.outcome,
        action: result.action,
      };
      if (result.folded) folded.push(record);
      else unfoldable.push(record);
    }
  }

  return { folded, unfoldable };
}

function reportFoldResults(
  folded: FoldRecord[],
  unfoldable: FoldRecord[],
): void {
  if (folded.length > 0) {
    console.log(`\nFolded ${folded.length} site(s):`);
    for (const f of folded.slice(0, 50)) {
      console.log(`  ${f.file}:${f.line}  [${f.outcome}] ${f.action}`);
    }
    if (folded.length > 50) console.log(`  ... (${folded.length - 50} more)`);
  }

  if (unfoldable.length > 0) {
    console.log(
      `\n${unfoldable.length} reference(s) left untouched (not in a foldable condition context):`,
    );
    for (const u of unfoldable.slice(0, 50)) {
      console.log(`  ${u.file}:${u.line}  ${u.action}`);
    }
    if (unfoldable.length > 50)
      console.log(`  ... (${unfoldable.length - 50} more)`);
  }
}

/** Resolve a name to a function-like declaration in a source file. Handles
 *  `function foo()`, `const foo = () => {}`, `const foo = function () {}`,
 *  and `class X { foo() {} }`. Returns the first match (overload-agnostic). */
function findFunctionLikeByName(
  sf: SourceFile,
  name: string,
): FunctionLike | undefined {
  for (const fn of sf.getFunctions()) {
    if (fn.getName() === name) return fn;
  }
  for (const cls of sf.getClasses()) {
    for (const method of cls.getMethods()) {
      if (method.getName() === name) return method;
    }
  }
  for (const vs of sf.getVariableStatements()) {
    for (const vd of vs.getDeclarations()) {
      if (vd.getName() !== name) continue;
      const init = vd.getInitializer();
      if (!init) continue;
      if (init.isKind(SyntaxKind.ArrowFunction)) {
        return init.asKindOrThrow(SyntaxKind.ArrowFunction);
      }
      if (init.isKind(SyntaxKind.FunctionExpression)) {
        return init.asKindOrThrow(SyntaxKind.FunctionExpression);
      }
    }
  }
  return undefined;
}

/** Return the name identifier of a function-like node, so its references can
 *  be enumerated. Arrow / function-expression initializers sit inside a
 *  VariableDeclaration whose nameNode is the identifier we want. */
function getFunctionLikeNameId(fn: FunctionLike): Identifier | undefined {
  if (fn.isKind(SyntaxKind.FunctionDeclaration)) {
    return fn.asKindOrThrow(SyntaxKind.FunctionDeclaration).getNameNode();
  }
  if (fn.isKind(SyntaxKind.MethodDeclaration)) {
    const nameNode = fn
      .asKindOrThrow(SyntaxKind.MethodDeclaration)
      .getNameNode();
    return nameNode.isKind(SyntaxKind.Identifier)
      ? nameNode.asKindOrThrow(SyntaxKind.Identifier)
      : undefined;
  }
  // Arrow / FunctionExpression: walk up to the VariableDeclaration whose
  // name identifier is the external handle callers use.
  const parent = fn.getParent();
  if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
    const nameNode = parent
      .asKindOrThrow(SyntaxKind.VariableDeclaration)
      .getNameNode();
    return nameNode.isKind(SyntaxKind.Identifier)
      ? nameNode.asKindOrThrow(SyntaxKind.Identifier)
      : undefined;
  }
  return undefined;
}

/** Walk up from a function-name reference to the enclosing CallExpression
 *  where it sits in the callee position (`fn(...)` or `obj.fn(...)`). */
function findEnclosingCall(
  ref: import("ts-morph").Node,
): import("ts-morph").CallExpression | undefined {
  let cursor: import("ts-morph").Node | undefined = ref;
  // Skip one level of PropertyAccess for `obj.method(...)` — the ref is the
  // name token, not the method-access expression itself.
  const paParent = cursor.getParent();
  if (paParent?.isKind(SyntaxKind.PropertyAccessExpression)) {
    const pa = paParent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pa.getNameNode() === cursor) cursor = paParent;
  }
  const callParent = cursor.getParent();
  if (!callParent?.isKind(SyntaxKind.CallExpression)) return undefined;
  const call = callParent.asKindOrThrow(SyntaxKind.CallExpression);
  if (call.getExpression() !== cursor) return undefined;
  return call;
}

/** Starting from a reference identifier, walk up through `!`, `&&`, `||`,
 *  and parenthesized wrappers to the outermost "boolean host" — the enclosing
 *  IfStatement condition or ConditionalExpression condition. Evaluate that
 *  host with the symbol substituted; if determined, rewrite. */
function tryFoldAtReference(
  ref: import("ts-morph").Node,
  _symbolName: string,
  value: boolean,
): FoldResult {
  // Climb to the outermost expression whose truthiness is used as a condition.
  let expr: import("ts-morph").Node = ref;
  let parent = expr.getParent();
  // Step through a PropertyAccessExpression when the ref is its name (e.g.
  // `this.flag` or `obj.flag`) — findReferencesAsNodes has already narrowed
  // us to the right declaration, so the PropertyAccess is semantically the
  // same symbol reference as a bare identifier.
  if (parent?.isKind(SyntaxKind.PropertyAccessExpression)) {
    const pa = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pa.getNameNode() === ref) {
      expr = parent;
      parent = parent.getParent();
    }
  }
  // Capture the exact text of this reference (bare identifier OR wrapping
  // property-access). evalBool will substitute occurrences that match this
  // text, so `this.flag` won't incorrectly fold an unrelated `other.flag`.
  const matchText = expr.getText();
  while (parent) {
    if (parent.isKind(SyntaxKind.ParenthesizedExpression)) {
      expr = parent;
      parent = parent.getParent();
      continue;
    }
    if (parent.isKind(SyntaxKind.PrefixUnaryExpression)) {
      const pu = parent.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
      if (pu.getOperatorToken() === SyntaxKind.ExclamationToken) {
        expr = parent;
        parent = parent.getParent();
        continue;
      }
    }
    if (parent.isKind(SyntaxKind.BinaryExpression)) {
      const be = parent.asKindOrThrow(SyntaxKind.BinaryExpression);
      const opKind = be.getOperatorToken().getKind();
      if (
        opKind === SyntaxKind.AmpersandAmpersandToken ||
        opKind === SyntaxKind.BarBarToken
      ) {
        expr = parent;
        parent = parent.getParent();
        continue;
      }
    }
    break;
  }

  // `expr` is now the outermost boolean-composable expression. Its parent
  // should be an IfStatement, ConditionalExpression, or (for `&&` / `||`
  // used as a statement) an ExpressionStatement.
  const hostParent = expr.getParent();
  if (!hostParent)
    return { folded: false, outcome: "unknown", action: "no parent" };

  // Evaluate the expression with the symbol substituted.
  const outcome = evalBool(expr, matchText, value);

  if (hostParent.isKind(SyntaxKind.IfStatement)) {
    const ifStmt = hostParent.asKindOrThrow(SyntaxKind.IfStatement);
    if (ifStmt.getExpression() !== expr) {
      return { folded: false, outcome, action: `in if-body, not condition` };
    }
    if (outcome === "unknown")
      return {
        folded: false,
        outcome,
        action: `if condition not fully determined`,
      };
    return foldIfStatement(ifStmt, outcome === "true");
  }

  if (hostParent.isKind(SyntaxKind.ConditionalExpression)) {
    const cond = hostParent.asKindOrThrow(SyntaxKind.ConditionalExpression);
    if (cond.getCondition() !== expr) {
      return {
        folded: false,
        outcome,
        action: `in ternary branch, not condition`,
      };
    }
    if (outcome === "unknown")
      return {
        folded: false,
        outcome,
        action: `ternary condition not fully determined`,
      };
    const taken = outcome === "true" ? cond.getWhenTrue() : cond.getWhenFalse();
    const text = taken.getText();
    cond.replaceWithText(text);
    return { folded: true, outcome, action: `ternary → ${truncate(text, 40)}` };
  }

  // `flag && doX()` / `flag || doX()` used as a statement.
  if (
    hostParent.isKind(SyntaxKind.ExpressionStatement) &&
    expr.isKind(SyntaxKind.BinaryExpression)
  ) {
    const be = expr.asKindOrThrow(SyntaxKind.BinaryExpression);
    const opKind = be.getOperatorToken().getKind();
    if (outcome === "unknown") {
      return {
        folded: false,
        outcome,
        action: `short-circuit statement not determined`,
      };
    }
    const stmt = hostParent.asKindOrThrow(SyntaxKind.ExpressionStatement);
    if (opKind === SyntaxKind.AmpersandAmpersandToken) {
      if (outcome === "false") {
        stmt.remove();
        return { folded: true, outcome, action: `&& statement removed` };
      }
      // outcome "true": replace with right operand as a statement.
      const rightText = be.getRight().getText();
      stmt.replaceWithText(`${rightText};`);
      return { folded: true, outcome, action: `&& statement → right operand` };
    }
    if (opKind === SyntaxKind.BarBarToken) {
      if (outcome === "true") {
        stmt.remove();
        return { folded: true, outcome, action: `|| statement removed` };
      }
      const rightText = be.getRight().getText();
      stmt.replaceWithText(`${rightText};`);
      return { folded: true, outcome, action: `|| statement → right operand` };
    }
  }

  return {
    folded: false,
    outcome,
    action: `parent kind ${hostParent.getKindName()}`,
  };
}

/** Recursive boolean evaluator. Substitutes nodes whose exact text equals
 *  `matchText` with `value`; returns "unknown" for anything else. The text
 *  is whatever the caller captured from the reference (`flag`, `this.flag`,
 *  `obj.flag`, etc.) so unrelated same-named fields on other objects
 *  (`other.flag`) stay "unknown". */
function evalBool(
  node: import("ts-morph").Node,
  matchText: string,
  value: boolean,
): BoolEval {
  if (node.getText() === matchText) {
    if (
      node.isKind(SyntaxKind.Identifier) ||
      node.isKind(SyntaxKind.PropertyAccessExpression)
    ) {
      return value ? "true" : "false";
    }
  }
  if (node.isKind(SyntaxKind.TrueKeyword)) return "true";
  if (node.isKind(SyntaxKind.FalseKeyword)) return "false";
  if (node.isKind(SyntaxKind.ParenthesizedExpression)) {
    return evalBool(
      node.asKindOrThrow(SyntaxKind.ParenthesizedExpression).getExpression(),
      matchText,
      value,
    );
  }
  if (node.isKind(SyntaxKind.PrefixUnaryExpression)) {
    const pu = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
    if (pu.getOperatorToken() === SyntaxKind.ExclamationToken) {
      const inner = evalBool(pu.getOperand(), matchText, value);
      if (inner === "true") return "false";
      if (inner === "false") return "true";
    }
    return "unknown";
  }
  if (node.isKind(SyntaxKind.BinaryExpression)) {
    const be = node.asKindOrThrow(SyntaxKind.BinaryExpression);
    const opKind = be.getOperatorToken().getKind();
    if (opKind === SyntaxKind.AmpersandAmpersandToken) {
      const l = evalBool(be.getLeft(), matchText, value);
      if (l === "false") return "false";
      const r = evalBool(be.getRight(), matchText, value);
      if (r === "false") return "false";
      if (l === "true" && r === "true") return "true";
      return "unknown";
    }
    if (opKind === SyntaxKind.BarBarToken) {
      const l = evalBool(be.getLeft(), matchText, value);
      if (l === "true") return "true";
      const r = evalBool(be.getRight(), matchText, value);
      if (r === "true") return "true";
      if (l === "false" && r === "false") return "false";
      return "unknown";
    }
  }
  return "unknown";
}

/** Replace an IfStatement with its taken branch (then or else). Unwraps
 *  single-layer Block statements when the replacement sits inside another
 *  Block — produces cleaner output than leaving bare block scopes behind. */
function foldIfStatement(
  ifStmt: import("ts-morph").IfStatement,
  takeTrue: boolean,
): FoldResult {
  const outcome: BoolEval = takeTrue ? "true" : "false";
  const branch = takeTrue
    ? ifStmt.getThenStatement()
    : ifStmt.getElseStatement();

  if (!branch) {
    // false-branch absent: e.g. `if (flag) { ... }` with flag=false → remove stmt.
    ifStmt.remove();
    return { folded: true, outcome, action: `if-statement removed` };
  }

  const parentBlock = ifStmt.getParent();
  const replacementText = branch.isKind(SyntaxKind.Block)
    ? stripOuterBraces(branch.getText())
    : branch.getText();

  // If parent is a Block/SourceFile/ModuleBlock, we can splice multiple
  // statements in. Otherwise (e.g. nested in another IfStatement's else
  // without braces), keep the block form to stay syntactically valid.
  const canSplice =
    parentBlock?.isKind(SyntaxKind.Block) ||
    parentBlock?.isKind(SyntaxKind.SourceFile) ||
    parentBlock?.isKind(SyntaxKind.ModuleBlock) ||
    parentBlock?.isKind(SyntaxKind.CaseClause) ||
    parentBlock?.isKind(SyntaxKind.DefaultClause);

  if (canSplice && branch.isKind(SyntaxKind.Block)) {
    ifStmt.replaceWithText(
      replacementText.trim().length === 0 ? "" : replacementText,
    );
  } else {
    ifStmt.replaceWithText(branch.getText());
  }
  return {
    folded: true,
    outcome,
    action: `if-statement → ${takeTrue ? "then" : "else"}-branch`,
  };
}

/** Strip `{` / `}` from a Block's text and dedent one level so the result
 *  can be spliced into the parent without trailing whitespace-only lines or
 *  an extra indent level. Empty blocks collapse to an empty string. */
function stripOuterBraces(blockText: string): string {
  const trimmed = blockText.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return blockText;
  const inner = trimmed.slice(1, -1);
  const lines = inner.split("\n");
  // Drop purely-blank leading and trailing lines.
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "")
    lines.pop();
  if (lines.length === 0) return "";
  // Dedent by the smallest non-empty-line indent.
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent < minIndent) minIndent = indent;
  }
  const dedent = Number.isFinite(minIndent) ? minIndent : 0;
  return lines
    .map((line) => line.slice(Math.min(dedent, line.length)))
    .join("\n");
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

function renameSymbol(file: string, name: string, newName: string): void {
  const project = createProject();
  addAllSources(project);

  const sourceFile = project.getSourceFileOrThrow(resolve(file));

  // Find the declaration identifier
  const decl = findDeclarationIdentifier(sourceFile, name);
  if (!decl) {
    console.error(`❌ Symbol "${name}" not found in ${file}`);
    process.exit(1);
  }

  console.log(`Renaming "${name}" → "${newName}" from ${file}`);

  // ts-morph rename updates all references across the project
  decl.rename(newName);

  // Fix shorthand properties broken by the rename.
  // e.g. `{ rs }` → `{ runtimeState }` but local var is still `rs`,
  // so we need `{ runtimeState: rs }`.
  fixBrokenShorthands(project, name, newName);

  const localsRenamed = cascadeFlag
    ? renameCoincidentLocals(project, name, newName)
    : 0;

  const changedFiles = saveChanges(project);
  console.log(`✅ Renamed across ${changedFiles} file(s)`);
  if (cascadeFlag && localsRenamed > 0) {
    console.log(`  Cascade: renamed ${localsRenamed} coincident local(s)`);
  }
  const remaining = reportTextualReferences(name);
  if (cascadeFlag && remaining === 0) {
    console.log(`✅ Cascade clean: no textual references to "${name}" remain`);
  }
}

function moveExport(fromPath: string, toPath: string, name: string): void {
  const project = createProject();
  addAllSources(project);

  let fromFile: SourceFile;
  try {
    fromFile = project.getSourceFileOrThrow(resolve(fromPath));
  } catch {
    console.error(`❌ Source file not found: ${fromPath}`);
    console.error(
      `   If "${fromPath}" is a symbol name, use: move-export --from <file> --to <file> --symbol ${fromPath}`,
    );
    process.exit(1);
  }
  const toFile = getOrCreateSourceFile(project, resolve(toPath));

  // Find the exported declaration
  const declarations = fromFile.getExportedDeclarations().get(name);
  if (!declarations || declarations.length === 0) {
    console.error(`❌ Export "${name}" not found in ${fromPath}`);
    process.exit(1);
  }

  console.log(`Moving "${name}" from ${fromPath} → ${toPath}`);

  const decl = declarations[0]!;

  // Detect re-exports: the actual declaration lives in a different file
  const declSourceFile = decl.getSourceFile();
  if (declSourceFile.getFilePath() !== fromFile.getFilePath()) {
    const canonicalPath = path.relative(
      process.cwd(),
      declSourceFile.getFilePath(),
    );
    console.error(
      `❌ "${name}" in ${fromPath} is a re-export from ${canonicalPath}`,
    );
    console.error(
      `   Move it from the canonical source instead: move-export --from ${canonicalPath} --to ${toPath} --symbol ${name}`,
    );
    process.exit(1);
  }

  // Get the full text including JSDoc and export keyword
  const fullText = getDeclarationFullText(decl);

  // Collect imports that the moved declaration needs
  const neededImports = collectDeclImports(decl, fromFile);

  // Remove from source file
  removeDeclaration(decl);

  // Add to target file
  toFile.addStatements(`\n${fullText}\n`);

  // Remove dummy export if we seeded one for an empty file
  removeDummyExport(toFile);

  // Add needed imports to target file
  addImportsToFile(toFile, neededImports, fromFile);

  // Rewrite imports across the project: files that imported `name` from
  // `fromFile` should now import it from `toFile`
  rewriteImports(project, fromFile, toFile, name);

  // If fromFile still references the moved symbol (e.g. calls it), add an
  // import pointing at the new location.
  addBackImportIfStillUsed(fromFile, toFile, name);

  // If toFile already imported `name` from fromFile, remove that import
  cleanSelfImport(toFile, name);

  const changedFiles = saveChanges(project);
  console.log(`✅ Moved "${name}" — ${changedFiles} file(s) changed`);
}

/** Get an existing source file or create it if it doesn't exist / has no
 *  statements (empty OR comment-only). Works around ts-morph's addStatements
 *  bug on files without any statements by seeding a dummy `export {};` via
 *  raw text insertion (preserves any leading comments) — the dummy is removed
 *  later by `removeDummyExport` after real content is added. */
function getOrCreateSourceFile(project: Project, filePath: string): SourceFile {
  const existing = project.getSourceFile(filePath);
  if (existing && existing.getStatements().length > 0) return existing;

  const sf =
    existing ?? project.createSourceFile(filePath, "", { overwrite: true });
  const text = sf.getFullText();
  const prefix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  sf.insertText(text.length, `${prefix}export {};\n`);
  return sf;
}

function renameProp(typeName: string, prop: string, newProp: string): void {
  const project = createProject();
  addAllSources(project);

  let found = false;

  for (const sf of project.getSourceFiles()) {
    // Check interfaces
    for (const iface of sf.getInterfaces()) {
      if (iface.getName() === typeName) {
        const member = iface.getProperty(prop);
        if (member) {
          console.log(
            `Renaming ${typeName}.${prop} → ${newProp} (defined in ${sf.getFilePath()})`,
          );
          member.rename(newProp);
          found = true;
        }
      }
    }

    // Check type aliases with object literal types (including intersection members)
    for (const alias of sf.getTypeAliases()) {
      if (alias.getName() === typeName) {
        const typeNode = alias.getTypeNode();
        if (!typeNode) continue;

        const literals: import("ts-morph").TypeLiteralNode[] = [];
        if (typeNode.isKind(SyntaxKind.TypeLiteral)) {
          literals.push(typeNode);
        } else if (typeNode.isKind(SyntaxKind.IntersectionType)) {
          for (const member of typeNode.getTypeNodes()) {
            if (member.isKind(SyntaxKind.TypeLiteral)) {
              literals.push(member);
            }
          }
        }

        for (const lit of literals) {
          const member = lit.getProperty(prop);
          if (member) {
            console.log(
              `Renaming ${typeName}.${prop} → ${newProp} (defined in ${sf.getFilePath()})`,
            );
            member.rename(newProp);
            found = true;
          }
        }
      }
    }
  }

  if (!found) {
    console.error(`❌ Property "${prop}" not found on type "${typeName}"`);
    process.exit(1);
  }

  const localsRenamed = cascadeFlag
    ? renameCoincidentLocals(project, prop, newProp)
    : 0;

  const changedFiles = saveChanges(project);
  console.log(`✅ Renamed property across ${changedFiles} file(s)`);
  if (cascadeFlag && localsRenamed > 0) {
    console.log(`  Cascade: renamed ${localsRenamed} coincident local(s)`);
  }
  const remaining = reportTextualReferences(prop);
  if (cascadeFlag && remaining === 0) {
    console.log(`✅ Cascade clean: no textual references to "${prop}" remain`);
  }
}

/**
 * After a rename, scan all modified files for shorthand properties that now
 * reference a non-existent local variable (`{ newName }` where only `oldName`
 * exists in scope). Converts them to `{ newName: oldName }`.
 */
function fixBrokenShorthands(
  project: Project,
  oldName: string,
  newName: string,
): void {
  for (const sf of project.getSourceFiles()) {
    if (sf.isSaved()) continue; // unchanged file

    let madeChanges = false;
    // Iterate shorthand property assignments that match the new name
    for (const node of sf.getDescendantsOfKind(
      SyntaxKind.ShorthandPropertyAssignment,
    )) {
      if (node.getName() !== newName) continue;

      // Check if `newName` resolves to a local variable in this scope.
      // If it doesn't (the symbol is the interface property, not a local),
      // then we need to expand the shorthand.
      const nameNode = node.getNameNode();
      const symbol = nameNode.getSymbol();

      // If the symbol's declaration is an interface property (not a local var),
      // the shorthand is broken — the local var still has the old name.
      const decls = symbol?.getDeclarations() ?? [];
      const isLocalVar = decls.some(
        (d) =>
          d.isKind(SyntaxKind.VariableDeclaration) ||
          d.isKind(SyntaxKind.Parameter) ||
          d.isKind(SyntaxKind.BindingElement),
      );

      if (!isLocalVar) {
        // Replace shorthand `newName` with `newName: oldName`
        // ts-morph doesn't have a direct API, so we do a text replacement
        const start = node.getStart();
        const end = node.getEnd();
        const trailingComma = sf.getFullText()[end] === "," ? "," : "";

        sf.replaceText(
          [start, end + (trailingComma ? 1 : 0)],
          `${newName}: ${oldName}${trailingComma}`,
        );
        madeChanges = true;

        console.log(
          `  Fixed shorthand: ${newName} → ${newName}: ${oldName} in ${path.relative(process.cwd(), sf.getFilePath())}`,
        );
        // After text replacement, node positions shift — restart scan on this file
        break;
      }
    }

    // If we made changes, re-scan (positions shifted)
    if (madeChanges) {
      // Recursively fix any remaining broken shorthands in this file
      // (unlikely to have more than one, but handle it)
      fixBrokenShorthands(project, oldName, newName);
      return;
    }
  }
}

/** Remove the `export {};` dummy statement seeded by getOrCreateSourceFile. */
function removeDummyExport(sf: SourceFile): void {
  for (const stmt of sf.getStatements()) {
    if (stmt.isKind(SyntaxKind.ExportDeclaration)) {
      const exportDecl = stmt.asKindOrThrow(SyntaxKind.ExportDeclaration);
      if (
        !exportDecl.getModuleSpecifier() &&
        exportDecl.getNamedExports().length === 0
      ) {
        stmt.remove();
        return;
      }
    }
  }
}

function findDeclarationIdentifier(
  sf: SourceFile,
  name: string,
): Identifier | undefined {
  // Search exported declarations first
  const exported = sf.getExportedDeclarations().get(name);
  if (exported && exported.length > 0) {
    const node = exported[0]!;
    // Get the name identifier from the declaration
    if ("getName" in node && typeof node.getName === "function") {
      const nameNode = (
        node as { getNameNode?: () => Identifier }
      ).getNameNode?.();
      if (nameNode) return nameNode;
    }
  }

  // Fallback: find first matching identifier that is a definition
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() === name) {
      const defs = id.getDefinitions();
      if (defs.length > 0) return id;
    }
  }

  return undefined;
}

function getDeclarationFullText(decl: ExportedDeclarations): string {
  // Walk up to the statement level to include export keyword, JSDoc, etc.
  let node = decl.asKind(SyntaxKind.VariableDeclaration)
    ? decl.getFirstAncestorByKind(SyntaxKind.VariableStatement)
    : decl;

  if (!node) node = decl;
  return node.getFullText().trim();
}

function collectDeclImports(
  decl: ExportedDeclarations,
  sourceFile: SourceFile,
): ImportInfo[] {
  // Find all identifiers used in the declaration
  const usedNames = new Set<string>();
  for (const id of decl.getDescendantsOfKind(SyntaxKind.Identifier)) {
    usedNames.add(id.getText());
  }

  const result: ImportInfo[] = [];

  for (const imp of sourceFile.getImportDeclarations()) {
    const moduleSpec = imp.getModuleSpecifierValue();
    const matchingImports: string[] = [];
    const isTypeOnly = imp.isTypeOnly();

    for (const named of imp.getNamedImports()) {
      const importName = named.getAliasNode()?.getText() ?? named.getName();
      if (usedNames.has(importName)) {
        matchingImports.push(named.getText()); // preserves "type X" and aliases
      }
    }

    if (matchingImports.length > 0) {
      result.push({
        moduleSpecifier: moduleSpec,
        namedImports: matchingImports,
        isTypeOnly,
      });
    }
  }

  return result;
}

function addImportsToFile(
  targetFile: SourceFile,
  imports: ImportInfo[],
  _fromFile: SourceFile,
): void {
  const targetPath = targetFile.getFilePath();
  for (const imp of imports) {
    // Skip self-imports: if the module resolves to the target file itself,
    // the symbols are already local — no import needed.
    const resolved = targetFile
      .getProject()
      .getSourceFile(
        path.resolve(
          path.dirname(targetFile.getFilePath()),
          imp.moduleSpecifier.replace(/\.ts$/, "") + ".ts",
        ),
      );
    if (resolved?.getFilePath() === targetPath) continue;

    // Check if target already has an import from this module
    const existing = targetFile
      .getImportDeclarations()
      .find((d) => d.getModuleSpecifierValue() === imp.moduleSpecifier);

    if (existing) {
      // Add missing named imports
      const existingNames = new Set(
        existing.getNamedImports().map((n) => n.getText()),
      );
      for (const name of imp.namedImports) {
        if (!existingNames.has(name)) {
          existing.addNamedImport(name);
        }
      }
    } else {
      targetFile.addImportDeclaration({
        moduleSpecifier: imp.moduleSpecifier,
        namedImports: imp.namedImports,
        isTypeOnly: imp.isTypeOnly,
      });
    }
  }
}

function removeDeclaration(decl: ExportedDeclarations): void {
  // For variable declarations, remove the whole statement
  const varDecl = decl.asKind(SyntaxKind.VariableDeclaration);
  if (varDecl) {
    const statement = varDecl.getFirstAncestorByKind(
      SyntaxKind.VariableStatement,
    );
    if (statement) {
      const varDeclList = statement.getDeclarationList();
      if (varDeclList.getDeclarations().length === 1) {
        statement.remove();
      } else {
        varDecl.remove();
      }
      return;
    }
  }

  // For other declarations (function, interface, type, enum, class)
  if ("remove" in decl && typeof decl.remove === "function") {
    (decl as { remove: () => void }).remove();
  }
}

function rewriteImports(
  project: Project,
  fromFile: SourceFile,
  toFile: SourceFile,
  symbolName: string,
): void {
  const fromPath = fromFile.getFilePath();

  for (const sf of project.getSourceFiles()) {
    if (sf === toFile) continue;

    for (const imp of sf.getImportDeclarations()) {
      const resolvedModule = imp.getModuleSpecifierSourceFile();
      if (resolvedModule?.getFilePath() !== fromPath) continue;

      const namedImport = findNamedImport(imp, symbolName);
      if (!namedImport) continue;

      // Preserve type-only status
      const isTypeImport = namedImport.isTypeOnly() || imp.isTypeOnly();
      const importText = namedImport.getText();

      // Remove from old import
      namedImport.remove();

      // Clean up empty import declarations
      if (
        imp.getNamedImports().length === 0 &&
        !imp.getDefaultImport() &&
        !imp.getNamespaceImport()
      ) {
        imp.remove();
      }

      // Add to new import from toFile
      // Append .ts extension — this project uses explicit .ts imports everywhere.
      const rawSpec = sf.getRelativePathAsModuleSpecifierTo(toFile);
      const newModuleSpec = rawSpec.endsWith(".ts") ? rawSpec : rawSpec + ".ts";
      const existingToImport = sf
        .getImportDeclarations()
        .find(
          (d) =>
            d.getModuleSpecifierSourceFile()?.getFilePath() ===
            toFile.getFilePath(),
        );

      if (existingToImport) {
        const alreadyImported = existingToImport
          .getNamedImports()
          .some((n) => n.getName() === symbolName);
        if (!alreadyImported) {
          const existingIsTypeOnly = existingToImport.isTypeOnly();
          if (existingIsTypeOnly && !isTypeImport) {
            // Can't add a value import to an `import type` declaration —
            // create a separate value import instead.
            sf.addImportDeclaration({
              moduleSpecifier: newModuleSpec,
              namedImports: [importText],
              isTypeOnly: false,
            });
          } else {
            // Strip redundant `type ` prefix when adding to an `import type` declaration
            // (the declaration-level `type` already covers it).
            const cleanText = existingIsTypeOnly
              ? importText.replace(/^type\s+/, "")
              : importText;
            existingToImport.addNamedImport(cleanText);
          }
        }
      } else {
        // Strip redundant `type ` prefix from named import text when the new
        // declaration itself is `import type` (otherwise TS2206).
        const cleanText = isTypeImport
          ? importText.replace(/^type\s+/, "")
          : importText;
        sf.addImportDeclaration({
          moduleSpecifier: newModuleSpec,
          namedImports: [cleanText],
          isTypeOnly: isTypeImport,
        });
      }
    }
  }
}

/** If fromFile still references `symbolName` after removing its declaration,
 *  add an import from toFile so the source file compiles. */
function addBackImportIfStillUsed(
  fromFile: SourceFile,
  toFile: SourceFile,
  symbolName: string,
): void {
  const stillUsed = fromFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((id) => {
      if (id.getText() !== symbolName) return false;
      // Exclude property-access names (obj.foo) — those don't need an import
      const parent = id.getParentIfKind(SyntaxKind.PropertyAccessExpression);
      if (parent && parent.getNameNode() === id) return false;
      return true;
    });
  if (!stillUsed) return;

  const rawSpec = fromFile.getRelativePathAsModuleSpecifierTo(toFile);
  const moduleSpec = rawSpec.endsWith(".ts") ? rawSpec : rawSpec + ".ts";

  // Merge into existing import from toFile if present
  const existing = fromFile
    .getImportDeclarations()
    .find(
      (d) =>
        d.getModuleSpecifierSourceFile()?.getFilePath() ===
        toFile.getFilePath(),
    );
  if (existing) {
    const alreadyImported = existing
      .getNamedImports()
      .some((n) => n.getName() === symbolName);
    if (!alreadyImported) existing.addNamedImport(symbolName);
  } else {
    fromFile.addImportDeclaration({
      moduleSpecifier: moduleSpec,
      namedImports: [symbolName],
    });
  }
}

function cleanSelfImport(file: SourceFile, symbolName: string): void {
  for (const imp of file.getImportDeclarations()) {
    const resolvedModule = imp.getModuleSpecifierSourceFile();
    if (resolvedModule?.getFilePath() === file.getFilePath()) {
      const named = findNamedImport(imp, symbolName);
      if (named) named.remove();
      if (
        imp.getNamedImports().length === 0 &&
        !imp.getDefaultImport() &&
        !imp.getNamespaceImport()
      ) {
        imp.remove();
      }
    }
  }
}

function renameInFile(name: string, newName: string, files: string[]): void {
  const project = createProject();
  addAllSources(project);

  let totalDecls = 0;

  for (const file of files) {
    const sf = project.getSourceFileOrThrow(resolve(file));
    let declCount = 0;

    // Iteratively find and rename each declaration of `name` in this file.
    // After each rename, identifiers shift, so we re-scan from scratch.
    while (true) {
      const id = findNextDeclarationIdentifier(sf, name);
      if (!id) break;
      id.rename(newName);
      declCount++;
    }

    if (declCount > 0) {
      console.log(`  ${file}: renamed ${declCount} declaration(s)`);
      totalDecls += declCount;
    } else {
      console.warn(`  ${file}: no declarations of "${name}" found`);
    }
  }

  if (totalDecls === 0) {
    console.error(
      `❌ No declarations of "${name}" found in any of the specified files`,
    );
    process.exit(1);
  }

  // ts-morph handles shorthand expansion during individual renames. When both
  // property and local are renamed, the result is `{ newName: newName }`.
  // Collapse those back to shorthand `{ newName }`.
  collapseRedundantPropertyAssignments(project, newName);

  const localsRenamed = cascadeFlag
    ? renameCoincidentLocals(project, name, newName)
    : 0;

  const changedFiles = saveChanges(project);
  console.log(
    `✅ Renamed ${totalDecls} declaration(s) across ${changedFiles} file(s)`,
  );
  if (cascadeFlag && localsRenamed > 0) {
    console.log(`  Cascade: renamed ${localsRenamed} coincident local(s)`);
  }
  const remaining = reportTextualReferences(name);
  if (cascadeFlag && remaining === 0) {
    console.log(`✅ Cascade clean: no textual references to "${name}" remain`);
  }
}

/**
 * Collapse `{ name: name }` → `{ name }` (shorthand) when both sides are the
 * same identifier. This happens when rename-in-file renames both a property
 * and its local variable to the same new name.
 */
function collapseRedundantPropertyAssignments(
  project: Project,
  name: string,
): void {
  for (const sf of project.getSourceFiles()) {
    let madeChanges = false;
    for (const node of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (node.getName() !== name) continue;
      const init = node.getInitializer();
      if (init?.isKind(SyntaxKind.Identifier) && init.getText() === name) {
        const start = node.getStart();
        const end = node.getEnd();
        const trailingComma = sf.getFullText()[end] === "," ? "," : "";
        sf.replaceText(
          [start, end + (trailingComma ? 1 : 0)],
          `${name}${trailingComma}`,
        );
        madeChanges = true;
        console.log(
          `  Collapsed ${name}: ${name} → ${name} in ${path.relative(process.cwd(), sf.getFilePath())}`,
        );
        break;
      }
    }
    if (madeChanges) {
      collapseRedundantPropertyAssignments(project, name);
      return;
    }
  }
}

/**
 * After an AST rename, ripgrep for the old name across the project and print
 * any remaining matches. These are either comment/string/doc references (which
 * the AST rename cannot touch) or companion identifiers that embed the old
 * name as a subword (e.g. `buildHomeTowersByIndex` after renaming `homeTowers`).
 * Surfacing them turns "I need to manually search" into a visible checklist.
 *
 * Runs two scans: the exact name with word boundaries, plus the PascalCase
 * variant (if the name starts lowercase) as a bare substring to catch
 * compound identifiers. Hits are deduped by `file:line`.
 *
 * Returns the number of remaining hits so callers can emit a "clean" signal
 * when cascade mode fully resolved the rename.
 */
function reportTextualReferences(oldName: string): number {
  if (dryRun) return 0;
  const searchRoots = ["src", "server", "test", "docs"].filter((root) =>
    existsSync(root),
  );
  if (searchRoots.length === 0) return 0;

  const exact = runRipgrep([
    "--fixed-strings",
    "--word-regexp",
    oldName,
    ...searchRoots,
  ]);
  if (exact === null) return 0;

  const pascal = pascalVariant(oldName);
  const compound =
    pascal && pascal !== oldName
      ? (runRipgrep(["--fixed-strings", pascal, ...searchRoots]) ?? [])
      : [];

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const line of [...exact, ...compound]) {
    const key = line.split(":").slice(0, 2).join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }

  if (merged.length === 0) return 0;

  const label =
    pascal && pascal !== oldName
      ? `"${oldName}" or "${pascal}"`
      : `"${oldName}"`;
  console.log(
    `\n⚠️  ${merged.length} textual reference(s) to ${label} remain (comments, strings, docs, or compound identifiers — not touched by AST rename):`,
  );
  for (const line of merged) {
    console.log(`  ${line}`);
  }
  console.log(
    `  Review and update manually if they still refer to the renamed symbol.`,
  );
  return merged.length;
}

function runRipgrep(rgArgs: readonly string[]): string[] | null {
  const result = spawnSync(
    "rg",
    [
      "--line-number",
      "--no-heading",
      "--with-filename",
      "--color",
      "never",
      ...rgArgs,
    ],
    { encoding: "utf8" },
  );
  if (result.status === 1) return [];
  if (result.status !== 0) {
    console.warn(
      `  ⚠️  Post-rename textual check skipped: ${result.stderr?.trim() || "rg unavailable"}`,
    );
    return null;
  }
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

function pascalVariant(name: string): string | null {
  const first = name.charAt(0);
  if (first < "a" || first > "z") return null;
  return first.toUpperCase() + name.slice(1);
}

/**
 * After a prop/symbol rename, find locals that still carry the old name but
 * whose initializer now reads the new property (because the AST rename already
 * rewrote the RHS). Pattern:
 *
 *     const homeTowers = overlay.entities?.ownedTowers;
 *        // ^^^^^^^^^^ local kept old name           ^^^^^^^^^^^ already renamed
 *
 * Renames each such local to the new name. Other same-name locals (parameters,
 * unrelated variables) are left alone — too risky to rename without a clear
 * data-flow signal that they refer to the renamed symbol.
 */
function renameCoincidentLocals(
  project: Project,
  oldName: string,
  newName: string,
): number {
  let count = 0;
  for (const sf of project.getSourceFiles()) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const decl of sf.getDescendantsOfKind(
        SyntaxKind.VariableDeclaration,
      )) {
        const nameNode = decl.getNameNode();
        if (!nameNode.isKind(SyntaxKind.Identifier)) continue;
        if (nameNode.getText() !== oldName) continue;

        const init = decl.getInitializer();
        if (!init) continue;
        const finalName = getTrailingAccessName(init);
        if (finalName !== newName) continue;

        nameNode.rename(newName);
        count++;
        changed = true;
        console.log(
          `  Renamed coincident local ${oldName} → ${newName} in ${path.relative(process.cwd(), sf.getFilePath())}`,
        );
        break;
      }
    }
  }
  return count;
}

function getTrailingAccessName(node: import("ts-morph").Node): string | null {
  if (node.isKind(SyntaxKind.PropertyAccessExpression)) return node.getName();
  if (node.isKind(SyntaxKind.ElementAccessExpression)) {
    const arg = node.getArgumentExpression();
    if (arg?.isKind(SyntaxKind.StringLiteral)) return arg.getLiteralText();
  }
  return null;
}

/**
 * Find the next identifier named `name` that is a declaration (parameter,
 * variable, property signature, binding element) in the given source file.
 */
function findNextDeclarationIdentifier(
  sf: SourceFile,
  name: string,
): Identifier | undefined {
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== name) continue;

    const parent = id.getParent();
    if (!parent) continue;

    // Is this identifier the name of a declaration?
    const parentKind = parent.getKind();
    if (
      parentKind === SyntaxKind.Parameter ||
      parentKind === SyntaxKind.VariableDeclaration ||
      parentKind === SyntaxKind.PropertySignature ||
      parentKind === SyntaxKind.PropertyDeclaration ||
      parentKind === SyntaxKind.BindingElement ||
      parentKind === SyntaxKind.FunctionDeclaration ||
      parentKind === SyntaxKind.MethodDeclaration ||
      parentKind === SyntaxKind.PropertyAssignment
    ) {
      // Verify this identifier is the "name" of the parent, not a type ref or initializer
      if (
        "getName" in parent &&
        typeof parent.getName === "function" &&
        parent.getName() === name
      ) {
        return id;
      }
    }
  }
  return undefined;
}

function findSymbol(name: string): void {
  const project = createProject();
  addAllSources(project);

  const results: {
    file: string;
    line: number;
    kind: string;
    exported: boolean;
  }[] = [];

  for (const sf of project.getSourceFiles()) {
    const relPath = path.relative(process.cwd(), sf.getFilePath());

    // Check exported declarations
    const exported = sf.getExportedDeclarations().get(name);
    if (exported) {
      for (const decl of exported) {
        results.push({
          file: relPath,
          line: decl.getStartLineNumber(),
          kind: decl.getKindName(),
          exported: true,
        });
      }
    }

    // Check non-exported top-level declarations (functions, variables, interfaces, types, enums)
    for (const fn of sf.getFunctions()) {
      if (fn.getName() === name && !fn.isExported()) {
        results.push({
          file: relPath,
          line: fn.getStartLineNumber(),
          kind: "FunctionDeclaration",
          exported: false,
        });
      }
    }
    for (const vs of sf.getVariableStatements()) {
      if (vs.isExported()) continue;
      for (const vd of vs.getDeclarations()) {
        if (vd.getName() === name) {
          results.push({
            file: relPath,
            line: vd.getStartLineNumber(),
            kind: "VariableDeclaration",
            exported: false,
          });
        }
      }
    }
    for (const iface of sf.getInterfaces()) {
      if (iface.getName() === name && !iface.isExported()) {
        results.push({
          file: relPath,
          line: iface.getStartLineNumber(),
          kind: "InterfaceDeclaration",
          exported: false,
        });
      }
    }
    for (const alias of sf.getTypeAliases()) {
      if (alias.getName() === name && !alias.isExported()) {
        results.push({
          file: relPath,
          line: alias.getStartLineNumber(),
          kind: "TypeAliasDeclaration",
          exported: false,
        });
      }
    }
    for (const en of sf.getEnums()) {
      if (en.getName() === name && !en.isExported()) {
        results.push({
          file: relPath,
          line: en.getStartLineNumber(),
          kind: "EnumDeclaration",
          exported: false,
        });
      }
    }

    // Check interface/type alias properties
    for (const iface of sf.getInterfaces()) {
      const prop = iface.getProperty(name);
      if (prop) {
        results.push({
          file: relPath,
          line: prop.getStartLineNumber(),
          kind: `${iface.getName()}.PropertySignature`,
          exported: iface.isExported(),
        });
      }
    }
    for (const alias of sf.getTypeAliases()) {
      const typeNode = alias.getTypeNode();
      if (!typeNode) continue;
      const literals: import("ts-morph").TypeLiteralNode[] = [];
      if (typeNode.isKind(SyntaxKind.TypeLiteral)) {
        literals.push(typeNode);
      } else if (typeNode.isKind(SyntaxKind.IntersectionType)) {
        for (const member of typeNode.getTypeNodes()) {
          if (member.isKind(SyntaxKind.TypeLiteral)) literals.push(member);
        }
      }
      for (const lit of literals) {
        const prop = lit.getProperty(name);
        if (prop) {
          results.push({
            file: relPath,
            line: prop.getStartLineNumber(),
            kind: `${alias.getName()}.PropertySignature`,
            exported: alias.isExported(),
          });
        }
      }
    }

    // Check class members (methods, properties, abstract members)
    for (const cls of sf.getClasses()) {
      for (const member of cls.getMembers()) {
        if ("getName" in member && typeof member.getName === "function") {
          if (member.getName() === name) {
            results.push({
              file: relPath,
              line: member.getStartLineNumber(),
              kind: `${cls.getName()}.${member.getKindName()}`,
              exported: cls.isExported(),
            });
          }
        }
      }
    }
  }

  if (results.length === 0) {
    console.error(`❌ Symbol "${name}" not found in any project file`);
    process.exit(1);
  }

  // Deduplicate (exported search may overlap with top-level search)
  const seen = new Set<string>();
  const unique = results.filter((r) => {
    const key = `${r.file}:${r.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const r of unique) {
    const tag = r.exported ? "exported" : "private";
    console.log(`  ${r.file}:${r.line}  ${r.kind} (${tag})`);
  }
  console.log(`\nFound ${unique.length} declaration(s) of "${name}"`);
}

function listExports(filePath: string): void {
  const project = createProject();
  addAllSources(project);

  const sf = project.getSourceFileOrThrow(resolve(filePath));
  const exportedDecls = sf.getExportedDeclarations();

  if (exportedDecls.size === 0) {
    console.log(`No exports in ${filePath}`);
    return;
  }

  const entries: { name: string; kind: string; line: number }[] = [];

  for (const [name, decls] of exportedDecls) {
    for (const decl of decls) {
      entries.push({
        name,
        kind: simplifyKind(decl.getKindName()),
        line: decl.getStartLineNumber(),
      });
    }
  }

  // Sort by line number
  entries.sort((a, b) => a.line - b.line);

  for (const e of entries) {
    console.log(`  :${e.line}  ${e.kind.padEnd(12)} ${e.name}`);
  }
  console.log(`\n${entries.length} export(s) in ${filePath}`);
}

function simplifyKind(kind: string): string {
  const map: Record<string, string> = {
    FunctionDeclaration: "function",
    VariableDeclaration: "const",
    InterfaceDeclaration: "interface",
    TypeAliasDeclaration: "type",
    EnumDeclaration: "enum",
    ClassDeclaration: "class",
  };
  return map[kind] ?? kind;
}

function listReferences(filePath: string, symbolName: string): void {
  const project = createProject();
  addAllSources(project);

  const targetFile = project.getSourceFileOrThrow(resolve(filePath));
  const targetPath = targetFile.getFilePath();

  const importers: { file: string; line: number; typeOnly: boolean }[] = [];

  for (const sf of project.getSourceFiles()) {
    if (sf === targetFile) continue;

    for (const imp of sf.getImportDeclarations()) {
      const resolvedModule = imp.getModuleSpecifierSourceFile();
      if (resolvedModule?.getFilePath() !== targetPath) continue;

      const namedImport = findNamedImport(imp, symbolName);
      if (!namedImport) continue;

      importers.push({
        file: path.relative(process.cwd(), sf.getFilePath()),
        line: imp.getStartLineNumber(),
        typeOnly: namedImport.isTypeOnly() || imp.isTypeOnly(),
      });
    }
  }

  if (importers.length === 0) {
    console.log(`No files import "${symbolName}" from ${filePath}`);
    return;
  }

  importers.sort((a, b) => a.file.localeCompare(b.file));

  for (const r of importers) {
    const tag = r.typeOnly ? " (type-only)" : "";
    console.log(`  ${r.file}:${r.line}${tag}`);
  }
  console.log(
    `\n${importers.length} file(s) import "${symbolName}" from ${filePath}`,
  );
}

function renameFile(oldPath: string, newPath: string): void {
  const project = createProject();
  addAllSources(project);

  const absOld = resolve(oldPath);
  // If newPath is a bare filename (no directory separators), resolve relative
  // to the source file's directory — not CWD.
  const absNew =
    newPath.includes("/") || path.isAbsolute(newPath)
      ? resolve(newPath)
      : path.resolve(path.dirname(absOld), newPath);

  const sourceFile = project.getSourceFile(absOld);
  if (!sourceFile) {
    console.error(`❌ File not found: ${oldPath}`);
    process.exit(1);
  }

  // Check that target doesn't already exist
  if (project.getSourceFile(absNew)) {
    console.error(`❌ Target file already exists: ${newPath}`);
    process.exit(1);
  }

  const relNew = path.relative(process.cwd(), absNew);
  console.log(`Renaming ${oldPath} → ${relNew}`);

  // ts-morph's move() renames the file and updates all import specifiers
  sourceFile.move(absNew);

  // ts-morph may generate extensionless specifiers when it rewrites relative
  // paths — both for imports pointing to the moved file AND for the moved
  // file's own outgoing relative imports. Ensure all such specifiers end with
  // .ts (project convention).
  for (const sf of project.getSourceFiles()) {
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target) continue;
      const isToMoved = target.getFilePath() === absNew;
      const isFromMoved = sf.getFilePath() === absNew;
      if (!isToMoved && !isFromMoved) continue;
      const spec = imp.getModuleSpecifierValue();
      if (!spec.endsWith(".ts") && spec.startsWith(".")) {
        imp.setModuleSpecifier(spec + ".ts");
      }
    }
  }

  const changedFiles = saveChanges(project);

  // ts-morph's move() creates the new file but doesn't delete the old one on disk.
  if (!dryRun && existsSync(absOld)) {
    unlinkSync(absOld);
  }

  console.log(`✅ Renamed file — ${changedFiles} file(s) changed`);
}

function mergeImports(files: string[]): void {
  const project = createProject();
  if (files.length === 0) {
    addAllSources(project);
  } else {
    for (const file of files) {
      project.addSourceFileAtPath(resolve(file));
    }
  }

  let totalMerged = 0;
  const filesToProcess =
    files.length > 0
      ? files.map((file) => project.getSourceFileOrThrow(resolve(file)))
      : project.getSourceFiles();

  for (const sf of filesToProcess) {
    totalMerged += mergeImportsInFile(sf);
  }

  if (totalMerged === 0) {
    console.log("No duplicate imports found");
    return;
  }

  const changedFiles = saveChanges(project);
  console.log(
    `✅ Merged ${totalMerged} duplicate import(s) across ${changedFiles} file(s)`,
  );
}

/**
 * Merge duplicate import declarations from the same module specifier in a
 * single source file. Returns the number of duplicate declarations removed.
 */
function mergeImportsInFile(sf: SourceFile): number {
  const imports = sf.getImportDeclarations();

  // Group imports by resolved module specifier text
  const groups = new Map<string, ImportDeclaration[]>();
  for (const imp of imports) {
    // Skip namespace imports (import * as X from "...") and bare side-effect imports
    if (imp.getNamespaceImport() || imp.getDefaultImport()) continue;
    if (imp.getNamedImports().length === 0) continue;

    const spec = imp.getModuleSpecifierValue();
    const existing = groups.get(spec);
    if (existing) existing.push(imp);
    else groups.set(spec, [imp]);
  }

  let merged = 0;

  for (const [spec, decls] of groups) {
    if (decls.length < 2) continue;

    // Determine if all declarations are type-only
    const allTypeOnly = decls.every((imp) => imp.isTypeOnly());
    // Determine if any declaration is a value (non-type-only) import
    const hasValueImport = decls.some((imp) => !imp.isTypeOnly());

    // Collect all named import specifiers with their type information
    const specifiers: {
      name: string;
      alias: string | undefined;
      isType: boolean;
    }[] = [];
    const seen = new Set<string>();

    for (const imp of decls) {
      const declIsTypeOnly = imp.isTypeOnly();
      for (const named of imp.getNamedImports()) {
        const name = named.getName();
        const alias = named.getAliasNode()?.getText();
        const key = alias ? `${name} as ${alias}` : name;
        if (seen.has(key)) continue;
        seen.add(key);

        // A specifier is type-only if:
        // - It has an explicit `type` modifier on the specifier itself, OR
        // - Its parent declaration is `import type { ... }`
        const isType = named.isTypeOnly() || declIsTypeOnly;
        specifiers.push({ name, alias, isType });
      }
    }

    // Sort: value imports first, then type imports; alphabetical within each group
    specifiers.sort((aa, bb) => {
      if (aa.isType !== bb.isType) return aa.isType ? 1 : -1;
      const aText = aa.alias ?? aa.name;
      const bText = bb.alias ?? bb.name;
      return aText.localeCompare(bText);
    });

    // Build the merged import declaration structure
    const mergedIsTypeOnly = allTypeOnly;
    const namedImports = specifiers.map((sp) => {
      const base = sp.alias ? `${sp.name} as ${sp.alias}` : sp.name;
      // Add inline `type` modifier when merging type specifiers into a value import
      if (sp.isType && hasValueImport && !mergedIsTypeOnly) {
        return `type ${base}`;
      }
      return base;
    });

    const relPath = path.relative(process.cwd(), sf.getFilePath());
    console.log(`  ${relPath}: merging ${decls.length} imports from "${spec}"`);

    // Remove all existing declarations for this specifier (in reverse order
    // to avoid index shifting)
    for (let idx = decls.length - 1; idx >= 0; idx--) {
      decls[idx]!.remove();
    }

    // Add the merged import
    sf.addImportDeclaration({
      moduleSpecifier: spec,
      namedImports,
      isTypeOnly: mergedIsTypeOnly,
    });

    merged += decls.length - 1; // count how many duplicates were eliminated
  }

  return merged;
}

function generateBarrel(sourceDir: string, outFile: string): void {
  const project = createProject();
  addAllSources(project);

  const absSource = absDir(sourceDir);
  const absOut = resolve(outFile);

  // Make sure the out file is part of the project so we can compute relative
  // specifiers from its location. Use an overwritten scratch source file so
  // relative path computation works even if the file doesn't exist yet.
  let outSourceFile = project.getSourceFile(absOut);
  if (!outSourceFile) {
    outSourceFile = project.createSourceFile(absOut, "", { overwrite: true });
  }

  // Build the "follow re-exports through the barrel" map ONCE. When we
  // encounter an importer that imports directly from the barrel (common
  // after a migration), we resolve each named import back to its underlying
  // source file via this map. If the barrel is empty or non-existent, the
  // map is empty and the regenerate-after-migration case gracefully degrades
  // to the old behavior (barrel imports get skipped).
  const barrelCache = new Map<string, BarrelReexportMap>();
  const outBarrelHasContent = outSourceFile.getStatements().length > 0;
  const outReexportMap: BarrelReexportMap | undefined = outBarrelHasContent
    ? buildBarrelReexportMap(outSourceFile, barrelCache)
    : undefined;

  const entriesByFile = new Map<string, BarrelEntry>();

  /** Record one (realSource, symbolName, isType) triple into entriesByFile. */
  const recordSymbol = (
    realPath: string,
    realSf: SourceFile,
    symbolName: string,
    isType: boolean,
  ): void => {
    let entry = entriesByFile.get(realPath);
    if (!entry) {
      entry = {
        sourceRelPath: path.relative(process.cwd(), realPath),
        moduleSpecifier: toModuleSpecifier(outSourceFile, realSf),
        valueSymbols: new Set<string>(),
        typeSymbols: new Set<string>(),
      };
      entriesByFile.set(realPath, entry);
    }
    if (isType) entry.typeSymbols.add(symbolName);
    else entry.valueSymbols.add(symbolName);
  };

  for (const sf of project.getSourceFiles()) {
    const importerPath = sf.getFilePath();
    // Skip importers inside the source dir — we only track outside consumers.
    if (isInsideDir(importerPath, absSource)) continue;
    // Skip the barrel file itself (it shouldn't contribute to its own surface).
    if (importerPath === absOut) continue;

    for (const imp of sf.getImportDeclarations()) {
      const resolved = imp.getModuleSpecifierSourceFile();
      if (!resolved) continue;
      const resolvedPath = resolved.getFilePath();
      if (!isInsideDir(resolvedPath, absSource)) continue;

      const declIsTypeOnly = imp.isTypeOnly();
      const importsThroughBarrel = resolvedPath === absOut;

      for (const named of imp.getNamedImports()) {
        // For normal direct imports, the importer-visible name is also the
        // exported name at the target. `ImportSpecifier.getName()` on
        // ts-morph returns the exported-side name (strips any local alias).
        const exportedName = named.getName();
        const isType = named.isTypeOnly() || declIsTypeOnly;

        if (importsThroughBarrel) {
          // Fast path: the barrel already re-exports this symbol — follow the
          // chain (handles aliases and nested barrels).
          const resolution = outReexportMap?.named.get(exportedName);
          if (resolution) {
            const realSf = project.getSourceFile(resolution.underlyingPath);
            if (!realSf) {
              console.warn(
                `⚠️  Re-export of "${exportedName}" points at ${resolution.underlyingPath} which is not in the project. Skipping.`,
              );
              continue;
            }
            if (resolution.underlyingPath === absOut) {
              console.warn(
                `⚠️  Re-export chain for "${exportedName}" loops back to the barrel. Skipping.`,
              );
              continue;
            }
            recordSymbol(
              resolution.underlyingPath,
              realSf,
              resolution.originalName,
              isType,
            );
            continue;
          }

          // Fallback: the barrel doesn't (yet) re-export this symbol. Scan the
          // source dir for a file that exports it. This makes regenerate-after-
          // adding-a-new-symbol work without a manual edit to the barrel, and
          // also covers symbols flowing through `export * from "..."`.
          const found = findExportInDir(
            project,
            absSource,
            absOut,
            exportedName,
          );
          if (found === "ambiguous") {
            console.warn(
              `⚠️  ${path.relative(process.cwd(), importerPath)} imports "${exportedName}" from the barrel; multiple files in ${sourceDir} export this name. Cannot disambiguate; skipping.`,
            );
          } else if (found) {
            recordSymbol(found.path, found.sf, exportedName, isType);
          } else {
            const namespaceNote =
              outReexportMap && outReexportMap.namespaceTargets.length > 0
                ? ` (may flow via "export *" from one of [${outReexportMap.namespaceTargets.map((pp) => path.relative(process.cwd(), pp)).join(", ")}])`
                : "";
            console.warn(
              `⚠️  ${path.relative(process.cwd(), importerPath)} imports "${exportedName}" from the barrel, but no file in ${sourceDir} exports it${namespaceNote}. Skipping.`,
            );
          }
        } else {
          // Deep imports into the source dir bypass the barrel intentionally
          // (e.g. network-replay primitives allowlisted in
          // lint-restricted-imports.ts). They should NOT contribute to the
          // public barrel surface — otherwise regenerate-after-exemption
          // would re-promote the symbols we just hid.
          // recordSymbol is only called for barrel imports above.
        }
      }
    }
  }

  // A symbol used as both value and type should be emitted as a value export
  // (value re-export carries the type through). De-dup accordingly.
  for (const entry of entriesByFile.values()) {
    for (const name of entry.valueSymbols) {
      entry.typeSymbols.delete(name);
    }
  }

  // Sort entries by source file path, and symbols alphabetically within each.
  const sortedEntries = [...entriesByFile.values()].sort((aa, bb) =>
    aa.sourceRelPath.localeCompare(bb.sourceRelPath),
  );

  const lines: string[] = [];
  lines.push(
    "// Auto-generated by refactor generate-barrel. Do not edit by hand.",
  );
  lines.push("");

  for (const entry of sortedEntries) {
    const values = [...entry.valueSymbols].sort((aa, bb) =>
      aa.localeCompare(bb),
    );
    const types = [...entry.typeSymbols].sort((aa, bb) => aa.localeCompare(bb));
    if (values.length > 0) {
      lines.push(
        `export { ${values.join(", ")} } from "${entry.moduleSpecifier}";`,
      );
    }
    if (types.length > 0) {
      lines.push(
        `export type { ${types.join(", ")} } from "${entry.moduleSpecifier}";`,
      );
    }
  }

  if (sortedEntries.length === 0) {
    lines.push("// (no external consumers found — barrel is empty)");
  }

  const body = lines.join("\n") + "\n";

  // Count totals for the log.
  let valueCount = 0;
  let typeCount = 0;
  for (const entry of sortedEntries) {
    valueCount += entry.valueSymbols.size;
    typeCount += entry.typeSymbols.size;
  }

  const relOut = path.relative(process.cwd(), absOut);

  if (dryRun) {
    console.log(`[dry-run] Would write ${relOut}`);
    console.log(
      `  ${sortedEntries.length} source file(s), ${valueCount} value export(s), ${typeCount} type export(s)`,
    );
    return;
  }

  outSourceFile.replaceWithText(body);
  outSourceFile.saveSync();
  console.log(`✅ Wrote ${relOut}`);
  console.log(
    `  ${sortedEntries.length} source file(s), ${valueCount} value export(s), ${typeCount} type export(s)`,
  );
}

/**
 * Scan every file inside `absSource` (excluding `excludePath`) for an exported
 * declaration named `name`. Returns the unique match, "ambiguous" if multiple
 * files export it, or undefined if none do. Used by `generateBarrel` to
 * resolve symbols that the existing barrel doesn't yet re-export — so adding
 * a brand-new export to a sourceDir file followed by a regenerate Just Works
 * without a manual edit to the barrel.
 */
function findExportInDir(
  project: Project,
  absSource: string,
  excludePath: string,
  name: string,
): { sf: SourceFile; path: string } | "ambiguous" | undefined {
  let found: { sf: SourceFile; path: string } | undefined;
  for (const candidate of project.getSourceFiles()) {
    const candidatePath = candidate.getFilePath();
    if (candidatePath === excludePath) continue;
    if (!isInsideDir(candidatePath, absSource)) continue;
    if (!candidate.getExportedDeclarations().has(name)) continue;
    if (found) return "ambiguous";
    found = { sf: candidate, path: candidatePath };
  }
  return found;
}

function redirectImport(
  symbol: string,
  oldSource: string,
  newSource: string,
): void {
  const project = createProject();
  addAllSources(project);

  const absOld = resolve(oldSource);
  const absNew = resolve(newSource);

  const oldFile = project.getSourceFile(absOld);
  if (!oldFile) {
    console.error(`❌ Source file not found: ${oldSource}`);
    process.exit(1);
  }
  const newFile = project.getSourceFile(absNew);
  if (!newFile) {
    console.error(`❌ Target file not found: ${newSource}`);
    process.exit(1);
  }

  const changed = redirectOneSymbol(project, symbol, oldFile, newFile);

  if (changed === 0) {
    console.log(`No importers of "${symbol}" from ${oldSource} found`);
    return;
  }

  const changedFiles = saveChanges(project);
  console.log(`✅ Redirected "${symbol}" in ${changedFiles} file(s)`);
}

function bulkRedirect(manifestFile: string): void {
  const manifestPath = resolve(manifestFile);
  if (!existsSync(manifestPath)) {
    console.error(`❌ Manifest not found: ${manifestFile}`);
    process.exit(1);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    console.error(`❌ Failed to parse manifest: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!Array.isArray(manifest)) {
    console.error("❌ Manifest must be a JSON array of { symbol, from, to }");
    process.exit(1);
  }

  const entries: BulkRedirectEntry[] = [];
  for (const raw of manifest) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as { symbol?: unknown }).symbol !== "string" ||
      typeof (raw as { from?: unknown }).from !== "string" ||
      typeof (raw as { to?: unknown }).to !== "string"
    ) {
      console.error(
        "❌ Each manifest entry must have string fields: symbol, from, to",
      );
      process.exit(1);
    }
    entries.push(raw as BulkRedirectEntry);
  }

  const project = createProject();
  addAllSources(project);

  let totalModified = 0;
  let skipped = 0;

  for (const entry of entries) {
    const absFrom = resolve(entry.from);
    const absTo = resolve(entry.to);
    const fromFile = project.getSourceFile(absFrom);
    const toFile = project.getSourceFile(absTo);
    if (!fromFile) {
      console.warn(
        `  Skipping "${entry.symbol}": from-file not found: ${entry.from}`,
      );
      skipped++;
      continue;
    }
    if (!toFile) {
      console.warn(
        `  Skipping "${entry.symbol}": to-file not found: ${entry.to}`,
      );
      skipped++;
      continue;
    }
    const modified = redirectOneSymbol(project, entry.symbol, fromFile, toFile);
    if (modified > 0) {
      console.log(`  ${entry.symbol}: ${modified} importer(s) redirected`);
    }
    totalModified += modified;
  }

  if (totalModified === 0) {
    console.log(
      `No importers redirected (${entries.length - skipped} entries processed, ${skipped} skipped)`,
    );
    return;
  }

  const changedFiles = saveChanges(project);
  console.log(
    `✅ Bulk redirect: ${totalModified} importer(s) across ${changedFiles} file(s) (${entries.length} manifest entries, ${skipped} skipped)`,
  );
}

function saveChanges(project: Project): number {
  let changed = 0;
  for (const sf of project.getSourceFiles()) {
    if (sf.getFullText() !== sf.getPreEmitDiagnostics.toString()) {
      // Check if actually modified
    }
  }

  if (dryRun) {
    for (const sf of project.getSourceFiles()) {
      if (!sf.isSaved()) {
        const filePath = path.relative(process.cwd(), sf.getFilePath());
        console.log(`  [dry-run] Would modify: ${filePath}`);
        changed++;
      }
    }
  } else {
    for (const sf of project.getSourceFiles()) {
      if (!sf.isSaved()) {
        sf.saveSync();
        const filePath = path.relative(process.cwd(), sf.getFilePath());
        console.log(`  Modified: ${filePath}`);
        changed++;
      }
    }
  }

  return changed;
}

/**
 * Rewrite all importers of `symbol` from `oldFile` to point at `newFile`.
 * Preserves sibling imports: if the old statement had `{ foo, bar }` and we
 * redirect only `foo`, the result is two statements — one for `bar` (old
 * source), one for `foo` (new source).
 * Returns the number of importer statements modified.
 */
function redirectOneSymbol(
  project: Project,
  symbol: string,
  oldFile: SourceFile,
  newFile: SourceFile,
): number {
  const oldPath = oldFile.getFilePath();
  // Same-file redirect is a no-op by construction.
  if (oldPath === newFile.getFilePath()) return 0;
  let modified = 0;

  for (const sf of project.getSourceFiles()) {
    if (sf === newFile) continue;
    // Iterate over a snapshot — we mutate sf.getImportDeclarations() inside the loop.
    const imports = [...sf.getImportDeclarations()];
    for (const imp of imports) {
      const resolvedModule = imp.getModuleSpecifierSourceFile();
      if (resolvedModule?.getFilePath() !== oldPath) continue;

      const named = findNamedImport(imp, symbol);
      if (!named) continue;

      const declIsTypeOnly = imp.isTypeOnly();
      const specIsTypeOnly = named.isTypeOnly() || declIsTypeOnly;
      // Preserve the text to keep any alias ("foo as bar").
      const importText = named.getText();

      // Remove the specifier from the old declaration.
      named.remove();

      // If the old declaration is now empty, remove it entirely.
      if (
        imp.getNamedImports().length === 0 &&
        !imp.getDefaultImport() &&
        !imp.getNamespaceImport()
      ) {
        imp.remove();
      }

      // Add to a new declaration pointing at newFile. Merge with an existing
      // import from newFile if compatible.
      const newSpec = toModuleSpecifier(sf, newFile);
      const existingNewImport = sf
        .getImportDeclarations()
        .find(
          (d) =>
            d.getModuleSpecifierSourceFile()?.getFilePath() ===
            newFile.getFilePath(),
        );

      if (existingNewImport) {
        const alreadyImported = existingNewImport
          .getNamedImports()
          .some((n) => n.getName() === symbol);
        if (!alreadyImported) {
          const existingIsTypeOnly = existingNewImport.isTypeOnly();
          if (existingIsTypeOnly && !specIsTypeOnly) {
            // Can't add a value import to an `import type` declaration.
            sf.addImportDeclaration({
              moduleSpecifier: newSpec,
              namedImports: [importText.replace(/^type\s+/, "")],
              isTypeOnly: false,
            });
          } else {
            const cleanText = existingIsTypeOnly
              ? importText.replace(/^type\s+/, "")
              : importText;
            existingNewImport.addNamedImport(cleanText);
          }
        }
      } else {
        const cleanText = specIsTypeOnly
          ? importText.replace(/^type\s+/, "")
          : importText;
        sf.addImportDeclaration({
          moduleSpecifier: newSpec,
          namedImports: [cleanText],
          isTypeOnly: specIsTypeOnly,
        });
      }

      modified++;
    }
  }

  return modified;
}

function findNamedImport(
  imp: ImportDeclaration,
  name: string,
): ImportSpecifier | undefined {
  return imp.getNamedImports().find((n) => n.getName() === name);
}

function listCrossDomainImports(projectRoot: string): void {
  const project = createProject();
  addAllSources(project);

  const absRoot = absDir(projectRoot);

  // Group by (importer, imported, kind) — a single statement already maps
  // uniquely, but one file can have both a value and a type import from the
  // same module across multiple statements; we keep those as distinct records.
  const records: CrossDomainRecord[] = [];

  for (const sf of project.getSourceFiles()) {
    const importerPath = sf.getFilePath();
    if (!isInsideDir(importerPath, absRoot)) continue;
    const importerDomain = domainOf(importerPath);
    if (!importerDomain) continue;

    for (const imp of sf.getImportDeclarations()) {
      const resolved = imp.getModuleSpecifierSourceFile();
      if (!resolved) continue;
      const resolvedPath = resolved.getFilePath();
      if (!isInsideDir(resolvedPath, absRoot)) continue;
      const importedDomain = domainOf(resolvedPath);
      if (!importedDomain) continue;
      if (importedDomain === importerDomain) continue;

      const declIsTypeOnly = imp.isTypeOnly();
      const valueSymbols: string[] = [];
      const typeSymbols: string[] = [];
      for (const named of imp.getNamedImports()) {
        const isType = named.isTypeOnly() || declIsTypeOnly;
        if (isType) typeSymbols.push(named.getName());
        else valueSymbols.push(named.getName());
      }
      // Skip bare side-effect imports and default/namespace-only imports.
      if (valueSymbols.length === 0 && typeSymbols.length === 0) continue;

      const importerRel = path.relative(process.cwd(), importerPath);
      const importedRel = path.relative(process.cwd(), resolvedPath);

      if (valueSymbols.length > 0) {
        records.push({
          importer: importerRel,
          imported: importedRel,
          symbols: valueSymbols.sort((aa, bb) => aa.localeCompare(bb)),
          kind: "value",
        });
      }
      if (typeSymbols.length > 0) {
        records.push({
          importer: importerRel,
          imported: importedRel,
          symbols: typeSymbols.sort((aa, bb) => aa.localeCompare(bb)),
          kind: "type",
        });
      }
    }
  }

  records.sort((aa, bb) => {
    const byImporter = aa.importer.localeCompare(bb.importer);
    if (byImporter !== 0) return byImporter;
    const byImported = aa.imported.localeCompare(bb.imported);
    if (byImported !== 0) return byImported;
    return aa.kind.localeCompare(bb.kind);
  });

  console.log(JSON.stringify(records, null, 2));
}

/** The "domain" for an import-graph file is the first path segment under src/. */
function domainOf(absPath: string): string | undefined {
  const srcRoot = absDir("src");
  if (!isInsideDir(absPath, srcRoot)) return undefined;
  const rel = path.relative(srcRoot, absPath);
  const [head] = rel.split(path.sep);
  return head || undefined;
}

function computePublicSurface(sourceDir: string): void {
  const project = createProject();
  addAllSources(project);

  const absSource = absDir(sourceDir);

  // Map key: `${absSourcePath}::${symbolName}` → record
  const map = new Map<
    string,
    {
      symbol: string;
      source: string;
      absSource: string;
      consumerFiles: Set<string>;
    }
  >();

  // Cache of barrel re-export maps, keyed by absolute barrel path. Built
  // lazily as we encounter imports that resolve to a re-export-only file.
  // Without this, the report under-counts after a barrel migration: every
  // consumer that imports through `index.ts` would land on that single
  // in-dir file instead of the real underlying sources.
  const barrelCache = new Map<string, BarrelReexportMap>();

  /**
   * Resolve an import target through zero or more barrels, returning the
   * final `(underlyingPath, originalName)` pair. Depth-limited to match
   * buildBarrelReexportMap (5). Returns null if resolution fails (e.g.
   * namespace re-export where we can't pinpoint the symbol).
   */
  const resolveThroughBarrels = (
    targetSf: SourceFile,
    exposedName: string,
  ): BarrelResolution | null => {
    // Non-barrel: the target *is* the underlying source.
    if (!isReexportOnlyBarrel(targetSf)) {
      return {
        underlyingPath: targetSf.getFilePath(),
        originalName: exposedName,
      };
    }
    const reexportMap = buildBarrelReexportMap(targetSf, barrelCache);
    const hit = reexportMap.named.get(exposedName);
    if (hit) return hit;
    if (reexportMap.namespaceTargets.length > 0) {
      console.warn(
        `⚠️  "${exposedName}" may flow through "export *" from barrel ${path.relative(process.cwd(), targetSf.getFilePath())}; cannot pinpoint underlying source.`,
      );
    }
    return null;
  };

  for (const sf of project.getSourceFiles()) {
    const importerPath = sf.getFilePath();
    // Only care about consumers outside the source dir.
    if (isInsideDir(importerPath, absSource)) continue;

    for (const imp of sf.getImportDeclarations()) {
      const resolved = imp.getModuleSpecifierSourceFile();
      if (!resolved) continue;
      const resolvedPath = resolved.getFilePath();
      if (!isInsideDir(resolvedPath, absSource)) continue;

      for (const named of imp.getNamedImports()) {
        const exposedName = named.getName();
        // Follow re-exports if the import target is itself a barrel.
        const resolution = resolveThroughBarrels(resolved, exposedName);
        if (!resolution) continue; // unresolvable (namespace re-export); warning already logged

        const { underlyingPath, originalName } = resolution;
        // Only count the symbol if the resolved underlying file is still
        // inside the source dir. (A barrel can re-export from anywhere —
        // but a symbol that ultimately lives outside the dir is not part
        // of this dir's public surface.)
        if (!isInsideDir(underlyingPath, absSource)) continue;

        const key = `${underlyingPath}::${originalName}`;
        let entry = map.get(key);
        if (!entry) {
          entry = {
            symbol: originalName,
            source: path.relative(process.cwd(), underlyingPath),
            absSource: underlyingPath,
            consumerFiles: new Set<string>(),
          };
          map.set(key, entry);
        }
        entry.consumerFiles.add(path.relative(process.cwd(), importerPath));
      }
    }
  }

  const records: PublicSurfaceRecord[] = [...map.values()].map((entry) => ({
    symbol: entry.symbol,
    source: entry.source,
    consumers: entry.consumerFiles.size,
    consumerFiles: [...entry.consumerFiles].sort((aa, bb) =>
      aa.localeCompare(bb),
    ),
  }));

  // Sort by consumer count descending, tiebreak by symbol then source.
  records.sort((aa, bb) => {
    if (bb.consumers !== aa.consumers) return bb.consumers - aa.consumers;
    const bySymbol = aa.symbol.localeCompare(bb.symbol);
    if (bySymbol !== 0) return bySymbol;
    return aa.source.localeCompare(bb.source);
  });

  console.log(JSON.stringify(records, null, 2));
}

/** True if `filePath` lives inside `dir` (or is `dir` itself). */
function isInsideDir(filePath: string, dir: string): boolean {
  const absFile = path.resolve(filePath);
  const absRoot = absDir(dir);
  if (absFile === absRoot) return true;
  return absFile.startsWith(absRoot + path.sep);
}

/** Normalize a file path to an absolute path without trailing slash. */
function absDir(dir: string): string {
  return path.resolve(dir).replace(/[\\/]+$/, "");
}

/**
 * Walk an `export ... from "..."` barrel and produce a map from
 * alias-seen-by-importer to the underlying source file and original symbol
 * name. If a re-export target is itself a barrel, recurse up to `maxDepth`
 * levels so chains like `index → submodule/index → submodule/foo` resolve.
 *
 * `cache` is keyed by absolute barrel path so multi-barrel scans don't
 * rebuild the same map twice.
 */
function buildBarrelReexportMap(
  barrelSf: SourceFile,
  cache: Map<string, BarrelReexportMap>,
  maxDepth = 5,
): BarrelReexportMap {
  const barrelPath = barrelSf.getFilePath();
  const cached = cache.get(barrelPath);
  if (cached) return cached;

  const result: BarrelReexportMap = {
    named: new Map(),
    namespaceTargets: [],
  };
  // Insert placeholder BEFORE recursing to break cycles (barrel A → B → A).
  cache.set(barrelPath, result);

  if (maxDepth <= 0) {
    console.warn(
      `⚠️  buildBarrelReexportMap: depth limit reached at ${path.relative(process.cwd(), barrelPath)}`,
    );
    return result;
  }

  for (const decl of barrelSf.getExportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile();
    if (!target) continue; // `export {}` or unresolved specifier — skip
    const targetPath = target.getFilePath();

    if (decl.isNamespaceExport()) {
      result.namespaceTargets.push(targetPath);
      continue;
    }

    // Named re-exports. If the target is itself a re-export-only barrel,
    // recurse to find the real underlying source for each symbol.
    const targetIsBarrel = isReexportOnlyBarrel(target);
    const targetMap = targetIsBarrel
      ? buildBarrelReexportMap(target, cache, maxDepth - 1)
      : undefined;

    for (const named of decl.getNamedExports()) {
      // On export specifiers:
      //   `export { foo }`          → getName() = "foo", alias undefined
      //   `export { foo as bar }`   → getName() = "foo", alias = "bar"
      // The name exposed to importers is the alias if present, else getName().
      const originalInTarget = named.getName();
      const exposedName = named.getAliasNode()?.getText() ?? originalInTarget;

      if (targetMap) {
        // Follow the chain: the symbol `originalInTarget` is the name *as
        // seen by the target barrel*, so look it up in the target's map to
        // get the real underlying source.
        const downstream = targetMap.named.get(originalInTarget);
        if (downstream) {
          result.named.set(exposedName, downstream);
        } else {
          // Target is a barrel but doesn't expose this symbol via a named
          // re-export we can follow. It might flow through `export * from`.
          // Record it as pointing at the target barrel itself so the caller
          // at least gets a real file path; the warning will surface later
          // if the symbol ends up unresolvable.
          result.named.set(exposedName, {
            underlyingPath: targetPath,
            originalName: originalInTarget,
          });
        }
      } else {
        result.named.set(exposedName, {
          underlyingPath: targetPath,
          originalName: originalInTarget,
        });
      }
    }
  }

  return result;
}

/**
 * Heuristic: is this source file a pure re-export barrel?
 * A file qualifies if it has at least one statement and EVERY statement is
 * an `export ... from "..."` form (named or namespace). Comments and blank
 * lines are fine — `getStatements()` ignores them.
 *
 * A file with basename `index.ts` is also treated as a barrel candidate so
 * that callers don't have to care about whether the file currently holds
 * content or not (e.g. an empty post-migration barrel still counts).
 */
function isReexportOnlyBarrel(sf: SourceFile): boolean {
  const stmts = sf.getStatements();
  if (stmts.length === 0) {
    // Empty file — only treat as a barrel if its basename is index.ts, and
    // even then there's nothing to follow, so callers must handle that case.
    return path.basename(sf.getFilePath()) === "index.ts";
  }
  for (const stmt of stmts) {
    if (!stmt.isKind(SyntaxKind.ExportDeclaration)) return false;
    const decl = stmt.asKindOrThrow(SyntaxKind.ExportDeclaration);
    if (!decl.getModuleSpecifier()) return false;
  }
  return true;
}

function addReexport(
  barrelFile: string,
  sourceFile: string,
  symbol: string,
  typeOnly: boolean,
): void {
  const project = createProject();
  addAllSources(project);

  const absBarrel = resolve(barrelFile);
  const absSource = resolve(sourceFile);

  const sourceSf = project.getSourceFile(absSource);
  if (!sourceSf) {
    console.error(`❌ Source file not found: ${sourceFile}`);
    process.exit(1);
  }

  // Ensure the barrel is part of the project. If the file exists on disk,
  // load it; otherwise create an empty one.
  let barrelSf = project.getSourceFile(absBarrel);
  if (!barrelSf) {
    if (existsSync(absBarrel)) {
      barrelSf = project.addSourceFileAtPath(absBarrel);
    } else {
      barrelSf = project.createSourceFile(absBarrel, "", { overwrite: true });
    }
  }

  const moduleSpecifier = toModuleSpecifier(barrelSf, sourceSf);

  // Check idempotence: does the barrel already re-export this symbol with this type-onliness?
  let alreadyPresent = false;
  for (const decl of barrelSf.getExportDeclarations()) {
    if (!decl.getModuleSpecifier()) continue;
    const declSource = decl.getModuleSpecifierSourceFile();
    if (declSource?.getFilePath() !== absSource) continue;
    for (const named of decl.getNamedExports()) {
      if (named.getName() !== symbol) continue;
      // Compare type-onliness: either declaration-level `export type` or
      // inline specifier-level `type`.
      const isDeclTypeOnly = decl.isTypeOnly();
      const isSpecTypeOnly = named.isTypeOnly() || isDeclTypeOnly;
      if (isSpecTypeOnly === typeOnly) {
        alreadyPresent = true;
        break;
      }
    }
    if (alreadyPresent) break;
  }

  if (alreadyPresent) {
    console.log(
      `Re-export of "${symbol}" from ${moduleSpecifier} already present — no-op`,
    );
    return;
  }

  // Append a fresh re-export declaration.
  barrelSf.addExportDeclaration({
    moduleSpecifier,
    namedExports: [symbol],
    isTypeOnly: typeOnly,
  });

  // Sort all export-from declarations alphabetically by module specifier.
  sortBarrelExports(barrelSf);

  const relBarrel = path.relative(process.cwd(), absBarrel);
  if (dryRun) {
    console.log(
      `[dry-run] Would add ${typeOnly ? "type " : ""}re-export: ${symbol} from ${moduleSpecifier}`,
    );
    console.log(`[dry-run] Would modify: ${relBarrel}`);
    return;
  }

  barrelSf.saveSync();
  console.log(
    `✅ Added ${typeOnly ? "type " : ""}re-export: ${symbol} from ${moduleSpecifier}`,
  );
  console.log(`  Modified: ${relBarrel}`);
}

function createProject(): Project {
  return new Project({
    tsConfigFilePath: path.resolve("tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
}

function addAllSources(project: Project): void {
  project.addSourceFilesAtPaths([
    "src/**/*.ts",
    "server/**/*.ts",
    "test/**/*.ts",
  ]);
}

function resolve(filePath: string): string {
  return path.resolve(filePath);
}

/** Build a relative module specifier from `fromFile` to `toFile`, always ending in .ts. */
function toModuleSpecifier(fromFile: SourceFile, toFile: SourceFile): string {
  const raw = fromFile.getRelativePathAsModuleSpecifierTo(toFile);
  return raw.endsWith(".ts") ? raw : raw + ".ts";
}

/**
 * Sort all `export {...} from "..."` declarations in a barrel file
 * alphabetically by module specifier. Non-re-export statements are preserved
 * in their original positions (they anchor to the top of the file).
 */
function sortBarrelExports(sf: SourceFile): void {
  const statements = sf.getStatements();
  const reexports: { text: string; spec: string }[] = [];
  const removalTargets: import("ts-morph").Statement[] = [];

  for (const stmt of statements) {
    if (!stmt.isKind(SyntaxKind.ExportDeclaration)) continue;
    const exportDecl = stmt.asKindOrThrow(SyntaxKind.ExportDeclaration);
    const moduleSpec = exportDecl.getModuleSpecifierValue();
    if (!moduleSpec) continue; // `export {};` or `export { foo };` (no from) — leave alone
    reexports.push({ text: exportDecl.getText(), spec: moduleSpec });
    removalTargets.push(stmt);
  }

  if (reexports.length <= 1) return;

  reexports.sort((aa, bb) => aa.spec.localeCompare(bb.spec));

  // Remove in reverse order to avoid shifting.
  for (let idx = removalTargets.length - 1; idx >= 0; idx--) {
    removalTargets[idx]!.remove();
  }

  // Append sorted re-exports at the end.
  sf.addStatements(reexports.map((r) => r.text).join("\n"));
}

/** Parse argv into named flags, repeatable flag arrays, and bare positionals.
 *  Defined as a function (not top-level code) so reorder-file.ts doesn't
 *  hoist its output consts above the loop that populates them. */
function parseArgv(argv: string[]): {
  flagMap: Map<string, string>;
  flagMulti: Map<string, string[]>;
  positionalArgs: string[];
} {
  const flagMap = new Map<string, string>();
  const flagMulti = new Map<string, string[]>();
  const positionalArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (
      a === "--dry-run" ||
      a === "--all" ||
      a === "--type" ||
      a === "--cascade" ||
      a === "--drop-param"
    )
      continue;
    if (a.startsWith("--") && i + 1 < argv.length) {
      const key = a.slice(2);
      const val = argv[++i]!;
      flagMap.set(key, val);
      const arr = flagMulti.get(key);
      if (arr) arr.push(val);
      else flagMulti.set(key, [val]);
    } else if (!a.startsWith("--")) {
      positionalArgs.push(a);
    }
  }
  return { flagMap, flagMulti, positionalArgs };
}

function printUsage(): void {
  console.log(`AST-based refactoring CLI

Commands:
  rename-symbol  <file> <name> <newName>       Rename a symbol across all files
  move-export    <from> <to> <name>            Move export(s) between files (auto-detects arg order)
  rename-prop    <typeName> <prop> <newProp>    Rename a type/interface property (auto-detects file-first arg order)
  rename-in-file <name> <newName> <file...>    Rename all declarations in specific files (auto-detects file-first arg order)
  rename-file    <oldPath> <newPath>           Rename/move a file and update all imports
  merge-imports  <file...> | --all             Merge duplicate imports from same module
  find-symbol    <name>                        Find where a symbol is declared
  list-exports   <file>                        List all exports from a file
  list-references <file> <name>                Show all files that import a symbol
  generate-barrel <sourceDir> <outFile>        Generate a barrel re-exporting the public surface of sourceDir
  redirect-import <symbol> <oldSource> <newSource>  Rewrite imports of symbol from oldSource to newSource
  bulk-redirect  <manifestFile>                Apply many redirects from a JSON manifest in one AST pass
  list-cross-domain-imports [<projectRoot>]    Print every cross-domain import in the project as JSON
  compute-public-surface <sourceDir>           Print symbols exported from sourceDir that have outside consumers (JSON)
  add-reexport   <barrelFile> <sourceFile> <symbol>  Append (idempotent) a re-export to a barrel file
  list-callsites <file> <symbol>               Every reference to <symbol> (imports + local calls), grouped by file
  remove-export  <file> <name>                 Delete an exported declaration + every import of it (errors if still referenced)
  fold-constant  <file> <name> <true|false>    Fold if/ternary/&&/|| branches whose truthiness is determined by <name> (handles bare name, this.<name>, obj.<name>)
  inline-param   <file> <fn> <param> <true|false>  Inline a fn parameter as a constant, fold dead body branches; --drop-param also removes it from signature + call sites

Options:
  --dry-run    Show what would change without writing
  --cascade    (rename-symbol/prop/in-file) also rename coincident locals
               (const <old> = <expr>.<new>) and confirm no textual remnants
  --type       (add-reexport) emit an 'export type { ... }' re-export instead of a value re-export
  --drop-param (inline-param) also remove the parameter from the signature and the matching argument from every call site

Examples:
  deno run -A scripts/refactor.ts rename-symbol src/types.ts Phase GamePhase
  deno run -A scripts/refactor.ts move-export src/types.ts src/spatial.ts TILE_SIZE
  deno run -A scripts/refactor.ts move-export --from src/types.ts --to src/spatial.ts --symbol TILE_SIZE --symbol FOO
  deno run -A scripts/refactor.ts rename-prop Player score totalScore
  deno run -A scripts/refactor.ts rename-file src/old-name.ts src/new-name.ts
  deno run -A scripts/refactor.ts find-symbol GameState
  deno run -A scripts/refactor.ts list-exports src/types.ts
  deno run -A scripts/refactor.ts list-references src/types.ts GameState
  deno run -A scripts/refactor.ts rename-symbol src/render-effects.ts overlayCtx canvasCtx --dry-run
  deno run -A scripts/refactor.ts merge-imports src/game-state.ts src/types.ts
  deno run -A scripts/refactor.ts merge-imports --all --dry-run
  deno run -A scripts/refactor.ts generate-barrel src/game src/game/index.ts
  deno run -A scripts/refactor.ts redirect-import canPlacePiece src/game/build-system.ts src/game/index.ts --dry-run
  deno run -A scripts/refactor.ts bulk-redirect /tmp/redirects.json --dry-run
  deno run -A scripts/refactor.ts list-cross-domain-imports src
  deno run -A scripts/refactor.ts compute-public-surface src/game
  deno run -A scripts/refactor.ts add-reexport src/game/index.ts src/game/build-system.ts canPlacePiece
  deno run -A scripts/refactor.ts list-callsites src/render/render-map.ts drawTerrain
  deno run -A scripts/refactor.ts remove-export src/render/render-map.ts drawTerrain --dry-run
  deno run -A scripts/refactor.ts fold-constant src/render/renderer.ts terrainLayerEnabled false --dry-run
  deno run -A scripts/refactor.ts inline-param src/render/render-map.ts drawCastles drawWalls false --drop-param --dry-run`);
}
