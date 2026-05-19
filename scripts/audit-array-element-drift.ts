/**
 * Audit collection declarations whose every write provides the SAME
 * branded subtype of the declared element type. The declaration could be
 * tightened to the brand without changing any callsite.
 *
 * Catches the "I'll cast each push site individually" pattern LLMs fall
 * into when adopting a brand: the collection stays wide (`number[]`,
 * `Set<number>`, `Map<number, _>`) while every push wraps a brand cast.
 *
 * Detection:
 *   For each local / property declared with one of these container shapes
 *   where the element type is `number`:
 *     - Array  : `T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>`
 *     - Set    : `Set<T>`, `ReadonlySet<T>`
 *     - Map    : `Map<K, V>`, `ReadonlyMap<K, V>` (key + value reported
 *                separately)
 *
 *   Find every write site:
 *     arrays:  .push(x), .unshift(x), [i] = x, initializer = [a, b]
 *     sets:    .add(x), constructor `new Set([a, b])`
 *     maps:    .set(k, v), constructor `new Map([[k, v]])`
 *
 *   For each value written, take its static type. If every write
 *   provides the SAME type whose text differs from `number` but is
 *   assignable to `number`, suggest tightening to that text.
 *
 * AUDIT-ONLY: no baseline, no exit code logic. Heuristic — false positives
 * possible at trust boundaries (wire deserialize uses raw `number[]`).
 *
 * Output (default): human-readable, grouped by suggested target type.
 * Output (--json): JSON array.
 *
 * Usage:
 *   deno run -A scripts/audit-array-element-drift.ts [options]
 *
 * Options:
 *   --server         Include server/ files
 *   --test           Include test/ files
 *   --json           Emit JSON
 *   --filter=<re>    Only show findings whose file path matches the regex
 *   --min-writes=N   Require at least N writes (default 1)
 */

import process from "node:process";
import {
  type CallExpression,
  type Identifier,
  type NewExpression,
  type Node,
  Project,
  SyntaxKind,
  type Type,
} from "ts-morph";

type ContainerKind = "array" | "set" | "map-key" | "map-value";

interface WriteSite {
  file: string;
  line: number;
  snippet: string;
  valueTypeText: string;
}

interface Finding {
  file: string;
  line: number;
  declaration: string;
  container: ContainerKind;
  currentElementText: string;
  suggestedElementText: string;
  writeCount: number;
  writes: WriteSite[];
}

interface ContainerSlot {
  slot: ContainerKind;
  currentText: string;
}

interface CollectedWrite {
  file: string;
  line: number;
  snippet: string;
  valueTypeText: string;
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
  const minWritesArg = args.find((a) => a.startsWith("--min-writes="));
  const minWrites = minWritesArg
    ? parseInt(minWritesArg.slice("--min-writes=".length), 10)
    : 1;

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

