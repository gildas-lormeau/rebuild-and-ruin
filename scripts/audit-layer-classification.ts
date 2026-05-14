/**
 * Audit layer classification — find files whose declared layer disagrees
 * with three independent signals.
 *
 * Signals:
 *  1. HEADER  — file's leading comment block self-claims a tier/role
 *               (e.g. "'roots' tier", "composition root", "leaf module")
 *  2. NAME    — filename pattern implies a tier
 *               (*-composition, *-bootstrap, main.ts, *-types, *-defs, ...)
 *  3. IMPORTS — domain spread implies a tier (a file pulling in
 *               input/render/online is wiring, not types/logic)
 *
 * Files where >=1 signal disagrees with the JSON tier are printed,
 * ranked by signal count. Layer numbers are mechanically derived from
 * imports and always correct — the question is whether the *layer-group
 * name* (and tier) the file lands in still describes its role.
 *
 * Usage: deno run -A scripts/audit-layer-classification.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Project } from "ts-morph";
import { type Tier, tierOfLayer } from "./cells/tier-of-layer.ts";

interface LayerGroup {
  name: string;
  files: string[];
}

interface Finding {
  file: string;
  tier: Tier;
  layer: number;
  signals: Array<{
    kind: "HEADER" | "NAME" | "IMPORTS";
    expects: Set<Tier>;
    why: string;
  }>;
}

const TIER_ORDER: Tier[] = ["types", "logic", "systems", "assembly", "roots"];
const TIER_RANK: Record<Tier, number> = {
  types: 0,
  logic: 1,
  systems: 2,
  assembly: 3,
  roots: 4,
};
/** Entry-point files intentionally land at their minimum-import-depth layer
 *  (per CLAUDE.md), which can be any tier. Skip the name heuristic for them. */
const ENTRY_POINT_ALLOWLIST = new Set([
  "src/entry.ts",
  "src/main.ts",
  "src/online-client.ts",
]);
const ROOT = path.resolve(import.meta.dirname!, "..");
const layerGroups: LayerGroup[] = JSON.parse(
  readFileSync(path.join(ROOT, ".import-layers.json"), "utf-8"),
);
const fileToLayer = new Map<string, number>();
const fileToTier = new Map<string, Tier>();
const project = new Project({
  tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
});
const allFiles: string[] = [];
const findings: Finding[] = [];

for (let i = 0; i < layerGroups.length; i++) {
  for (const file of layerGroups[i]!.files) {
    fileToLayer.set(file, i);
    fileToTier.set(file, tierOfLayer(i));
  }
}

for (const group of layerGroups) {
  for (const file of group.files) {
    try {
      project.addSourceFileAtPath(path.join(ROOT, file));
      allFiles.push(file);
    } catch {
      // skip
    }
  }
}

for (const sf of project.getSourceFiles()) {
  const file = path.relative(ROOT, sf.getFilePath());
  const tier = fileToTier.get(file);
  if (!tier) continue;
  const layer = fileToLayer.get(file)!;

  const text = sf.getFullText();
  const header = extractHeader(text);
  const importedDomains = collectImportedDomains(sf);
  const onlyTypeExports = hasOnlyTypeExports(sf);

  const signals: Finding["signals"] = [];

  const headerExpects = headerSignal(header);
  if (headerExpects && !headerExpects.tiers.has(tier)) {
    signals.push({
      kind: "HEADER",
      expects: headerExpects.tiers,
      why: headerExpects.why,
    });
  }

  const nameExpects = ENTRY_POINT_ALLOWLIST.has(file)
    ? null
    : nameSignal(file, onlyTypeExports);
  if (nameExpects && !nameExpects.tiers.has(tier)) {
    signals.push({
      kind: "NAME",
      expects: nameExpects.tiers,
      why: nameExpects.why,
    });
  }

  const importsExpects = importsSignal(importedDomains, tier);
  if (importsExpects) {
    signals.push({
      kind: "IMPORTS",
      expects: importsExpects.tiers,
      why: importsExpects.why,
    });
  }

  if (signals.length > 0) {
    findings.push({ file, tier, layer, signals });
  }
}

findings.sort(
  (left, right) =>
    right.signals.length - left.signals.length ||
    left.file.localeCompare(right.file),
);

if (findings.length === 0) {
  console.log("No layer-classification mismatches found.");
  process.exit(0);
}

console.log(
  `Found ${findings.length} files with classification signal mismatches:\n`,
);

for (const found of findings) {
  const expectsUnion = new Set<Tier>();
  for (const sig of found.signals)
    for (const tier of sig.expects) expectsUnion.add(tier);
  const expectsList = TIER_ORDER.filter((tier) => expectsUnion.has(tier)).join(
    "|",
  );
  console.log(
    `[${found.signals.length}] ${found.file}  (${found.tier} / L${found.layer})  -> expects ${expectsList}`,
  );
  for (const sig of found.signals) {
    console.log(`     ${sig.kind}: ${sig.why}`);
  }
  console.log();
}

