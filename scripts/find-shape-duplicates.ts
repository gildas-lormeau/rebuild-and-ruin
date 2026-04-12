/**
 * Detect structurally duplicate type/interface declarations.
 *
 * LLM agents frequently redeclare types instead of importing them. jscpd
 * catches verbatim clones, but misses same-shape types with different names
 * or field order. This script normalizes every interface/type-literal shape
 * to a canonical string, then reports duplicates and high-overlap pairs.
 *
 * Usage:
 *   deno run -A scripts/find-shape-duplicates.ts [options]
 *
 * Options:
 *   --server            Include server/ files
 *   --min-fields N      Minimum fields to consider (default: 3)
 *   --overlap N         Minimum overlap ratio 0-1 for subset detection (default: 0.8)
 *   --exact-only        Only report exact shape duplicates (no overlap pairs)
 *   --update-baseline   Write current overlap pairs to baseline file
 *   --json              Output as JSON
 */

import fs from "node:fs";
import process from "node:process";
import { Project, SyntaxKind, type TypeElementTypes } from "ts-morph";

interface ShapeEntry {
  name: string;
  file: string;
  line: number;
  fields: string[];
  hash: string;
  layer: number;
  exported: boolean;
}

interface DuplicateEntry {
  name: string;
  file: string;
  line: number;
}

interface Duplicate {
  kind: "exact" | "subset";
  entries: DuplicateEntry[];
  overlap?: number;
  fields: string[];
}

/** An inline object literal in a signature that matches a named export. */
interface InlineMatch {
  file: string;
  line: number;
  /** Description of where the inline literal lives (e.g. "param opts of doThing"). */
  context: string;
  /** The named type it should use instead. */
  canonical: { name: string; file: string };
  fields: string[];
}

interface BaselineEntry {
  pair: string;
}

interface InlineBaselineEntry {
  /** file:line → canonicalName key */
  key: string;
}

interface BaselineFile {
  overlaps: BaselineEntry[];
  inline: InlineBaselineEntry[];
}

interface LayerGroup {
  name: string;
  files: string[];
}

const args = process.argv.slice(2);
const includeServer = args.includes("--server");
const jsonOutput = args.includes("--json");
const exactOnly = args.includes("--exact-only");
const updateBaseline = args.includes("--update-baseline");
const minFieldsIdx = args.indexOf("--min-fields");
const minFields = minFieldsIdx >= 0 ? Number(args[minFieldsIdx + 1]) : 3;
const overlapIdx = args.indexOf("--overlap");
const overlapThreshold = overlapIdx >= 0 ? Number(args[overlapIdx + 1]) : 0.8;
const BASELINE_FILE = ".shape-duplicates-baseline.json";
const layerMap = loadLayerMap();
const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});
const globs = ["src/**/*.ts"];
const shapes: ShapeEntry[] = [];
const byHash = new Map<string, ShapeEntry[]>();
const exactDuplicates: Duplicate[] = [];
/** Map from hash → canonical ShapeEntry for suggestion messages. */
const canonicalByHash = new Map<string, ShapeEntry>();
const overlapDuplicates: Duplicate[] = [];
/** Index of exported named shapes by hash → best canonical. */
const exportedByHash = new Map<string, ShapeEntry>();
const inlineMatches: InlineMatch[] = [];
const inlineBaseline = loadBaseline().inline;

/** Build a file→layer-index map from .import-layers.json. */
function loadLayerMap(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const raw = fs.readFileSync(".import-layers.json", "utf-8");
    const layers: LayerGroup[] = JSON.parse(raw);
    for (let li = 0; li < layers.length; li++) {
      for (const file of layers[li].files) {
        map.set(file, li);
      }
    }
  } catch {
    // no layer file — all layers default to Infinity
  }
  return map;
}

if (includeServer) globs.push("server/**/*.ts");

for (const gl of globs) project.addSourceFilesAtPaths(gl);