    // Variable declarations (locals + const decls)
    for (const node of sf.getDescendantsOfKind(
      SyntaxKind.VariableDeclaration,
    )) {
      collectFromDeclaration(node, relPath, findings);
    }
    // Property declarations (class fields)
    for (const node of sf.getDescendantsOfKind(
      SyntaxKind.PropertyDeclaration,
    )) {
      collectFromDeclaration(node, relPath, findings);
    }
    // Property signatures (interface / type-alias members)
    for (const node of sf.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
      collectFromDeclaration(node, relPath, findings);
    }
  }

  const filtered = findings.filter((f) => f.writeCount >= minWrites);

  if (json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  const fileCount = project.getSourceFiles().length;
  if (filtered.length === 0) {
    console.log(`✔ No array-element drift found (${fileCount} files audited)`);
    return;
  }

  console.log(
    `Audited ${fileCount} files; ${filtered.length} drifted container(s):\n`,
  );

  filtered.sort(
    (a, b) =>
      a.suggestedElementText.localeCompare(b.suggestedElementText) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  let lastSuggested = "";
  for (const f of filtered) {
    if (f.suggestedElementText !== lastSuggested) {
      console.log(
        `\n── ${f.currentElementText} → ${f.suggestedElementText} ──────────────────────`,
      );
      lastSuggested = f.suggestedElementText;
    }
    console.log(
      `  ${f.file}:${f.line}  ${f.declaration} (${f.container}, ${f.writeCount} write${f.writeCount === 1 ? "" : "s"})`,
    );
    for (const w of f.writes.slice(0, 3)) {
      console.log(`    ${w.file}:${w.line}  ${truncate(w.snippet, 64)}`);
    }
    if (f.writes.length > 3) {
      console.log(`    ... and ${f.writes.length - 3} more`);
    }
  }
  console.log("");
}

function collectFromDeclaration(
  node: Node,
  file: string,
  out: Finding[],
): void {
  // We need to read the declaration's type and identifier. Each declaration
  // kind exposes these via slightly different APIs; handle them uniformly.
  const ident = getDeclarationIdentifier(node);
  if (!ident) return;
  const declType = ident.getType();
  if (!declType) return;

  const containers = classifyContainer(declType);
  if (containers.length === 0) return;

  const name = ident.getText();
  const refs = ident.findReferencesAsNodes();
  // The identifier in its own declaration is included; filter it out by
  // referring back to the declaration node's identifier directly.
  const declIdentText = `${file}:${ident.getStartLineNumber()}`;

  for (const container of containers) {
    const writes = collectWrites(node, refs, container.slot);
    if (writes.length === 0) continue;

    // Compute the common narrower type among all writes.
    const suggestion = findCommonBrand(writes, container.currentText);
    if (!suggestion) continue;

    out.push({
      file,
      line: ident.getStartLineNumber(),
      declaration: `${name}: ${describeContainer(container)}`,
      container: container.slot,
      currentElementText: container.currentText,
      suggestedElementText: suggestion,
      writeCount: writes.length,
      writes: writes.map((w) => ({
        file: w.file,
        line: w.line,
        snippet: w.snippet,
        valueTypeText: w.valueTypeText,
      })),
    });
  }
  // Suppress unused: kept for future per-finding deduping.
  void declIdentText;
}

/** Inspect the declared type and return one slot per element position
 *  that's currently `number`. Returns [] if the type isn't a tracked
 *  container shape or the element type is not `number`. */
function classifyContainer(t: Type): ContainerSlot[] {
  // Array: T[] / ReadonlyArray<T>
  if (t.isArray() || t.isReadonlyArray()) {
    const elementType = t.getArrayElementType();
    if (!elementType) return [];
    const text = elementType.getText();
    if (text === "number") {
      return [{ slot: "array", currentText: text }];
    }
    return [];
  }

  // Set / ReadonlySet / Map / ReadonlyMap — detect via symbol + type args
  const symName = t.getSymbol()?.getName() ?? t.getAliasSymbol()?.getName();
  if (!symName) return [];

  const isSet = symName === "Set" || symName === "ReadonlySet";
  const isMap = symName === "Map" || symName === "ReadonlyMap";
  if (!isSet && !isMap) return [];

  const typeArgs = t.getTypeArguments();
  if (isSet && typeArgs.length === 1) {
    const text = typeArgs[0]!.getText();
    if (text === "number") return [{ slot: "set", currentText: text }];
    return [];
  }
  if (isMap && typeArgs.length === 2) {
    const out: ContainerSlot[] = [];
    const keyText = typeArgs[0]!.getText();
    const valueText = typeArgs[1]!.getText();
    if (keyText === "number") {
      out.push({ slot: "map-key", currentText: keyText });
    }
    if (valueText === "number") {
      out.push({ slot: "map-value", currentText: valueText });
    }
    return out;
  }

  return [];
}

function describeContainer(c: ContainerSlot): string {
  switch (c.slot) {
    case "array":
      return `${c.currentText}[]`;
    case "set":
      return `Set<${c.currentText}>`;
    case "map-key":
      return `Map<${c.currentText}, _>`;
    case "map-value":
      return `Map<_, ${c.currentText}>`;
  }
}

/** Walk every reference to the declared identifier; treat each one whose
 *  expression context is a write (.push, .add, .set, index assignment, or
 *  the initializer of the declaration itself) as a write site. */
function collectWrites(
  declNode: Node,
  refs: Node[],
  slot: ContainerKind,
): CollectedWrite[] {
  const writes: CollectedWrite[] = [];
  const sf = declNode.getSourceFile();
  const declFile = sf.getFilePath().replace(`${process.cwd()}/`, "");

  // Initializer literal: `const x: T[] = [a, b, c]`, or `new Set<T>([...])`,
  // or `new Map<K, V>([[k, v]])`.
  const initWrites = collectInitializerWrites(declNode, declFile, slot);
  writes.push(...initWrites);

  for (const ref of refs) {
    const parent = ref.getParent();
    if (!parent) continue;

    // `.push(x)` / `.unshift(x)` / `.add(x)` / `.set(k, v)`
    if (parent.getKind() === SyntaxKind.PropertyAccessExpression) {
      const pae = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const methodName = pae.getName();
      const call = pae.getParent();
      if (!call || call.getKind() !== SyntaxKind.CallExpression) continue;
      const callExpr = call as CallExpression;
      const args = callExpr.getArguments();
      if (slot === "array") {
        if (methodName === "push" || methodName === "unshift") {
          for (const arg of args) addWrite(writes, declFile, arg);
        }
      } else if (slot === "set") {
        if (methodName === "add" && args.length >= 1) {
          addWrite(writes, declFile, args[0]!);
        }
      } else if (slot === "map-key") {
        if (methodName === "set" && args.length >= 1) {
          addWrite(writes, declFile, args[0]!);
        }
      } else if (slot === "map-value") {
        if (methodName === "set" && args.length >= 2) {
          addWrite(writes, declFile, args[1]!);
        }
      }
      continue;
    }

    // `arr[i] = x` — element assignment
    if (slot === "array") {
      if (parent.getKind() === SyntaxKind.ElementAccessExpression) {
        const eae = parent.asKindOrThrow(SyntaxKind.ElementAccessExpression);
        const assign = eae.getParent();
        if (assign && assign.getKind() === SyntaxKind.BinaryExpression) {
          const be = assign.asKindOrThrow(SyntaxKind.BinaryExpression);
          if (
            be.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
            be.getLeft() === eae
          ) {
            addWrite(writes, declFile, be.getRight());
          }
        }
      }
    }
  }

  return writes;
}

/** Initializer writes — array literal, or constructor argument. */
function collectInitializerWrites(
  declNode: Node,
  declFile: string,
  slot: ContainerKind,
): CollectedWrite[] {
  const out: CollectedWrite[] = [];
  let init: Node | undefined;
  if (declNode.getKind() === SyntaxKind.VariableDeclaration) {
    init = declNode
      .asKindOrThrow(SyntaxKind.VariableDeclaration)
      .getInitializer();
  } else if (declNode.getKind() === SyntaxKind.PropertyDeclaration) {
    init = declNode
      .asKindOrThrow(SyntaxKind.PropertyDeclaration)
      .getInitializer();
  }
  if (!init) return out;

  if (
    slot === "array" &&
    init.getKind() === SyntaxKind.ArrayLiteralExpression
  ) {
    const arr = init.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
    for (const el of arr.getElements()) {
      addWrite(out, declFile, el);
    }
    return out;
  }

  if (init.getKind() === SyntaxKind.NewExpression) {
    const ne = init.asKindOrThrow(SyntaxKind.NewExpression) as NewExpression;
    const args = ne.getArguments();
    if (args.length === 0) return out;
    const arg0 = args[0]!;
    if (arg0.getKind() !== SyntaxKind.ArrayLiteralExpression) return out;
    const arr = arg0.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
    const elements = arr.getElements();
    if (slot === "set") {
      for (const el of elements) addWrite(out, declFile, el);
    } else if (slot === "map-key" || slot === "map-value") {
      // `new Map([[k, v], [k, v]])` — pair literals.
      const pickIdx = slot === "map-key" ? 0 : 1;
      for (const el of elements) {
        if (el.getKind() !== SyntaxKind.ArrayLiteralExpression) continue;
        const pair = el.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
        const pairElements = pair.getElements();
        if (pickIdx < pairElements.length) {
          addWrite(out, declFile, pairElements[pickIdx]!);
        }
      }
    }
  }

  return out;
}

function addWrite(out: CollectedWrite[], file: string, node: Node): void {
  const t = node.getType();
  if (!t) return;
  out.push({
    file,
    line: node.getStartLineNumber(),
    snippet: node.getText().slice(0, 80).replace(/\s+/g, " "),
    valueTypeText: t.getText(node),
  });
}

/** Find a single brand text that every write provides — i.e. every write
 *  has the SAME valueTypeText, that text isn't equal to `currentText`, and
 *  it isn't `any` / `never` / `number` itself. */
function findCommonBrand(
  writes: CollectedWrite[],
  currentText: string,
): string | null {
  if (writes.length === 0) return null;
  const distinct = new Set<string>();
  for (const w of writes) {
    const txt = normalizeTypeText(w.valueTypeText);
    if (txt === "any" || txt === "never") return null;
    distinct.add(txt);
  }
  if (distinct.size !== 1) return null;
  const only = [...distinct][0]!;
  if (only === currentText) return null;
  if (only === "number") return null;
  // Don't suggest if it's a literal-number type or a union of literal
  // numbers — e.g. every write is `0`, or `tag` of type `0 | 1 | 2`. That's
  // a narrow inferred type, not a brand worth promoting to the container.
  if (/^-?\d+(?:\.\d+)?(?:\s*\|\s*-?\d+(?:\.\d+)?)*$/.test(only)) return null;
  return only;
}

/** Strip ts-morph quirks: it sometimes prefixes module-relative names for
 *  exported types when the declaration site is in a different file. We
 *  only care about the trailing identifier. */
function normalizeTypeText(text: string): string {
  // Examples this strips:  `import("/abs/path").TileKey` → `TileKey`.
  const m = text.match(/^import\([^)]+\)\.(.+)$/);
  return m ? m[1]! : text;
}

function getDeclarationIdentifier(node: Node): Identifier | undefined {
  if (node.getKind() === SyntaxKind.VariableDeclaration) {
    const name = node
      .asKindOrThrow(SyntaxKind.VariableDeclaration)
      .getNameNode();
    if (name.getKind() === SyntaxKind.Identifier) return name as Identifier;
    return undefined;
  }
  if (
    node.getKind() === SyntaxKind.PropertyDeclaration ||
    node.getKind() === SyntaxKind.PropertySignature
  ) {
    const name = (node as unknown as { getNameNode(): Node }).getNameNode();
    if (name && name.getKind() === SyntaxKind.Identifier) {
      return name as Identifier;
    }
    return undefined;
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
