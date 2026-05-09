/**
 * Detect interface members that no external caller reads.
 *
 * The lint targets *facade* interfaces — composition-root return types,
 * dep-injection contracts — that grow stale as features land and are removed.
 * Knip can't see this: as long as the interface itself is referenced, knip
 * considers all its members consumed. TypeScript has no `noUnusedProperties`.
 *
 * Two-phase classification per interface:
 *   1. Static pass (ts-morph references). A property with zero external
 *      *reads* (PropertyAccess / destructure) becomes a CANDIDATE. The
 *      "implementing" assignment in an object literal is treated as a write
 *      via the `PropertyAssignment` / `ShorthandPropertyAssignment` parent-
 *      kind filter, not a read.
 *
 *      Why we don't trust this alone: structural typing means a consumer can
 *      read the same logical property via a *different* symbol — an inline
 *      `{ highlight: ... }` shape, or `Pick<T, ...>`. ts-morph's symbol-keyed
 *      reference search never sees those consumers, so static results
 *      systematically over-report.
 *
 *   2. Probe pass (bisecting in-memory deletion). Each candidate is removed
 *      from the interface and the project is re-type-checked. If a removal
 *      produces a diagnostic mentioning the property name, it was load-
 *      bearing (including via structural-typing indirection) and gets
 *      reclassified as live. Otherwise it's confirmed dead.
 *
 *      Bisection: try deleting every candidate at once; if tsc still passes,
 *      every candidate is dead in one probe. Otherwise split the set and
 *      recurse. Cost is O(K · log N) probes for K live false-positives in a
 *      set of N candidates, vs. O(N) for naive per-member probing.
 *
 * Targets are curated in TARGET_INTERFACES below — the lint is intentionally
 * narrow because most interfaces in the codebase are data types where every
 * member is structurally meaningful even when one consumer doesn't read it.
 *
 * Usage:
 *   deno run -A scripts/lint-unused-interface-fields.ts [--json] [--no-probe]
 *
 * Exits 1 on confirmed unused fields.
 */

import fs from "node:fs";
import process from "node:process";
import {
  type InterfaceDeclaration,
  Project,
  type PropertySignature,
  type SourceFile,
  SyntaxKind,
  type Node as TsNode,
} from "ts-morph";

interface Target {
  readonly file: string;
  readonly interface: string;
}

interface Finding {
  readonly target: string;
  readonly member: string;
  readonly file: string;
  readonly line: number;
}

interface DeadCandidate {
  readonly name: string;
  readonly line: number;
}

interface TargetsFile {
  readonly groups: readonly {
    readonly label: string;
    readonly targets: readonly Target[];
  }[];
}

const TARGETS_FILE = ".unused-iface-targets.json";
const TARGET_INTERFACES: readonly Target[] = loadTargets();
/** Suffixes typical of facade-style interfaces — DI contracts, system
 *  handles, extension hooks, lifecycle wiring. Cheap signal, ~80%
 *  precision. The shape check below catches the rest. */
const FACADE_SUFFIXES = [
  "Deps",
  "System",
  "Api",
  "Handle",
  "Subsystem",
  "Lifecycle",
  "Bus",
  "Client",
  "Strategy",
  "Controller",
  "Receiver",
  "Observer",
  "Impl",
  "Modifier",
  "Schedule",
];
/** Files that hold types we explicitly do NOT want to audit, regardless of
 *  shape. Wire payloads, render-output shapes, and protocol message types
 *  satisfy the shape heuristics for unrelated reasons. */
const AUDIT_EXCLUDE_DIRS = ["src/protocol/", "src/render/3d/"];
const AUDIT_EXCLUDE_FILE_SUFFIXES = [
  "overlay-types.ts",
  "render-view.ts",
  "interaction-types.ts",
  "ui-mode.ts",
  "checkpoint.ts",
];

function loadTargets(): readonly Target[] {
  const text = fs.readFileSync(TARGETS_FILE, "utf8");
  const parsed = JSON.parse(text) as TargetsFile;
  return parsed.groups.flatMap((g) => g.targets);
}