for (const sourceFile of project.getSourceFiles()) {
  const relPath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");

  for (const decl of sourceFile.getInterfaces()) {
    const members = decl.getMembers();
    const fields = members
      .map((m) => normalizeMember(m as TypeElementTypes))
      .filter((f): f is string => f !== null)
      .sort();

    if (fields.length < minFields) continue;

    shapes.push({
      name: decl.getName(),
      file: relPath,
      line: decl.getStartLineNumber(),
      fields,
      hash: fields.join(";"),
      layer: layerMap.get(relPath) ?? Number.POSITIVE_INFINITY,
      exported: decl.isExported(),
    });
  }

  for (const decl of sourceFile.getTypeAliases()) {
    const typeNode = decl.getTypeNode();
    if (!typeNode || !typeNode.isKind(SyntaxKind.TypeLiteral)) continue;

    const members = typeNode.getMembers();
    const fields = members
      .map((m) => normalizeMember(m as TypeElementTypes))
      .filter((f): f is string => f !== null)
      .sort();

    if (fields.length < minFields) continue;

    shapes.push({
      name: decl.getName(),
      file: relPath,
      line: decl.getStartLineNumber(),
      fields,
      hash: fields.join(";"),
      layer: layerMap.get(relPath) ?? Number.POSITIVE_INFINITY,
      exported: decl.isExported(),
    });
  }
}

for (const shape of shapes) {
  const group = byHash.get(shape.hash) ?? [];
  group.push(shape);
  byHash.set(shape.hash, group);
}

for (const [hash, group] of byHash) {
  if (group.length < 2) continue;
  const canonical = pickCanonical(group);
  // Skip groups where no non-canonical entry can import the canonical
  // (its layer is ≤ canonical's layer — would violate import direction).
  const actionable = group.some(
    (en) =>
      (en.file !== canonical.file || en.line !== canonical.line) &&
      en.layer > canonical.layer,
  );
  if (!actionable) continue;
  canonicalByHash.set(hash, canonical);
  exactDuplicates.push({
    kind: "exact",
    entries: group.map((en) => ({
      name: en.name,
      file: en.file,
      line: en.line,
    })),
    fields: group[0].fields,
  });
}

/**
 * Pick the canonical entry from an exact-duplicate group.
 * Prefer: exported > non-exported, then lowest layer, then shortest file path.
 */
function pickCanonical(entries: ShapeEntry[]): ShapeEntry {
  return entries.toSorted((ea, eb) => {
    if (ea.exported !== eb.exported) return ea.exported ? -1 : 1;
    if (ea.layer !== eb.layer) return ea.layer - eb.layer;
    return ea.file.length - eb.file.length;
  })[0];
}

for (const shape of shapes) {
  if (!shape.exported) continue;
  const existing = exportedByHash.get(shape.hash);
  if (!existing || shape.layer < existing.layer) {
    exportedByHash.set(shape.hash, shape);
  }
}

for (const sourceFile of project.getSourceFiles()) {
  const relPath = sourceFile.getFilePath().replace(`${process.cwd()}/`, "");
  const fileLayer = layerMap.get(relPath) ?? Number.POSITIVE_INFINITY;

  // Walk all TypeLiteral nodes in the file
  sourceFile.forEachDescendant((node) => {
    if (!node.isKind(SyntaxKind.TypeLiteral)) return;

    // Skip if this is the direct type node of an interface or type alias
    // (already handled by pass 1)
    const parent = node.getParent();
    if (
      parent &&
      (parent.isKind(SyntaxKind.TypeAliasDeclaration) ||
        parent.isKind(SyntaxKind.InterfaceDeclaration))
    ) {
      return;
    }

    const fields = extractTypeLiteralFields(node);
    if (!fields) return;

    const hash = fields.join(";");
    const canonical = exportedByHash.get(hash);
    if (!canonical) return;

    // Skip if file can't import canonical (lower layer than canonical)
    if (fileLayer < canonical.layer) return;

    // Skip self-file matches (inline literal inside its own type's file)
    if (relPath === canonical.file) return;

    const matchKey = `${relPath}:${node.getStartLineNumber()} → ${canonical.name}`;
    // Skip baselined inline matches
    if (!updateBaseline && inlineBaseline.has(matchKey)) return;

    // Build context description
    let context = "inline type literal";
    if (parent?.isKind(SyntaxKind.Parameter)) {
      const paramName = parent.getName();
      const fn = parent.getParent();
      if (fn && "getName" in fn && typeof fn.getName === "function") {
        context = `param "${paramName}" of ${fn.getName()}()`;
      } else {
        context = `param "${paramName}"`;
      }
    } else if (
      parent?.isKind(SyntaxKind.FunctionDeclaration) ||
      parent?.isKind(SyntaxKind.MethodDeclaration) ||
      parent?.isKind(SyntaxKind.ArrowFunction)
    ) {
      // Return type position
      if ("getName" in parent && typeof parent.getName === "function") {
        context = `return type of ${parent.getName()}()`;
      } else {
        context = "return type";
      }
    } else if (parent?.isKind(SyntaxKind.PropertySignature)) {
      context = `property "${parent.getName()}"`;
    }

    inlineMatches.push({
      file: relPath,
      line: node.getStartLineNumber(),
      context,
      canonical: { name: canonical.name, file: canonical.file },
      fields,
    });
  });
}

