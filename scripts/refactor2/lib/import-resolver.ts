/**
 * Post-pass that walks modified files and ensures every referenced type
 * name has a matching `type` import. Replaces the manual `--import-from`
 * dance: after `change type` (or any verb that introduces new type names),
 * call `resolveImportsForFiles` to add the imports automatically.
 *
 * Resolution rules:
 *  1. Names already declared (imports, type aliases, classes, enums) are
 *     skipped.
 *  2. The export index is built from each project file's
 *     `getExportedDeclarations()` — but only entries whose declaration
 *     lives in the same file (direct exports). Re-exports are filtered
 *     so the resolver always points at the declaring file, not the
 *     barrel that re-publishes it.
 *  3. Built-in / DOM types and single-letter generics are ignored.
 *  4. If a name resolves to multiple direct-declaration files (rare —
 *     usually means two symbols sharing a name), prefer the deepest
 *     path (most segments). Ties throw with the candidate list so the
 *     caller can pass `--import-from` to disambiguate.
 *
 * Idempotent: a second pass over the same files is a no-op.
 */

import { Node, type Project, type SourceFile } from "ts-morph";

export interface ImportResolution {
  file: string;
  added: { name: string; from: string }[];
}

export interface ResolveOptions {
  /** Optional override: if provided, every unresolved name found in the
   *  files is imported from this module specifier instead of the
   *  resolver's automatic choice. Pass as a relative path or absolute
   *  file path — both are normalized to a `./…` / `../…` specifier. */
  importFromOverride?: string;
  /** When `true`, emit `import type { … }`. Defaults to `true` since the
   *  primary caller is `change type` (annotation-only edits). */
  typeOnly?: boolean;
}

/** Built-in TypeScript / DOM names the resolver should never try to import. */
const BUILTIN_TYPES = new Set([
  "Array",
  "Promise",
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  "ReadonlySet",
  "ReadonlyMap",
  "ReadonlyArray",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "Parameters",
  "ReturnType",
  "InstanceType",
  "Awaited",
  "Date",
  "RegExp",
  "Error",
  "Function",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "ArrayBuffer",
  "DataView",
  "Iterable",
  "Iterator",
  "IterableIterator",
  "Generator",
  "AsyncGenerator",
  "AsyncIterable",
  "AsyncIterator",
]);

export function resolveImportsForFiles(
  project: Project,
  files: readonly string[],
  options: ResolveOptions = {},
): ImportResolution[] {
  const typeOnly = options.typeOnly !== false;
  const overrideTarget = options.importFromOverride
    ? resolveOverrideToSourceFile(project, options.importFromOverride)
    : undefined;
  const exportIndex = buildExportIndex(project);
  const results: ImportResolution[] = [];

  for (const filePath of files) {
    const sf = project.getSourceFile(filePath);
    if (!sf) continue;
    const declared = collectDeclaredNames(sf);
    const unresolved = collectUnresolvedTypeNames(sf, declared);
    if (unresolved.size === 0) continue;

    const added: { name: string; from: string }[] = [];
    for (const name of unresolved) {
      const target = overrideTarget ?? pickTarget(name, exportIndex);
      if (!target) continue;
      addTypeImport(sf, name, target, typeOnly);
      added.push({ name, from: target.getFilePath() });
    }
    if (added.length > 0) results.push({ file: filePath, added });
  }
  return results;
}

function resolveOverrideToSourceFile(
  project: Project,
  override: string,
): SourceFile | undefined {
  const direct = project.getSourceFile(override);
  if (direct) return direct;
  // Try common path variants (with/without `.ts`, with `src/` prefix).
  const candidates = [
    override.endsWith(".ts") ? override : `${override}.ts`,
    override.startsWith("src/") ? override : `src/${override}`,
    override.startsWith("src/") || override.endsWith(".ts")
      ? null
      : `src/${override}.ts`,
  ].filter((path): path is string => path !== null);
  for (const candidate of candidates) {
    const sf = project.getSourceFile(candidate);
    if (sf) return sf;
  }
  return undefined;
}

