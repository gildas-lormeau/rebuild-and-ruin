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

const TARGET_INTERFACES: readonly Target[] = [
  // Top-level facade returned by createGameRuntime.
  { file: "src/runtime/runtime-types.ts", interface: "GameRuntime" },
  // Sub-system handles surfaced on GameRuntime — same risk shape: members
  // exposed for hypothetical consumers that may never have landed.
  { file: "src/runtime/runtime-types.ts", interface: "RuntimeSelection" },
  { file: "src/runtime/runtime-types.ts", interface: "RuntimeLifeLost" },
  { file: "src/runtime/runtime-types.ts", interface: "RuntimeUpgradePick" },
  { file: "src/runtime/runtime-types.ts", interface: "RuntimeLobby" },
  { file: "src/runtime/runtime-types.ts", interface: "RuntimeLifecycle" },
  { file: "src/runtime/runtime-types.ts", interface: "RuntimePhaseTicks" },
  { file: "src/runtime/runtime-types.ts", interface: "RuntimeMusic" },
  { file: "src/runtime/runtime-types.ts", interface: "RuntimeSfx" },
  { file: "src/runtime/runtime-types.ts", interface: "CameraSystem" },
  // Online-only contracts wired from outside the runtime package.
  { file: "src/runtime/runtime-types.ts", interface: "OnlinePhaseTicks" },
  { file: "src/runtime/runtime-types.ts", interface: "OnlineActions" },
  { file: "src/runtime/runtime-types.ts", interface: "OnlineDialogDrains" },
  { file: "src/runtime/runtime-types.ts", interface: "NetworkApi" },
  // Per-subsystem dep-injection contracts (XxxDeps) and system handles.
  // Each one is a candidate to grow stale as call sites change shape.
  { file: "src/runtime/runtime-phase-ticks.ts", interface: "PhaseTicksSystem" },
  {
    file: "src/runtime/runtime-upgrade-pick.ts",
    interface: "UpgradePickSystem",
  },
  { file: "src/runtime/runtime-contracts.ts", interface: "OverlayActionDeps" },
  { file: "src/runtime/runtime-contracts.ts", interface: "DpadDeps" },
  { file: "src/runtime/runtime-contracts.ts", interface: "QuitButtonDeps" },
  { file: "src/runtime/runtime-contracts.ts", interface: "ZoomButtonDeps" },
  {
    file: "src/runtime/runtime-contracts.ts",
    interface: "FloatingActionsDeps",
  },
  {
    file: "src/runtime/runtime-contracts.ts",
    interface: "FloatingActionsHandle",
  },
  {
    file: "src/runtime/runtime-contracts.ts",
    interface: "RegisterOnlineInputDeps",
  },
  { file: "src/runtime/runtime-contracts.ts", interface: "GameActionDeps" },
  { file: "src/runtime/runtime-contracts.ts", interface: "PointerMoveDeps" },
  { file: "src/runtime/runtime-contracts.ts", interface: "TouchControlsDeps" },
  { file: "src/runtime/runtime-contracts.ts", interface: "TimingApi" },
  {
    file: "src/online/online-server-lifecycle.ts",
    interface: "HandleServerLifecycleDeps",
  },
  {
    file: "src/online/online-server-events.ts",
    interface: "HandleServerIncrementalDeps",
  },
];

main();

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
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