/**
 * Extract normalized fields from a TypeLiteral node.
 * Returns null if fewer than minFields members or not a TypeLiteral.
 */
function extractTypeLiteralFields(
  node: import("ts-morph").TypeLiteralNode,
): string[] | null {
  const members = node.getMembers();
  const fields = members
    .map((m) => normalizeMember(m as TypeElementTypes))
    .filter((f): f is string => f !== null)
    .sort();
  return fields.length >= minFields ? fields : null;
}

/** Normalize a single member to a canonical string (name + type text). */
function normalizeMember(member: TypeElementTypes): string | null {
  if (member.isKind(SyntaxKind.PropertySignature)) {
    const name = member.getName();
    const typeText = member.getTypeNode()?.getText() ?? "unknown";
    const optional = member.hasQuestionToken() ? "?" : "";
    return `${name}${optional}:${typeText}`;
  }
  if (member.isKind(SyntaxKind.MethodSignature)) {
    const name = member.getName();
    const params = member
      .getParameters()
      .map((pm) => {
        const pName = pm.getName();
        const pType = pm.getTypeNode()?.getText() ?? "unknown";
        return `${pName}:${pType}`;
      })
      .join(",");
    const ret = member.getReturnTypeNode()?.getText() ?? "void";
    return `${name}(${params}):${ret}`;
  }
  return null;
}

if (!exactOnly) {
  const exactKeys = new Set(
    exactDuplicates.flatMap((d) =>
      d.entries.map((en) => `${en.file}:${en.line}`),
    ),
  );

  const representatives: ShapeEntry[] = [];
  for (const shape of shapes) {
    if (!exactKeys.has(`${shape.file}:${shape.line}`)) {
      representatives.push(shape);
    }
  }
  for (const dup of exactDuplicates) {
    const en = dup.entries[0];
    const shape = shapes.find(
      (sh) => sh.file === en.file && sh.line === en.line,
    );
    if (shape) representatives.push(shape);
  }

  const baseline = loadBaseline();

  for (let idx = 0; idx < representatives.length; idx++) {
    const shapeA = representatives[idx];
    const setA = new Set(shapeA.fields);

    for (let jdx = idx + 1; jdx < representatives.length; jdx++) {
      const shapeB = representatives[jdx];
      if (shapeA.hash === shapeB.hash) continue;

      const setB = new Set(shapeB.fields);
      const intersection = shapeA.fields.filter((fl) => setB.has(fl));
      const smaller = Math.min(setA.size, setB.size);
      const overlap = intersection.length / smaller;

      if (overlap >= overlapThreshold && intersection.length >= minFields) {
        const key = pairKey(shapeA, shapeB);
        if (!updateBaseline && baseline.overlaps.has(key)) continue;

        overlapDuplicates.push({
          kind: "subset",
          entries: [
            { name: shapeA.name, file: shapeA.file, line: shapeA.line },
            { name: shapeB.name, file: shapeB.file, line: shapeB.line },
          ],
          overlap: Math.round(overlap * 100) / 100,
          fields: intersection.sort(),
        });
      }
    }
  }
}