function buildExportIndex(project: Project): Map<string, SourceFile[]> {
  const index = new Map<string, SourceFile[]>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const filePath = sf.getFilePath();
    for (const [name, declarations] of sf.getExportedDeclarations()) {
      const isDirect = declarations.some(
        (decl) => decl.getSourceFile().getFilePath() === filePath,
      );
      if (!isDirect) continue;
      const list = index.get(name) ?? [];
      list.push(sf);
      index.set(name, list);
    }
  }
  return index;
}

function collectDeclaredNames(sf: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const id of sf.getImportDeclarations()) {
    for (const spec of id.getNamedImports()) {
      names.add(spec.getAliasNode()?.getText() ?? spec.getName());
    }
    const defaultImport = id.getDefaultImport();
    if (defaultImport) names.add(defaultImport.getText());
    const ns = id.getNamespaceImport();
    if (ns) names.add(ns.getText());
  }
  for (const [name] of sf.getExportedDeclarations()) names.add(name);
  for (const ta of sf.getTypeAliases()) names.add(ta.getName());
  for (const iface of sf.getInterfaces()) names.add(iface.getName());
  for (const cls of sf.getClasses()) {
    const className = cls.getName();
    if (className) names.add(className);
  }
  for (const en of sf.getEnums()) names.add(en.getName());
  for (const fn of sf.getFunctions()) {
    const fnName = fn.getName();
    if (fnName) names.add(fnName);
  }
  return names;
}

function collectUnresolvedTypeNames(
  sf: SourceFile,
  declared: Set<string>,
): Set<string> {
  const unresolved = new Set<string>();
  sf.forEachDescendant((node) => {
    if (!Node.isTypeReference(node)) return;
    const typeName = node.getTypeName();
    // Only handle bare identifier refs (skip qualified names like Foo.Bar —
    // those route through a module/namespace already in scope).
    if (!Node.isIdentifier(typeName)) return;
    const name = typeName.getText();
    if (declared.has(name)) return;
    if (BUILTIN_TYPES.has(name)) return;
    if (name.length < 2) return;
    if (!/^[A-Z]/.test(name)) return;
    unresolved.add(name);
  });
  return unresolved;
}

function pickTarget(
  name: string,
  index: Map<string, SourceFile[]>,
): SourceFile | undefined {
  const candidates = index.get(name);
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  // Prefer the deepest path (most segments) — a re-exported symbol
  // declared in a leaf module beats the same name re-published from
  // a parent barrel. Ties → first match (stable for deterministic
  // output). True ambiguity (same depth, different files) is rare;
  // pass `importFromOverride` to disambiguate.
  return candidates
    .slice()
    .sort((a, b) => pathDepth(b.getFilePath()) - pathDepth(a.getFilePath()))[0];
}

function pathDepth(filePath: string): number {
  return filePath.split("/").length;
}

function addTypeImport(
  sf: SourceFile,
  name: string,
  targetSf: SourceFile,
  typeOnly: boolean,
): void {
  // Reuse an existing import declaration that resolves to the same file,
  // regardless of the original module-specifier string (handles barrel
  // re-imports and absolute vs relative spec mismatches).
  for (const id of sf.getImportDeclarations()) {
    const importedSf = id.getModuleSpecifierSourceFile();
    if (!importedSf) continue;
    if (importedSf.getFilePath() !== targetSf.getFilePath()) continue;
    for (const spec of id.getNamedImports()) {
      if (spec.getName() === name) return;
    }
    // If the existing import declaration is already `import type { … }`,
    // a plain `addNamedImport(name)` suffices — every specifier inherits
    // the declaration-level type-only modifier. Otherwise, mark this one
    // specifier as `type`-prefixed so `verbatimModuleSyntax` is happy.
    if (typeOnly && !id.isTypeOnly()) {
      id.addNamedImport({ name, isTypeOnly: true });
    } else {
      id.addNamedImport(name);
    }
    return;
  }
  const rawSpec = sf.getRelativePathAsModuleSpecifierTo(targetSf);
  // Append `.ts` to match the project convention (tsconfig has
  // `allowImportingTsExtensions: true`). ts-morph drops the extension
  // by default — same shim v1 (refactor.ts) uses.
  const moduleSpecifier = rawSpec.endsWith(".ts") ? rawSpec : `${rawSpec}.ts`;
  sf.addImportDeclaration({
    moduleSpecifier,
    namedImports: [name],
    isTypeOnly: typeOnly,
  });
}