main();

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const suggestTargets = args.includes("--suggest-targets");
  // `--changed-files=p1,p2,...` (typically passed by the pre-commit hook
  // with the staged file list) makes the lint a no-op when none of the
  // target interfaces' dependency closures contain a changed file: the
  // result can't differ from the previous run.
  const changedArg = args.find((a) => a.startsWith("--changed-files="));
  const changedSet = changedArg
    ? new Set(
        changedArg
          .split("=")[1]!
          .split(",")
          .filter((p) => p.length > 0)
          .map((p) => `${process.cwd()}/${p}`),
      )
    : null;

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths("src/**/*.ts");
  project.addSourceFilesAtPaths("server/**/*.ts");
  project.addSourceFilesAtPaths("test/**/*.ts");

  if (suggestTargets) {
    suggestNewTargets(project);
    return;
  }

  const findings: Finding[] = [];

  for (const target of TARGET_INTERFACES) {
    const src = project.getSourceFile(target.file);
    if (!src) {
      console.error(
        `lint-unused-interface-fields: target file not found: ${target.file}`,
      );
      process.exit(2);
    }
    const iface = src.getInterface(target.interface);
    if (!iface) {
      console.error(
        `lint-unused-interface-fields: ${target.interface} not in ${target.file}`,
      );
      process.exit(2);
    }
    const affected = affectedFiles(src);
    if (changedSet !== null && !affected.some((p) => changedSet.has(p))) {
      // No staged file in this target's dependency closure → result for this
      // target can't have changed. Skip both static and probe passes.
      continue;
    }
    classify(target, iface, affected, project, findings);
  }

  if (findings.length === 0) {
    if (!asJson) console.log("lint-unused-interface-fields: ok");
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    console.error("lint-unused-interface-fields: unused fields detected\n");
    for (const f of findings) {
      console.error(`  ${f.target}.${f.member}  (${f.file}:${f.line})`);
    }
  }
  process.exit(1);
}

/** Print a list of exported interfaces that look facade-shaped but aren't
 *  in TARGETS yet. Audit-only — never fails CI; users review and add to
 *  the JSON. Heuristics:
 *    - At least 2 members.
 *    - Either suffix-matches FACADE_SUFFIXES, OR ≥80% of members are
 *      callable (function / method types), OR ≥3 members are optional
 *      (the extension-hook fingerprint).
 *    - Not in any AUDIT_EXCLUDE path.
 *    - Not already in TARGETS. */
function suggestNewTargets(project: Project): void {
  const existing = new Set(
    TARGET_INTERFACES.map((t) => `${t.file}::${t.interface}`),
  );
  const suggestions: { target: Target; reason: string }[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const fullPath = sourceFile.getFilePath();
    const relPath = fullPath.replace(`${process.cwd()}/`, "");
    if (!relPath.startsWith("src/")) continue;
    if (AUDIT_EXCLUDE_DIRS.some((d) => relPath.startsWith(d))) continue;
    if (AUDIT_EXCLUDE_FILE_SUFFIXES.some((s) => relPath.endsWith(s))) continue;

    for (const iface of sourceFile.getInterfaces()) {
      if (!iface.isExported()) continue;
      const key = `${relPath}::${iface.getName()}`;
      if (existing.has(key)) continue;
      const reason = facadeScore(iface);
      if (reason === null) continue;
      suggestions.push({
        target: { file: relPath, interface: iface.getName() },
        reason,
      });
    }
  }
  if (suggestions.length === 0) {
    console.log("lint-unused-interface-fields: no new candidates found");
    return;
  }
  console.log(
    `lint-unused-interface-fields: ${suggestions.length} candidate interfaces\n`,
  );
  console.log(
    `Add the ones that are real facades to .unused-iface-targets.json:\n`,
  );
  for (const s of suggestions) {
    console.log(`  ${s.target.interface}  (${s.target.file})  — ${s.reason}`);
  }
}

