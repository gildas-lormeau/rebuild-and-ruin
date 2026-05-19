/**
 * Audit: `Map<K,V>` built from `Object.entries(Record)` whose every use has
 * a direct Record equivalent — the Map is dead ceremony.
 *
 * Pattern (module-scope):
 *
 *   const REG = new Map(Object.entries(RECORD));            // basic
 *   const REG = new Map(Object.entries(RECORD) as [K,V][]); // with cast
 *   const REG = new Map<K,V>(Object.entries(RECORD));       // with type args
 *
 * Classified DEFINITELY_DEAD when every use is one of:
 *   - `.values()` / `.entries()` / `.keys()` / `.forEach(...)` / `.size`
 *   - `for (... of REG)`
 * (All have direct `Object.values/entries/keys` / `Object.keys(R).length` /
 * `for-in` equivalents on the source Record.)
 *
 * Classified LIKELY_DEAD when the above is true AND `.get(k)` / `.has(k)` is
 * also present — `R[k]` / `k in R` are the replacements, with one caveat:
 * `R[k]` returns `V | undefined` only if `k` is widened to `string`. The
 * cast at `new Map(... as [K,V][])` already lies about the key type, so
 * the equivalence is exact in practice.
 *
 * Skipped (NOT_DEAD):
 *   - `.set` / `.delete` / `.clear` — Record mutation isn't the goal here
 *   - Passed as a value (`fn(REG)`, `[...REG]`, aliased) — unknown downstream
 *
 * AUDIT-ONLY: no baseline, no exit code.
 *
 * Usage:
 *   deno run -A scripts/audit-dead-map-from-record.ts [options]
 *
 * Options:
 *   --server         Include server/ files
 *   --test           Include test/ files
 *   --json           Emit JSON
 *   --filter=<re>    Only show findings whose file path matches the regex
 */

import process from "node:process";
import {
  type Identifier,
  type NewExpression,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";

type Classification = "DEFINITELY_DEAD" | "LIKELY_DEAD";

interface Finding {
  file: string;
  line: number;
  name: string;
  source: string;
  classification: Classification;
  uses: Record<string, number>;
}

main();

function main(): void {
  const args = process.argv.slice(2);
  const includeServer = args.includes("--server");
  const includeTest = args.includes("--test");
  const json = args.includes("--json");
  const filterArg = args.find((a) => a.startsWith("--filter="));
  const filter = filterArg
    ? new RegExp(filterArg.slice("--filter=".length))
    : null;

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const globs = ["src/**/*.ts"];
  if (includeServer) globs.push("server/**/*.ts");
  if (includeTest) globs.push("test/**/*.ts");
  for (const gl of globs) project.addSourceFilesAtPaths(gl);

  const findings: Finding[] = [];
  for (const sf of project.getSourceFiles()) {
    const relPath = sf.getFilePath().replace(`${process.cwd()}/`, "");
    if (relPath.startsWith("dist/")) continue;
    if (filter && !filter.test(relPath)) continue;
    auditFile(sf, relPath, findings);
  }

  if (json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  const fileCount = project.getSourceFiles().length;
  if (findings.length === 0) {
    console.log(
      `✔ No dead Map-from-Record patterns (${fileCount} files audited)`,
    );
    return;
  }

  console.log(
    `Audited ${fileCount} files; ${findings.length} dead Map-from-Record pattern(s):\n`,
  );
  findings.sort(
    (a, b) =>
      a.classification.localeCompare(b.classification) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  for (const f of findings) {
    const usesStr = Object.entries(f.uses)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`  ${f.file}:${f.line}  ${f.classification}`);
    console.log(`    const ${f.name} = new Map(Object.entries(${f.source}))`);
    console.log(`    uses: ${usesStr}`);
    console.log();
  }
}

function auditFile(sf: SourceFile, relPath: string, findings: Finding[]): void {
  for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.NewExpression) continue;
    const newExpr = init.asKindOrThrow(SyntaxKind.NewExpression);
    if (newExpr.getExpression().getText() !== "Map") continue;
    const sourceName = extractRecordSource(newExpr);
    if (!sourceName) continue;
    const nameNode = vd.getNameNode();
    if (nameNode.getKind() !== SyntaxKind.Identifier) continue;
    const finding = classifyUses(
      nameNode.asKindOrThrow(SyntaxKind.Identifier),
      vd,
      relPath,
      sourceName,
    );
    if (finding) findings.push(finding);
  }
}

