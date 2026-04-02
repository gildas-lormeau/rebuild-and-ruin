/**
 * AST-based refactoring CLI for reliable multi-file edits.
 *
 * Commands:
 *   rename-symbol  <file> <name> <newName>   — Rename a symbol across all files
 *   move-export    <from> <to> <name>        — Move an exported declaration between files
 *   rename-prop    <typeName> <prop> <newProp> — Rename an interface/type property across all files
 *   rename-in-file <name> <newName> <file...> — Rename ALL declarations of a name within specific files
 *
 * Usage: npx tsx scripts/refactor.ts <command> [...args] [--dry-run]
 */

import {
  type ExportedDeclarations,
  type Identifier,
  type ImportDeclaration,
  type ImportSpecifier,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import process from "node:process";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// Parse --key value pairs into a map, collect bare positional args separately.
// Repeated flags (e.g. --symbol A --symbol B) are collected into flagMulti.
const flagMap = new Map<string, string>();
const flagMulti = new Map<string, string[]>();
const positionalArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--dry-run") continue;
  if (a.startsWith("--") && i + 1 < args.length) {
    const key = a.slice(2);
    const val = args[++i]!;
    flagMap.set(key, val);
    const arr = flagMulti.get(key);
    if (arr) arr.push(val);
    else flagMulti.set(key, [val]);
  } else if (!a.startsWith("--")) {
    positionalArgs.push(a);
  }
}
const [command, ...commandArgs] = positionalArgs;