/** Returns a short reason string when the interface looks facade-shaped,
 *  null otherwise. Multiple signals can fire; the first match wins. The
 *  optional-heavy branch *also* requires the interface to have non-trivial
 *  callable density — without it, `Grunt`/`Cannon`-style data shapes with
 *  many state-machine flags slip through. */
function facadeScore(iface: InterfaceDeclaration): string | null {
  const props = iface.getProperties();
  if (props.length < 2) return null;

  const name = iface.getName();
  for (const suffix of FACADE_SUFFIXES) {
    if (name.endsWith(suffix)) return `name ends with "${suffix}"`;
  }

  const callable = props.filter((p) => isCallableMember(p)).length;
  const callableRatio = callable / props.length;
  const optionalCount = props.filter((p) => p.hasQuestionToken()).length;

  // Extension-hook shape: many optional fields AND most of them are functions.
  if (optionalCount >= 3 && callableRatio >= 0.5) {
    return `${optionalCount}/${props.length} optional, ${callable} callable (extension-hook shape)`;
  }

  // Pure facade: callable-heavy.
  if (callableRatio >= 0.8 && callable >= 2) {
    return `${callable}/${props.length} members callable`;
  }

  return null;
}

/** True when the property's declared type is a function — either a method
 *  signature (`foo(x): T`), an arrow type (`foo: (x) => T`), or `() => T`
 *  in any other shape. ts-morph exposes this via the type's call signatures. */
function isCallableMember(prop: PropertySignature): boolean {
  const typeNode = prop.getTypeNode();
  if (!typeNode) return false;
  const k = typeNode.getKind();
  if (k === SyntaxKind.FunctionType) return true;
  // MethodSignature is a different child of InterfaceDeclaration in TS, but
  // when `getProperties()` returns it, ts-morph models it as a property
  // whose type node is a function-ish kind. Fall back to call-signatures.
  return prop.getType().getCallSignatures().length > 0;
}

function classify(
  target: Target,
  iface: InterfaceDeclaration,
  affected: readonly string[],
  project: Project,
  findings: Finding[],
): void {
  const interfaceFile = iface.getSourceFile();
  // Capture (name, line) once. PropertySignature nodes get invalidated by
  // each probe's `replaceWithText`, so we pass strings through bisection
  // and re-resolve the live PropertySignature inside the probe.
  const candidates: { name: string; line: number }[] = [];
  for (const prop of iface.getProperties()) {
    const reads = collectExternalReads(prop, interfaceFile);
    if (reads.length === 0) {
      candidates.push({
        name: prop.getName(),
        line: prop.getStartLineNumber(),
      });
    }
  }
  if (candidates.length === 0) return;
  const interfaceName = iface.getName();
  const interfaceFilePath = interfaceFile.getFilePath();
  const confirmed = bisectProbe(
    interfaceFilePath,
    interfaceName,
    candidates,
    affected,
    project,
  );
  for (const dead of confirmed) {
    findings.push({
      target: target.interface,
      member: dead.name,
      file: target.file,
      line: dead.line,
    });
  }
}

/** Read references = property accesses + destructuring binding elements.
 *  Filters: declaration site (= the PropertySignature itself), and writes
 *  (PropertyAssignment / ShorthandPropertyAssignment in object literals are
 *  the *implementation* of the interface, not a use). */
function collectExternalReads(
  prop: PropertySignature,
  interfaceFile: SourceFile,
): TsNode[] {
  const nameNode = prop.getNameNode();
  const reads: TsNode[] = [];
  for (const ref of prop.findReferencesAsNodes()) {
    if (ref === nameNode) continue;
    if (ref.getSourceFile() === interfaceFile) {
      // Allow internal cross-references (e.g. doc-only); only decl-node skipped.
    }
    const parent = ref.getParent();
    if (!parent) continue;
    const k = parent.getKind();
    // Writes — implementing-side of the interface
    if (k === SyntaxKind.PropertyAssignment) continue;
    if (k === SyntaxKind.ShorthandPropertyAssignment) continue;
    // Reads
    if (k === SyntaxKind.PropertyAccessExpression) {
      reads.push(ref);
      continue;
    }
    if (k === SyntaxKind.BindingElement) {
      reads.push(ref);
      continue;
    }
    // Type-position references (PropertySignature in another interface, etc.)
    // are noise — count as reads to be conservative.
    if (k === SyntaxKind.PropertySignature) {
      reads.push(ref);
      continue;
    }
  }
  return reads;
}

