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

import { readFileSync } from "node:fs";
import path from "node:path";
import { Project, type SourceFile } from "ts-morph";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname!, "..");
const CONFIG_PATH = path.join(ROOT, ".domain-boundaries.json");

interface Config {
  domains: Record<string, string[]>;
  allowed: Record<string, string[]>;
  /** Domain pairs where only type-only imports are permitted. */
  typeOnlyFrom?: Record<string, string[]>;
  /** Files exempt from typeOnlyFrom (e.g. composition roots). */
  typeOnlyExempt?: string[];
}

const config: Config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

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
const typeOnlyExempt = new Set(config.typeOnlyExempt ?? []);

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

// Report
if (violations.length === 0 && typeOnlyViolations.length === 0) {
  console.log(
    `\n✔ No domain boundary violations (${checkedFiles} files, ${checkedImports} imports checked)\n`,
  );
  // Check for unassigned files
  const allSources = project.getSourceFiles().map((sf) =>
    path.relative(ROOT, sf.getFilePath()),
  );
  const unassigned = allSources.filter(
    (f) => !fileToDomain.has(f) && !f.startsWith("node_modules"),
  );
  if (unassigned.length > 0) {
    console.log(`⚠ ${unassigned.length} file(s) not assigned to any domain:`);
    for (const f of unassigned) console.log(`  ${f}`);
  }
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

  console.log(
    `(${checkedFiles} files, ${checkedImports} imports checked)\n`,
  );
  process.exit(1);
}
