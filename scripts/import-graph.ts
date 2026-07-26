/**
 * The architectural import graph — one implementation of the edge rule that
 * `.import-layers.json`, the layer lints and the layer audits all have to
 * agree on.
 *
 * A re-export (`export { x } from "./foo.ts"`) is routing, not a dependency.
 * The barrel does NOT gain an edge to its sources — that would push it above
 * its own consumers and make every consumer-of-barrel import look upward.
 * Instead an import of a re-exported symbol is forwarded past the barrel to
 * the file that declares it, which is where the architectural dependency
 * actually runs. Without forwarding, a barrel launders depth: `src/game/index.ts`
 * has no imports of its own, so it computes to L0 while re-exporting from
 * modules ten layers up.
 *
 * Any script that builds its own edge set straight from
 * `getImportDeclarations()` will disagree with the committed layer map — it
 * will report pins and consumers that the layer arithmetic contradicts. Use
 * this module instead.
 */

import path from "node:path";
import type { Project, SourceFile } from "ts-morph";

export interface ImportEdge {
  from: string;
  to: string;
  typeOnly: boolean;
  /** The module the importing file actually names, when forwarding moved the
   *  edge past a barrel. `undefined` for a direct import. */
  via: string | undefined;
  /** Imported specifier names routed to `to`. Empty for a default, namespace
   *  or side-effect import, which names the module rather than a symbol. */
  names: string[];
}

export interface ImportGraph {
  /** Every forwarded edge, in source-file order. */
  edges: ImportEdge[];
  /** Deduplicated dependency targets of `file`. */
  depsOf(file: string): Set<string>;
  /** Forwarded edges originating at `file`. */
  edgesFrom(file: string): ImportEdge[];
}

/**
 * @param tracked Keys of the files participating in the graph. Imports
 *   resolving outside this set (npm packages, untracked globs) are dropped.
 * @param rootDir Directory keys are relative to.
 */
export function buildImportGraph(
  project: Project,
  tracked: ReadonlySet<string>,
  rootDir: string,
): ImportGraph {
  const keyOf = (sourceFile: SourceFile): string =>
    path.relative(rootDir, sourceFile.getFilePath()).replace(/\\/g, "/");

  // Pass 1: index re-exports so pass 2 can forward past them.
  const reexportHomes = new Map<string, Map<string, string>>();
  for (const sourceFile of project.getSourceFiles()) {
    const from = keyOf(sourceFile);
    if (!tracked.has(from)) continue;
    for (const decl of sourceFile.getExportDeclarations()) {
      const resolved = decl.getModuleSpecifierSourceFile();
      if (resolved === undefined) continue;
      const to = keyOf(resolved);
      if (!tracked.has(to)) continue;
      let names = reexportHomes.get(from);
      if (names === undefined) {
        names = new Map();
        reexportHomes.set(from, names);
      }
      // `export { a as b } from "./x"` is imported by consumers as `b`, so
      // the alias is the key; each hop re-keys by the name it exposes.
      for (const named of decl.getNamedExports()) {
        names.set(named.getAliasNode()?.getText() ?? named.getName(), to);
      }
    }
  }

  /** Walk re-export hops until the file that declares `name` is reached. */
  const declaringFile = (module: string, name: string): string => {
    const seen = new Set<string>();
    let current = module;
    for (;;) {
      const next = reexportHomes.get(current)?.get(name);
      if (next === undefined || seen.has(current)) return current;
      seen.add(current);
      current = next;
    }
  };

  // Pass 2: import edges, forwarded past any barrel in the path.
  const edges: ImportEdge[] = [];
  const byFile = new Map<string, ImportEdge[]>();
  for (const sourceFile of project.getSourceFiles()) {
    const from = keyOf(sourceFile);
    if (!tracked.has(from)) continue;
    const fromEdges: ImportEdge[] = [];

    for (const imp of sourceFile.getImportDeclarations()) {
      const resolved = imp.getModuleSpecifierSourceFile();
      if (resolved === undefined) continue;
      const named = imp.getNamedImports();
      const declTypeOnly = imp.isTypeOnly();
      const module = keyOf(resolved);
      if (!tracked.has(module)) continue;

      // One target per resolved home. A target counts as type-only only when
      // every specifier reaching it is type-only.
      const targets = new Map<string, { typeOnly: boolean; names: string[] }>();
      const addTarget = (file: string, typeOnly: boolean, name?: string) => {
        const entry = targets.get(file) ?? { typeOnly: true, names: [] };
        entry.typeOnly &&= typeOnly;
        if (name !== undefined) entry.names.push(name);
        targets.set(file, entry);
      };
      // A default or namespace binding names the module itself, not a
      // symbol, so it cannot be forwarded.
      if (
        named.length === 0 ||
        imp.getDefaultImport() !== undefined ||
        imp.getNamespaceImport() !== undefined
      ) {
        addTarget(module, declTypeOnly);
      }
      for (const specifier of named) {
        const name = specifier.getName();
        addTarget(
          declaringFile(module, name),
          declTypeOnly || specifier.isTypeOnly(),
          name,
        );
      }

      for (const [to, entry] of targets) {
        // A barrel re-exporting a symbol back into its own source would
        // otherwise produce a self-edge, which is not a dependency.
        if (to === from) continue;
        fromEdges.push({
          from,
          to,
          typeOnly: entry.typeOnly,
          via: to === module ? undefined : module,
          names: entry.names,
        });
      }
    }

    byFile.set(from, fromEdges);
    edges.push(...fromEdges);
  }

  return {
    edges,
    depsOf: (file) => new Set((byFile.get(file) ?? []).map((edge) => edge.to)),
    edgesFrom: (file) => byFile.get(file) ?? [],
  };
}