if (!command) {
  printUsage();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Project setup
// ---------------------------------------------------------------------------

function createProject(): Project {
  return new Project({
    tsConfigFilePath: path.resolve("tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
}

function addAllSources(project: Project): void {
  project.addSourceFilesAtPaths(["src/**/*.ts", "server/**/*.ts"]);
}

function resolve(filePath: string): string {
  return path.resolve(filePath);
}

/** Get an existing source file or create it if it doesn't exist / is empty.
 *  Works around ts-morph's addStatements bug on almost-empty files by seeding
 *  a dummy export that is removed after the real content is inserted. */
function getOrCreateSourceFile(project: Project, filePath: string): SourceFile {
  const existing = project.getSourceFile(filePath);
  if (existing && existing.getFullText().trim().length > 0) return existing;

  // File is missing or empty — create/overwrite with a dummy export so
  // ts-morph's internal printer has something to anchor against.
  if (existing) existing.removeText();
  const sf = existing ?? project.createSourceFile(filePath, "", { overwrite: true });
  sf.addStatements("export {};\n");
  return sf;
}

// ---------------------------------------------------------------------------
// rename-symbol: rename an exported symbol across all files
// ---------------------------------------------------------------------------

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

  const changedFiles = saveChanges(project);
  console.log(`✅ Renamed across ${changedFiles} file(s)`);
}

// ---------------------------------------------------------------------------
// move-export: move a declaration from one file to another
// ---------------------------------------------------------------------------

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
    const canonicalPath = path.relative(process.cwd(), declSourceFile.getFilePath());
    console.error(`❌ "${name}" in ${fromPath} is a re-export from ${canonicalPath}`);
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

  // If toFile already imported `name` from fromFile, remove that import
  cleanSelfImport(toFile, name);

  const changedFiles = saveChanges(project);
  console.log(`✅ Moved "${name}" — ${changedFiles} file(s) changed`);
}

// ---------------------------------------------------------------------------
// rename-prop: rename an interface/type property across all files
// ---------------------------------------------------------------------------

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
          console.log(`Renaming ${typeName}.${prop} → ${newProp} (defined in ${sf.getFilePath()})`);
          member.rename(newProp);
          found = true;
        }
      }
    }

    // Check type aliases with object literal types
    for (const alias of sf.getTypeAliases()) {
      if (alias.getName() === typeName) {
        const typeNode = alias.getTypeNode();
        if (typeNode && typeNode.isKind(SyntaxKind.TypeLiteral)) {
          const member = typeNode.getProperty(prop);
          if (member) {
            console.log(`Renaming ${typeName}.${prop} → ${newProp} (defined in ${sf.getFilePath()})`);
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

  const changedFiles = saveChanges(project);
  console.log(`✅ Renamed property across ${changedFiles} file(s)`);
}

// ---------------------------------------------------------------------------
// Shorthand property fixups
// ---------------------------------------------------------------------------

/**
 * After a rename, scan all modified files for shorthand properties that now
 * reference a non-existent local variable (`{ newName }` where only `oldName`
 * exists in scope). Converts them to `{ newName: oldName }`.
 */
function fixBrokenShorthands(project: Project, oldName: string, newName: string): void {
  for (const sf of project.getSourceFiles()) {
    if (sf.isSaved()) continue; // unchanged file

    let madeChanges = false;
    // Iterate shorthand property assignments that match the new name
    for (const node of sf.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)) {
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

        sf.replaceText([start, end + (trailingComma ? 1 : 0)], `${newName}: ${oldName}${trailingComma}`);
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

/**
 * Collapse `{ name: name }` → `{ name }` (shorthand) when both sides are the
 * same identifier. This happens when rename-in-file renames both a property
 * and its local variable to the same new name.
 */
function collapseRedundantPropertyAssignments(project: Project, name: string): void {
  for (const sf of project.getSourceFiles()) {
    let madeChanges = false;
    for (const node of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (node.getName() !== name) continue;
      const init = node.getInitializer();
      if (init?.isKind(SyntaxKind.Identifier) && init.getText() === name) {
        const start = node.getStart();
        const end = node.getEnd();
        const trailingComma = sf.getFullText()[end] === "," ? "," : "";
        sf.replaceText([start, end + (trailingComma ? 1 : 0)], `${name}${trailingComma}`);
        madeChanges = true;
        console.log(`  Collapsed ${name}: ${name} → ${name} in ${path.relative(process.cwd(), sf.getFilePath())}`);
        break;
      }
    }
    if (madeChanges) {
      collapseRedundantPropertyAssignments(project, name);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove the `export {};` dummy statement seeded by getOrCreateSourceFile. */
function removeDummyExport(sf: SourceFile): void {
  for (const stmt of sf.getStatements()) {
    if (stmt.isKind(SyntaxKind.ExportDeclaration)) {
      const exportDecl = stmt.asKindOrThrow(SyntaxKind.ExportDeclaration);
      if (!exportDecl.getModuleSpecifier() && exportDecl.getNamedExports().length === 0) {
        stmt.remove();
        return;
      }
    }
  }
}

function findDeclarationIdentifier(sf: SourceFile, name: string): Identifier | undefined {
  // Search exported declarations first
  const exported = sf.getExportedDeclarations().get(name);
  if (exported && exported.length > 0) {
    const node = exported[0]!;
    // Get the name identifier from the declaration
    if ("getName" in node && typeof node.getName === "function") {
      const nameNode = (node as { getNameNode?: () => Identifier }).getNameNode?.();
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

interface ImportInfo {
  moduleSpecifier: string;
  namedImports: string[];
  isTypeOnly: boolean;
}

function collectDeclImports(decl: ExportedDeclarations, sourceFile: SourceFile): ImportInfo[] {
  // Find all identifiers used in the declaration
  const usedNames = new Set<string>();
  for (const id of decl.getDescendantsOfKind(SyntaxKind.Identifier)) {
    usedNames.add(id.getText());
  }

  const result: ImportInfo[] = [];

  for (const imp of sourceFile.getImportDeclarations()) {
    const moduleSpec = imp.getModuleSpecifierValue();
    const matchingImports: string[] = [];
    let isTypeOnly = imp.isTypeOnly();

    for (const named of imp.getNamedImports()) {
      const importName = named.getAliasNode()?.getText() ?? named.getName();
      if (usedNames.has(importName)) {
        matchingImports.push(named.getText()); // preserves "type X" and aliases
      }
    }

    if (matchingImports.length > 0) {
      result.push({ moduleSpecifier: moduleSpec, namedImports: matchingImports, isTypeOnly });
    }
  }

  return result;
}

function addImportsToFile(targetFile: SourceFile, imports: ImportInfo[], _fromFile: SourceFile): void {
  const targetPath = targetFile.getFilePath();
  for (const imp of imports) {
    // Skip self-imports: if the module resolves to the target file itself,
    // the symbols are already local — no import needed.
    const resolved = targetFile.getProject().getSourceFile(
      path.resolve(path.dirname(targetFile.getFilePath()), imp.moduleSpecifier.replace(/\.ts$/, "") + ".ts"),
    );
    if (resolved?.getFilePath() === targetPath) continue;

    // Check if target already has an import from this module
    const existing = targetFile
      .getImportDeclarations()
      .find((d) => d.getModuleSpecifierValue() === imp.moduleSpecifier);

    if (existing) {
      // Add missing named imports
      const existingNames = new Set(existing.getNamedImports().map((n) => n.getText()));
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
    const statement = varDecl.getFirstAncestorByKind(SyntaxKind.VariableStatement);
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
      if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport()) {
        imp.remove();
      }

      // Add to new import from toFile
      // Append .ts extension — this project uses explicit .ts imports everywhere.
      const rawSpec = sf.getRelativePathAsModuleSpecifierTo(toFile);
      const newModuleSpec = rawSpec.endsWith(".ts") ? rawSpec : rawSpec + ".ts";
      const existingToImport = sf
        .getImportDeclarations()
        .find((d) => d.getModuleSpecifierSourceFile()?.getFilePath() === toFile.getFilePath());

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
            const cleanText = existingIsTypeOnly ? importText.replace(/^type\s+/, "") : importText;
            existingToImport.addNamedImport(cleanText);
          }
        }
      } else {
        sf.addImportDeclaration({
          moduleSpecifier: newModuleSpec,
          namedImports: [importText],
          isTypeOnly: isTypeImport,
        });
      }
    }
  }
}

function findNamedImport(imp: ImportDeclaration, name: string): ImportSpecifier | undefined {
  return imp.getNamedImports().find((n) => n.getName() === name);
}

function cleanSelfImport(file: SourceFile, symbolName: string): void {
  for (const imp of file.getImportDeclarations()) {
    const resolvedModule = imp.getModuleSpecifierSourceFile();
    if (resolvedModule?.getFilePath() === file.getFilePath()) {
      const named = findNamedImport(imp, symbolName);
      if (named) named.remove();
      if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport()) {
        imp.remove();
      }
    }
  }
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

// ---------------------------------------------------------------------------
// rename-in-file: rename ALL declarations of a name within specific files
// ---------------------------------------------------------------------------

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
    console.error(`❌ No declarations of "${name}" found in any of the specified files`);
    process.exit(1);
  }

  // ts-morph handles shorthand expansion during individual renames. When both
  // property and local are renamed, the result is `{ newName: newName }`.
  // Collapse those back to shorthand `{ newName }`.
  collapseRedundantPropertyAssignments(project, newName);

  const changedFiles = saveChanges(project);
  console.log(`✅ Renamed ${totalDecls} declaration(s) across ${changedFiles} file(s)`);
}

/**
 * Find the next identifier named `name` that is a declaration (parameter,
 * variable, property signature, binding element) in the given source file.
 */
function findNextDeclarationIdentifier(sf: SourceFile, name: string): Identifier | undefined {
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
      if ("getName" in parent && typeof parent.getName === "function" && parent.getName() === name) {
        return id;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// find-symbol: locate where a symbol is declared across the project
// ---------------------------------------------------------------------------

function findSymbol(name: string): void {
  const project = createProject();
  addAllSources(project);

  const results: { file: string; line: number; kind: string; exported: boolean }[] = [];

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
        results.push({ file: relPath, line: fn.getStartLineNumber(), kind: "FunctionDeclaration", exported: false });
      }
    }
    for (const vs of sf.getVariableStatements()) {
      if (vs.isExported()) continue;
      for (const vd of vs.getDeclarations()) {
        if (vd.getName() === name) {
          results.push({ file: relPath, line: vd.getStartLineNumber(), kind: "VariableDeclaration", exported: false });
        }
      }
    }
    for (const iface of sf.getInterfaces()) {
      if (iface.getName() === name && !iface.isExported()) {
        results.push({ file: relPath, line: iface.getStartLineNumber(), kind: "InterfaceDeclaration", exported: false });
      }
    }
    for (const alias of sf.getTypeAliases()) {
      if (alias.getName() === name && !alias.isExported()) {
        results.push({ file: relPath, line: alias.getStartLineNumber(), kind: "TypeAliasDeclaration", exported: false });
      }
    }
    for (const en of sf.getEnums()) {
      if (en.getName() === name && !en.isExported()) {
        results.push({ file: relPath, line: en.getStartLineNumber(), kind: "EnumDeclaration", exported: false });
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

// ---------------------------------------------------------------------------
// list-exports: list all exported symbols from a file
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// list-references: show all files that import a symbol from a file
// ---------------------------------------------------------------------------

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
  console.log(`\n${importers.length} file(s) import "${symbolName}" from ${filePath}`);
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`AST-based refactoring CLI

Commands:
  rename-symbol  <file> <name> <newName>       Rename a symbol across all files
  move-export    <from> <to> <name>            Move export(s) between files (auto-detects arg order)
  rename-prop    <typeName> <prop> <newProp>    Rename a type/interface property
  rename-in-file <name> <newName> <file...>    Rename all declarations in specific files
  find-symbol    <name>                        Find where a symbol is declared
  list-exports   <file>                        List all exports from a file
  list-references <file> <name>                Show all files that import a symbol

Options:
  --dry-run    Show what would change without writing

Examples:
  npx tsx scripts/refactor.ts rename-symbol src/types.ts Phase GamePhase
  npx tsx scripts/refactor.ts move-export src/types.ts src/spatial.ts TILE_SIZE
  npx tsx scripts/refactor.ts move-export --from src/types.ts --to src/spatial.ts --symbol TILE_SIZE --symbol FOO
  npx tsx scripts/refactor.ts rename-prop Player score totalScore
  npx tsx scripts/refactor.ts find-symbol GameState
  npx tsx scripts/refactor.ts list-exports src/types.ts
  npx tsx scripts/refactor.ts list-references src/types.ts GameState
  npx tsx scripts/refactor.ts rename-symbol src/render-effects.ts overlayCtx canvasCtx --dry-run`);
}

switch (command) {
  case "rename-symbol": {
    const file = flagMap.get("file") ?? commandArgs[0];
    const name = flagMap.get("name") ?? flagMap.get("symbol") ?? commandArgs[1];
    const newName = flagMap.get("new-name") ?? flagMap.get("newName") ?? commandArgs[2];
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
    let symbols = flagMulti.get("symbol") ?? flagMulti.get("name") ?? (commandArgs[2] ? [commandArgs[2]] : []);

    // Smart reorder: if 'from' doesn't look like a file path, assume user passed <name> <from> <to>
    if (from && !from.includes("/") && !from.endsWith(".ts") && commandArgs.length >= 3) {
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
      console.error("Usage: move-export <from> <to> <name> OR --from <from> --to <to> --symbol <name> [--symbol <name2>]");
      process.exit(1);
    }
    for (const name of symbols) {
      moveExport(from, to, name);
    }
    break;
  }
  case "rename-prop": {
    const typeName = flagMap.get("type") ?? flagMap.get("typeName") ?? commandArgs[0];
    const prop = flagMap.get("prop") ?? commandArgs[1];
    const newProp = flagMap.get("new-prop") ?? flagMap.get("newProp") ?? commandArgs[2];
    if (!typeName || !prop || !newProp) {
      console.error("Usage: rename-prop <typeName> <prop> <newProp>");
      process.exit(1);
    }
    renameProp(typeName, prop, newProp);
    break;
  }
  case "rename-in-file": {
    const name = flagMap.get("name") ?? flagMap.get("symbol") ?? commandArgs[0];
    const newName = flagMap.get("new-name") ?? flagMap.get("newName") ?? commandArgs[1];
    const files = flagMap.has("files") ? flagMap.get("files")!.split(",") : commandArgs.slice(2);
    if (!name || !newName || files.length === 0) {
      console.error("Usage: rename-in-file <name> <newName> <file...>");
      process.exit(1);
    }
    console.log(`Renaming all "${name}" → "${newName}" in ${files.length} file(s)`);
    renameInFile(name, newName, files);
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
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