function loadBaseline(): { overlaps: Set<string>; inline: Set<string> } {
  try {
    const raw = fs.readFileSync(BASELINE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    // Support both old format (array of {pair}) and new format ({overlaps, inline})
    if (Array.isArray(parsed)) {
      return {
        overlaps: new Set(parsed.map((en: BaselineEntry) => en.pair)),
        inline: new Set(),
      };
    }
    const file = parsed as BaselineFile;
    return {
      overlaps: new Set((file.overlaps ?? []).map((en) => en.pair)),
      inline: new Set((file.inline ?? []).map((en) => en.key)),
    };
  } catch {
    return { overlaps: new Set(), inline: new Set() };
  }
}

if (updateBaseline) {
  const overlapEntries: BaselineEntry[] = overlapDuplicates.map((dup) => ({
    pair: pairKey(dup.entries[0], dup.entries[1]),
  }));
  overlapEntries.sort((en1, en2) => en1.pair.localeCompare(en2.pair));
  const inlineEntries: InlineBaselineEntry[] = inlineMatches.map((match) => ({
    key: inlineKey(match),
  }));
  inlineEntries.sort((en1, en2) => en1.key.localeCompare(en2.key));
  const baselineFile: BaselineFile = {
    overlaps: overlapEntries,
    inline: inlineEntries,
  };
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(baselineFile, null, 2)}\n`);
  console.log(
    `Wrote ${overlapEntries.length} overlap pairs + ${inlineEntries.length} inline matches to ${BASELINE_FILE}`,
  );
  process.exit(0);
}

function inlineKey(match: InlineMatch): string {
  return `${match.file}:${match.line} → ${match.canonical.name}`;
}

function pairKey(entryA: DuplicateEntry, entryB: DuplicateEntry): string {
  const keyA = `${entryA.name}@${entryA.file}`;
  const keyB = `${entryB.name}@${entryB.file}`;
  return keyA < keyB ? `${keyA} ↔ ${keyB}` : `${keyB} ↔ ${keyA}`;
}

if (jsonOutput) {
  console.log(
    JSON.stringify(
      {
        exact: exactDuplicates,
        overlap: overlapDuplicates,
        inline: inlineMatches,
      },
      null,
      2,
    ),
  );
} else {
  if (!hasIssues()) {
    console.log("No shape duplicates found.");
    process.exit(0);
  }

  if (exactDuplicates.length > 0) {
    console.log(
      `\n=== Exact shape duplicates (${exactDuplicates.length}) ===\n`,
    );
    for (const dup of exactDuplicates) {
      const canonical = canonicalByHash.get(dup.fields.sort().join(";"));
      console.log(`  Fields (${dup.fields.length}):`);
      for (const fl of dup.fields) console.log(`    ${fl}`);
      console.log("  Declared in:");
      for (const en of dup.entries) {
        const isCanonical =
          canonical && en.file === canonical.file && en.line === canonical.line;
        const tag = isCanonical
          ? " ← canonical (L" + canonical.layer + ")"
          : "";
        console.log(`    ${en.name}  ${en.file}:${en.line}${tag}`);
      }
      if (canonical) {
        const others = dup.entries.filter(
          (en) => en.file !== canonical.file || en.line !== canonical.line,
        );
        for (const other of others) {
          console.log(
            `  → ${other.name} (${other.file}:${other.line}) should import ${canonical.name} from "${canonical.file}"`,
          );
        }
      }
      console.log();
    }
  }

  if (inlineMatches.length > 0) {
    console.log(
      `\n=== Inline literals matching named exports (${inlineMatches.length}) ===\n`,
    );
    for (const match of inlineMatches) {
      console.log(`  ${match.file}:${match.line}  ${match.context}`);
      console.log(
        `  → use ${match.canonical.name} from "${match.canonical.file}"`,
      );
      console.log();
    }
  }

  if (overlapDuplicates.length > 0) {
    console.log(
      `\n=== New overlap pairs (${overlapDuplicates.length}, ≥${overlapThreshold * 100}%) ===\n`,
    );
    for (const dup of overlapDuplicates) {
      const [entryA, entryB] = dup.entries;
      console.log(
        `  ${entryA.name} (${entryA.file}:${entryA.line}) ↔ ${entryB.name} (${entryB.file}:${entryB.line})`,
      );
      console.log(
        `  Overlap: ${(dup.overlap! * 100).toFixed(0)}% — ${dup.fields.length} shared fields`,
      );
      console.log();
    }
  }

  const total =
    exactDuplicates.reduce((n, d) => n + d.entries.length, 0) +
    overlapDuplicates.length +
    inlineMatches.length;
  console.log(
    `Total: ${exactDuplicates.length} exact groups, ${inlineMatches.length} inline matches, ${overlapDuplicates.length} new overlap pairs (${total} locations)`,
  );
}

process.exit(hasIssues() ? 1 : 0);

function hasIssues(): boolean {
  return (
    exactDuplicates.length > 0 ||
    overlapDuplicates.length > 0 ||
    inlineMatches.length > 0
  );
}
