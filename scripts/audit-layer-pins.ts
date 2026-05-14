/**
 * For each file passed on the CLI (or a default candidate set), list its
 * imports annotated with layer + tier, sorted deepest-first. The top entry
 * is the "pin" — the import that determines the file's own layer.
 *
 * Usage:
 *   deno run -A scripts/audit-layer-pins.ts                          # default candidates
 *   deno run -A scripts/audit-layer-pins.ts src/runtime/foo.ts ...   # any files
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Project } from "ts-morph";
import { tierOfLayer } from "./cells/tier-of-layer.ts";

interface LayerGroup {
  name: string;
  files: string[];
}

interface ImportInfo {
  file: string;
  layer: number;
  group: string;
  tier: string;
  typeOnly: boolean;
}

const ROOT = path.resolve(import.meta.dirname!, "..");
const layerGroups: LayerGroup[] = JSON.parse(
  readFileSync(path.join(ROOT, ".import-layers.json"), "utf-8"),
);
const fileToLayer = new Map<string, number>();
const fileToGroup = new Map<string, string>();
const fileToTier = new Map<string, string>();
const DEFAULTS = [
  "src/runtime/runtime-composition.ts",
  "src/controllers/controller-types.ts",
  "src/runtime/runtime-types.ts",
];
const targets =
  process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULTS;
const project = new Project({
  tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
});

for (let i = 0; i < layerGroups.length; i++) {
  for (const file of layerGroups[i]!.files) {
    fileToLayer.set(file, i);
    fileToGroup.set(file, layerGroups[i]!.name);
    fileToTier.set(file, tierOfLayer(i));
  }
}

for (const group of layerGroups) {
  for (const file of group.files) {
    try {
      project.addSourceFileAtPath(path.join(ROOT, file));
    } catch {
      // skip
    }
  }
}

for (const target of targets) {
  const sf = project.getSourceFile(path.join(ROOT, target));
  if (!sf) {
    console.log(`SKIP ${target} — not found`);
    continue;
  }
  const targetLayer = fileToLayer.get(target)!;
  const targetGroup = fileToGroup.get(target)!;
  const targetTier = fileToTier.get(target)!;

  console.log(
    `\n=== ${target} (L${targetLayer} / ${targetTier} / "${targetGroup}") ===`,
  );

  const imports: ImportInfo[] = [];
  for (const imp of sf.getImportDeclarations()) {
    const resolved = imp.getModuleSpecifierSourceFile();
    if (!resolved) continue;
    const rel = path.relative(ROOT, resolved.getFilePath());
    const layer = fileToLayer.get(rel);
    if (layer === undefined) continue;
    if (layer >= targetLayer) continue; // skip same-or-higher (shouldn't happen)
    imports.push({
      file: rel,
      layer,
      group: fileToGroup.get(rel)!,
      tier: fileToTier.get(rel)!,
      typeOnly: imp.isTypeOnly(),
    });
  }
  imports.sort((left, right) => right.layer - left.layer);

  if (imports.length === 0) {
    console.log("  (no imports)");
    continue;
  }

  const pinLayer = imports[0]!.layer;
  const pins = imports.filter((info) => info.layer === pinLayer);
  const rest = imports.filter((info) => info.layer < pinLayer);

  console.log(
    `  PIN: layer ${pinLayer} ("${pins[0]!.group}" / ${pins[0]!.tier}) — ${pins.length} import(s) at this layer`,
  );
  for (const pin of pins) {
    console.log(`    ${pin.typeOnly ? "type " : "value"}  ${pin.file}`);
  }
  if (rest.length > 0) {
    console.log(`  Other imports (deeper layers): ${rest.length}`);
    const byLayer = new Map<number, ImportInfo[]>();
    for (const info of rest) {
      if (!byLayer.has(info.layer)) byLayer.set(info.layer, []);
      byLayer.get(info.layer)!.push(info);
    }
    const layers = [...byLayer.keys()].sort((a, b) => b - a);
    for (const layer of layers) {
      const group = byLayer.get(layer)![0]!.group;
      console.log(`    L${layer} ("${group}"): ${byLayer.get(layer)!.length}`);
    }
  }
}
