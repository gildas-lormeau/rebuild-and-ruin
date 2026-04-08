/**
 * Domain boundary linter — checks that imports stay within allowed domain boundaries.
 *
 * Layers enforce vertical direction (imports flow downward).
 * Domains enforce horizontal cohesion (files in domain X only import from allowed domains).
 *
 * Usage:
 *   deno run -A scripts/lint-domain-boundaries.ts          # lint mode
 *   deno run -A scripts/lint-domain-boundaries.ts --verbose # show all imports, not just violations
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Project, SyntaxKind, type SourceFile } from "ts-morph";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname!, "..");
const CONFIG_PATH = path.join(ROOT, ".domain-boundaries.json");

interface Config {
  domains: Record<string, string[]>;
  allowed: Record<string, string[]>;
  /** Domain pairs where only type-only imports are permitted. */
  typeOnlyFrom?: Record<string, string[]>;
}

interface LayerGroup {
  name: string;
  tier?: string;
  files: string[];
}

const config: Config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

// Build set of files in the "roots" tier — these are composition roots,
// automatically exempt from typeOnlyFrom restrictions.
const LAYER_FILE = path.join(ROOT, ".import-layers.json");
const rootsTierFiles = new Set<string>();
try {
  const layers: LayerGroup[] = JSON.parse(readFileSync(LAYER_FILE, "utf-8"));
  for (const group of layers) {
    if (group.tier === "roots") {
      for (const file of group.files) rootsTierFiles.add(file);
    }
  }
} catch {
  // layer file missing — no tier-based exemptions
}

// Build reverse map: file → domain
const fileToDomain = new Map<string, string>();
for (const [domain, files] of Object.entries(config.domains)) {
  for (const file of files) {
    fileToDomain.set(file, domain);
  }
}

// Build allowed set per domain
const allowedDeps = new Map<string, Set<string>>();
for (const [domain, deps] of Object.entries(config.allowed)) {
  allowedDeps.set(domain, new Set(deps));
}

// Parse imports using ts-morph
const project = new Project({
  tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
});

// Add all files from the config
for (const files of Object.values(config.domains)) {
  for (const file of files) {
    const absPath = path.join(ROOT, file);
    try {
      project.addSourceFileAtPath(absPath);
    } catch {
      // file might not exist (e.g. .d.ts)
    }
  }
}

interface ModuleRef {
  specifier: string;
  resolved: SourceFile | undefined;
  typeOnly: boolean;
}

/** Collect cross-module references from both imports and re-exports. */
function getModuleRefs(sf: SourceFile): ModuleRef[] {
  const refs: ModuleRef[] = [];
  for (const imp of sf.getImportDeclarations()) {
    refs.push({
      specifier: imp.getModuleSpecifierValue(),
      resolved: imp.getModuleSpecifierSourceFile(),
      typeOnly:
        imp.isTypeOnly() ||
        imp.getNamedImports().every((ni) => ni.isTypeOnly()),
    });
  }
  for (const exp of sf.getExportDeclarations()) {
    const specifier = exp.getModuleSpecifierValue();
    if (!specifier) continue; // not a re-export
    refs.push({
      specifier,
      resolved: exp.getModuleSpecifierSourceFile(),
      typeOnly:
        exp.isTypeOnly() ||
        (!exp.isNamespaceExport() &&
          exp.getNamedExports().every((ne) => ne.isTypeOnly())),
    });
  }
  return refs;
}

interface Violation {
  file: string;
  fileDomain: string;
  dep: string;
  depDomain: string;
  specifier: string;
  typeOnly: boolean;
}

const violations: Violation[] = [];
let checkedFiles = 0;
let checkedImports = 0;