function extractHeader(text: string): string {
  const block = text.match(/^\s*\/\*\*?[\s\S]*?\*\//);
  if (block) return block[0];
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("//")) lines.push(line);
    else if (line.trim() === "") lines.push(line);
    else break;
  }
  return lines.join("\n");
}

function headerSignal(
  header: string,
): { tiers: Set<Tier>; why: string } | null {
  const tierMatch = header.match(
    /['"](roots|assembly|systems|logic|types)['"]\s*tier/i,
  );
  if (tierMatch) {
    return {
      tiers: new Set([tierMatch[1]!.toLowerCase() as Tier]),
      why: `header self-claims '${tierMatch[1]!.toLowerCase()}' tier`,
    };
  }
  if (/this (?:is|file is) (?:the |a )?composition root/i.test(header)) {
    return {
      tiers: new Set(["roots", "assembly"]),
      why: "header self-describes as a composition root",
    };
  }
  if (
    /this (?:is|file is) (?:the |a )?(?:entry point|local entry|client entry)/i.test(
      header,
    )
  ) {
    return {
      tiers: new Set(["roots", "assembly"]),
      why: "header self-describes as an entry point",
    };
  }
  if (/this (?:is|file is) (?:a )?leaf module/i.test(header)) {
    return {
      tiers: new Set(["types"]),
      why: "header self-describes as a leaf module",
    };
  }
  return null;
}

function nameSignal(
  file: string,
  onlyTypeExports: boolean,
): { tiers: Set<Tier>; why: string } | null {
  const base = path.basename(file);
  if (/-composition\.ts$/.test(base)) {
    return {
      tiers: new Set(["roots", "assembly"]),
      why: `name "${base}" implies composition root`,
    };
  }
  // -bootstrap intentionally NOT flagged: helper functions called by the
  // composition root are also commonly named *-bootstrap (e.g. runtime-bootstrap
  // is a sub-system invoked from runtime-composition). The "-composition" suffix
  // is the stronger signal for roots-tier files.
  if (/-(types|defs|pool|interfaces)\.ts$/.test(base)) {
    if (!onlyTypeExports) {
      return {
        tiers: new Set(["types"]),
        why: `name "${base}" implies pure type/contract module, but file has value exports — name is misleading`,
      };
    }
    return {
      tiers: new Set(["types"]),
      why: `name "${base}" implies pure type/contract module (file is pure types — layer system pulls it up because its imports cross into non-types)`,
    };
  }
  if (/-(system|strategy|engine|machine)\.ts$/.test(base)) {
    return {
      tiers: new Set(["systems", "assembly"]),
      why: `name "${base}" implies system/strategy module`,
    };
  }
  return null;
}

function hasOnlyTypeExports(sf: import("ts-morph").SourceFile): boolean {
  let saw = false;
  for (const stmt of sf.getStatements()) {
    const kind = stmt.getKindName();
    if (kind === "ImportDeclaration") continue;
    if (kind === "InterfaceDeclaration" || kind === "TypeAliasDeclaration") {
      saw = true;
      continue;
    }
    if (kind === "ExportDeclaration" || kind === "ExportAssignment") {
      // re-exports — OK if all type-only, but cheap heuristic: treat as types
      saw = true;
      continue;
    }
    if (kind === "ModuleDeclaration") continue; // namespace/declare
    // anything else (variable, function, class, enum) = value export possible
    return false;
  }
  return saw;
}

function collectImportedDomains(
  sf: import("ts-morph").SourceFile,
): Set<string> {
  const domains = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    const resolved = imp.getModuleSpecifierSourceFile();
    if (!resolved) continue;
    const rel = path.relative(ROOT, resolved.getFilePath());
    const segs = rel.split(path.sep);
    if (segs[0] === "src" && segs.length > 2) domains.add(segs[1]!);
  }
  return domains;
}

function importsSignal(
  domains: Set<string>,
  currentTier: Tier,
): { tiers: Set<Tier>; why: string } | null {
  const wiringDomains = ["input", "render", "online"].filter((domain) =>
    domains.has(domain),
  );
  if (
    wiringDomains.length >= 2 &&
    TIER_RANK[currentTier] < TIER_RANK.assembly
  ) {
    return {
      tiers: new Set(["assembly", "roots"]),
      why: `imports ${wiringDomains.length} wiring domains (${wiringDomains.join(", ")}) — wiring shape, not ${currentTier}`,
    };
  }
  if (domains.size >= 5 && TIER_RANK[currentTier] < TIER_RANK.assembly) {
    return {
      tiers: new Set(["assembly", "roots"]),
      why: `imports ${domains.size} distinct domains (${[...domains].sort().join(", ")}) — too broad for ${currentTier}`,
    };
  }
  return null;
}