function extractRecordSource(newExpr: NewExpression): string | null {
  const args = newExpr.getArguments();
  if (args.length !== 1) return null;
  let arg: Node | undefined = args[0];
  while (arg && arg.getKind() === SyntaxKind.AsExpression) {
    arg = arg.asKindOrThrow(SyntaxKind.AsExpression).getExpression();
  }
  if (!arg || arg.getKind() !== SyntaxKind.CallExpression) return null;
  const call = arg.asKindOrThrow(SyntaxKind.CallExpression);
  if (call.getExpression().getText() !== "Object.entries") return null;
  const innerArgs = call.getArguments();
  if (innerArgs.length !== 1) return null;
  const inner = innerArgs[0];
  if (!inner || inner.getKind() !== SyntaxKind.Identifier) return null;
  return inner.getText();
}

function classifyUses(
  nameNode: Identifier,
  selfDecl: VariableDeclaration,
  file: string,
  source: string,
): Finding | null {
  const refs = nameNode.findReferencesAsNodes();
  const uses: Record<string, number> = {};
  let hasBadUse = false;
  let hasLookup = false;
  let refCount = 0;

  const declStart = selfDecl.getStart();
  const declFile = selfDecl.getSourceFile().getFilePath();

  for (const ref of refs) {
    // skip the declaration's own name node
    if (
      ref.getSourceFile().getFilePath() === declFile &&
      ref.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getStart() ===
        declStart
    ) {
      continue;
    }

    const parent = ref.getParent();
    if (!parent) {
      refCount++;
      hasBadUse = true;
      uses.UNKNOWN = (uses.UNKNOWN ?? 0) + 1;
      continue;
    }
    const kind = parent.getKind();

    // Import/export specifiers re-bind the name but aren't a "use" of the
    // value. The real uses are at the call sites in the consumer file,
    // which findReferencesAsNodes() already enumerates separately.
    if (
      kind === SyntaxKind.ImportSpecifier ||
      kind === SyntaxKind.ImportClause ||
      kind === SyntaxKind.NamespaceImport ||
      kind === SyntaxKind.ExportSpecifier
    ) {
      continue;
    }
    refCount++;

    if (kind === SyntaxKind.PropertyAccessExpression) {
      const pa = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const propName = pa.getName();
      const grand = pa.getParent();
      const isMethodCall =
        grand?.getKind() === SyntaxKind.CallExpression &&
        grand.asKindOrThrow(SyntaxKind.CallExpression).getExpression() === pa;

      if (isMethodCall) {
        if (
          propName === "values" ||
          propName === "entries" ||
          propName === "keys" ||
          propName === "forEach"
        ) {
          uses[propName] = (uses[propName] ?? 0) + 1;
          continue;
        }
        if (propName === "get" || propName === "has") {
          uses[propName] = (uses[propName] ?? 0) + 1;
          hasLookup = true;
          continue;
        }
        // .set, .delete, .clear, anything else
        uses[propName] = (uses[propName] ?? 0) + 1;
        hasBadUse = true;
        continue;
      }
      // property read (no call)
      if (propName === "size") {
        uses.size = (uses.size ?? 0) + 1;
        continue;
      }
      uses[propName] = (uses[propName] ?? 0) + 1;
      hasBadUse = true;
      continue;
    }

    if (kind === SyntaxKind.ForOfStatement) {
      uses["for-of"] = (uses["for-of"] ?? 0) + 1;
      continue;
    }

    // Aliased, spread, passed as argument, etc.
    uses.OTHER = (uses.OTHER ?? 0) + 1;
    hasBadUse = true;
  }

  if (refCount === 0) return null;
  if (hasBadUse) return null;

  return {
    file,
    line: selfDecl.getStartLineNumber(),
    name: selfDecl.getName(),
    source,
    classification: hasLookup ? "LIKELY_DEAD" : "DEFINITELY_DEAD",
    uses,
  };
}