for (const sf of project.getSourceFiles()) {
  const absFile = sf.getFilePath();
  const relFile = path.relative(ROOT, absFile);
  const fileDomain = fileToDomain.get(relFile);

  if (!fileDomain) continue; // file not in any domain
  checkedFiles++;

  const allowed = allowedDeps.get(fileDomain);
  if (!allowed) continue;

  for (const ref of getModuleRefs(sf)) {
    if (!ref.resolved) continue; // external module

    const depAbs = ref.resolved.getFilePath();
    const depRel = path.relative(ROOT, depAbs);
    const depDomain = fileToDomain.get(depRel);

    if (!depDomain) continue; // dep not in any domain (external)
    checkedImports++;

    // Same-domain imports are always allowed
    if (depDomain === fileDomain) continue;

    if (!allowed.has(depDomain)) {
      violations.push({
        file: relFile,
        fileDomain,
        dep: depRel,
        depDomain,
        specifier: ref.specifier,
        typeOnly: ref.typeOnly,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// typeOnlyFrom check: flag value imports across type-only domain boundaries
// ---------------------------------------------------------------------------

const typeOnlyFrom = new Map<string, Set<string>>();
if (config.typeOnlyFrom) {
  for (const [domain, deps] of Object.entries(config.typeOnlyFrom)) {
    typeOnlyFrom.set(domain, new Set(deps));
  }
}
// Composition roots (files in the "roots" tier) are exempt from typeOnlyFrom.
const typeOnlyExempt = rootsTierFiles;

interface TypeOnlyViolation {
  file: string;
  fileDomain: string;
  dep: string;
  depDomain: string;
  specifier: string;
}

const typeOnlyViolations: TypeOnlyViolation[] = [];

for (const sf of project.getSourceFiles()) {
  const absFile = sf.getFilePath();
  const relFile = path.relative(ROOT, absFile);
  const fileDomain = fileToDomain.get(relFile);

  if (!fileDomain) continue;
  if (typeOnlyExempt.has(relFile)) continue;

  const restricted = typeOnlyFrom.get(fileDomain);
  if (!restricted) continue;

  for (const ref of getModuleRefs(sf)) {
    if (!ref.resolved) continue;

    const depRel = path.relative(ROOT, ref.resolved.getFilePath());
    const depDomain = fileToDomain.get(depRel);
    if (!depDomain || depDomain === fileDomain) continue;
    if (!restricted.has(depDomain)) continue;
    if (ref.typeOnly) continue;

    typeOnlyViolations.push({
      file: relFile,
      fileDomain,
      dep: depRel,
      depDomain,
      specifier: ref.specifier,
    });
  }
}

// ---------------------------------------------------------------------------
// Dynamic import() check: catch boundary violations via import() expressions
// ---------------------------------------------------------------------------

interface DynamicImportViolation {
  file: string;
  fileDomain: string;
  specifier: string;
  depDomain: string;
}

const dynamicImportViolations: DynamicImportViolation[] = [];

for (const sf of project.getSourceFiles()) {
  const absFile = sf.getFilePath();
  const relFile = path.relative(ROOT, absFile);
  const fileDomain = fileToDomain.get(relFile);

  if (!fileDomain) continue;

  const allowed = allowedDeps.get(fileDomain);
  if (!allowed) continue;

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;
    const specifier = args[0].asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
    if (!specifier || !specifier.startsWith(".")) continue;

    const resolved = path.normalize(
      path.join(path.dirname(absFile), specifier),
    );
    const depRel = path.relative(ROOT, resolved);
    const depDomain = fileToDomain.get(depRel);

    if (!depDomain || depDomain === fileDomain) continue;
    checkedImports++;

    if (!allowed.has(depDomain)) {
      dynamicImportViolations.push({
        file: relFile,
        fileDomain,
        specifier,
        depDomain,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Unassigned files: fail if any src/ or server/ .ts file is not in a domain
// ---------------------------------------------------------------------------

const diskFiles: string[] = [];
for (const dir of ["src", "server"]) {
  const dirPath = path.join(ROOT, dir);
  try {
    for (const entry of readdirSync(dirPath, { recursive: true })) {
      const rel = path.join(dir, String(entry));
      if (rel.endsWith(".ts") && !rel.endsWith(".d.ts")) {
        diskFiles.push(rel);
      }
    }
  } catch {
    // directory may not exist
  }
}
const unassigned = diskFiles.filter((f) => !fileToDomain.has(f));

// Report
const totalViolations =
  violations.length + typeOnlyViolations.length + dynamicImportViolations.length;

if (totalViolations === 0 && unassigned.length === 0) {
  console.log(
    `\n✔ No domain boundary violations (${checkedFiles} files, ${checkedImports} imports checked)\n`,
  );
} else {
  if (violations.length > 0) {
    const grouped = new Map<string, Violation[]>();
    for (const violation of violations) {
      const key = `${violation.fileDomain} → ${violation.depDomain}`;
      const list = grouped.get(key) ?? [];
      list.push(violation);
      grouped.set(key, list);
    }

    console.log(
      `\n✘ ${violations.length} domain boundary violation(s) found:\n`,
    );
    for (const [edge, items] of [...grouped.entries()].sort()) {
      console.log(`  ${edge}:`);
      for (const item of items) {
        const tag = item.typeOnly ? " (type-only)" : "";
        console.log(`    ${item.file} → ${item.dep}${tag}`);
      }
      console.log();
    }
  }

  if (typeOnlyViolations.length > 0) {
    const grouped = new Map<string, TypeOnlyViolation[]>();
    for (const violation of typeOnlyViolations) {
      const key = `${violation.fileDomain} → ${violation.depDomain}`;
      const list = grouped.get(key) ?? [];
      list.push(violation);
      grouped.set(key, list);
    }

    console.log(
      `\n✘ ${typeOnlyViolations.length} typeOnlyFrom violation(s) — value imports where only type imports are allowed:\n`,
    );
    for (const [edge, items] of [...grouped.entries()].sort()) {
      console.log(`  ${edge} (type-only required):`);
      for (const item of items) {
        console.log(`    ${item.file} → ${item.dep}`);
      }
      console.log();
    }
  }

  if (dynamicImportViolations.length > 0) {
    const grouped = new Map<string, DynamicImportViolation[]>();
    for (const violation of dynamicImportViolations) {
      const key = `${violation.fileDomain} → ${violation.depDomain}`;
      const list = grouped.get(key) ?? [];
      list.push(violation);
      grouped.set(key, list);
    }

    console.log(
      `\n✘ ${dynamicImportViolations.length} dynamic import() boundary violation(s):\n`,
    );
    for (const [edge, items] of [...grouped.entries()].sort()) {
      console.log(`  ${edge}:`);
      for (const item of items) {
        console.log(`    ${item.file} → import("${item.specifier}")`);
      }
      console.log();
    }
  }

  if (unassigned.length > 0) {
    console.log(
      `\n✘ ${unassigned.length} file(s) not assigned to any domain in .domain-boundaries.json:\n`,
    );
    for (const f of unassigned) console.log(`  ${f}`);
    console.log();
  }

  console.log(
    `(${checkedFiles} files, ${checkedImports} imports checked)\n`,
  );
  process.exit(1);
}