/** Closure of files reachable from `root` by `getReferencingSourceFiles`
 *  (transitive consumers via `import` statements). The diagnostic for a
 *  removed property can only appear in a file that imports the interface
 *  declaration, directly or transitively, so the probe only needs to
 *  re-type-check this set instead of the whole project. */
function affectedFiles(root: SourceFile): readonly string[] {
  const seen = new Set<string>([root.getFilePath()]);
  const queue: SourceFile[] = [root];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const ref of cur.getReferencingSourceFiles()) {
      const path = ref.getFilePath();
      if (!seen.has(path)) {
        seen.add(path);
        queue.push(ref);
      }
    }
  }
  return [...seen];
}

/** Bisecting in-memory delete probe: try removing all `candidates` from the
 *  interface; if the affected file set still type-checks, every candidate
 *  is dead. Otherwise split and recurse. Returns the subset confirmed dead.
 *  Identity is by `name` so repeated reslicing across probe iterations stays
 *  valid even though the underlying nodes are recreated each time. */
function bisectProbe(
  filePath: string,
  interfaceName: string,
  candidates: readonly DeadCandidate[],
  affected: readonly string[],
  project: Project,
): DeadCandidate[] {
  if (candidates.length === 0) return [];
  if (probeRemoveAll(filePath, interfaceName, candidates, affected, project)) {
    return [...candidates];
  }
  if (candidates.length === 1) return [];
  const mid = Math.floor(candidates.length / 2);
  const left = bisectProbe(
    filePath,
    interfaceName,
    candidates.slice(0, mid),
    affected,
    project,
  );
  const right = bisectProbe(
    filePath,
    interfaceName,
    candidates.slice(mid),
    affected,
    project,
  );
  return [...left, ...right];
}

/** Try removing every candidate from the interface and re-check the affected
 *  files only (transitive consumers of the interface declaration). Restores
 *  the file's text on exit so subsequent probes see a pristine project.
 *  Returns true iff removing all candidates leaves the program error-free
 *  in the affected set — pre-existing diagnostics elsewhere are ignored. */
function probeRemoveAll(
  filePath: string,
  interfaceName: string,
  candidates: readonly DeadCandidate[],
  affected: readonly string[],
  project: Project,
): boolean {
  const sourceFile = project.getSourceFileOrThrow(filePath);
  const originalText = sourceFile.getFullText();
  const namesToRemove = new Set(candidates.map((c) => c.name));
  const liveIface = sourceFile.getInterfaceOrThrow(interfaceName);
  for (const member of liveIface.getProperties()) {
    if (namesToRemove.has(member.getName())) member.remove();
  }
  // Per-file diagnostics scoped to the dependency closure of the interface.
  // Calling `project.getPreEmitDiagnostics()` would re-check every file in
  // the project (~280) on every probe; per-file iteration shrinks that to
  // the actual consumers (~20-50 typically), a 5-10x speedup.
  let causedByRemoval = false;
  for (const path of affected) {
    const sf = project.getSourceFileOrThrow(path);
    const diags = sf.getPreEmitDiagnostics();
    for (const d of diags) {
      const msg = d.getMessageText();
      const text = typeof msg === "string" ? msg : msg.getMessageText();
      for (const name of namesToRemove) {
        if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) {
          causedByRemoval = true;
          break;
        }
      }
      if (causedByRemoval) break;
    }
    if (causedByRemoval) break;
  }
  // Restore file text so subsequent probes start from a clean state.
  sourceFile.replaceWithText(originalText);
  return !causedByRemoval;
}
