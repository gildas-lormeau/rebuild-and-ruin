/**
 * Architecture health analysis — computes structural metrics from the raw import graph.
 *
 * Three analyses, zero hand-written rules:
 *
 * 1. DSM (Dependency Structure Matrix) — sorted by layer, flags above-diagonal
 *    imports (unexpected upward/lateral coupling)
 * 2. Coupling metrics (Robert Martin) — Ca, Ce, Instability, Abstractness
 *    Flags rigid pain points (concrete + stable + many dependents)
 * 3. Natural clustering (Louvain modularity) — discovers domains from actual
 *    coupling. Diff against declared domains to find misplaced files.
 *
 * Usage:
 *   deno run -A scripts/architecture-health.ts              # full report
 *   deno run -A scripts/architecture-health.ts --dsm        # DSM only
 *   deno run -A scripts/architecture-health.ts --coupling    # coupling only
 *   deno run -A scripts/architecture-health.ts --clusters    # clustering only
 *   deno run -A scripts/architecture-health.ts --json        # machine-readable output
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Project } from "ts-morph";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname!, "..");
const LAYERS_PATH = path.join(ROOT, ".import-layers.json");
const DOMAINS_PATH = path.join(ROOT, ".domain-boundaries.json");

const args = new Set(process.argv.slice(2));
const showDsm = args.has("--dsm") || args.size === 0 || args.has("--json");
const showCoupling = args.has("--coupling") || args.size === 0 || args.has("--json");
const showClusters = args.has("--clusters") || args.size === 0 || args.has("--json");
const jsonMode = args.has("--json");

// ---------------------------------------------------------------------------
// Parse the import graph
// ---------------------------------------------------------------------------

interface LayerGroup {
  name: string;
  files: string[];
}

const layerGroups: LayerGroup[] = JSON.parse(
  readFileSync(LAYERS_PATH, "utf-8"),
);

// Build file → layer index
const fileToLayer = new Map<string, number>();
const fileToGroup = new Map<string, string>();
for (let li = 0; li < layerGroups.length; li++) {
  for (const file of layerGroups[li].files) {
    fileToLayer.set(file, li);
    fileToGroup.set(file, layerGroups[li].name);
  }
}

// Build file → domain (if domain config exists)
const fileToDomain = new Map<string, string>();
if (existsSync(DOMAINS_PATH)) {
  const domainConfig = JSON.parse(readFileSync(DOMAINS_PATH, "utf-8"));
  for (const [domain, files] of Object.entries(domainConfig.domains)) {
    for (const file of files as string[]) {
      fileToDomain.set(file, domain);
    }
  }
}

// Parse actual imports via ts-morph
const project = new Project({
  tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
});

const allFiles: string[] = [];
for (const group of layerGroups) {
  for (const file of group.files) {
    const absPath = path.join(ROOT, file);
    try {
      project.addSourceFileAtPath(absPath);
      allFiles.push(file);
    } catch {
      // skip .d.ts or missing
    }
  }
}

// Build adjacency: file → Set<file> (imports)
const imports = new Map<string, Set<string>>();
const importedBy = new Map<string, Set<string>>();

for (const file of allFiles) {
  imports.set(file, new Set());
  importedBy.set(file, new Set());
}

for (const sf of project.getSourceFiles()) {
  const relFile = path.relative(ROOT, sf.getFilePath());
  if (!imports.has(relFile)) continue;

  for (const imp of sf.getImportDeclarations()) {
    const resolved = imp.getModuleSpecifierSourceFile();
    if (!resolved) continue;
    const depRel = path.relative(ROOT, resolved.getFilePath());
    if (!imports.has(depRel)) continue;
    if (depRel === relFile) continue;

    imports.get(relFile)!.add(depRel);
    importedBy.get(depRel)!.add(relFile);
  }
}

// Short name for display
function short(file: string): string {
  return file
    .replace("src/", "")
    .replace("server/", "srv/")
    .replace(".ts", "");
}

// ---------------------------------------------------------------------------
// 1. DSM — Dependency Structure Matrix
// ---------------------------------------------------------------------------

interface DsmViolation {
  from: string;
  fromLayer: number;
  fromGroup: string;
  to: string;
  toLayer: number;
  toGroup: string;
  /** "upward" = imports a higher layer; "lateral" = same layer, different file */
  kind: "upward" | "lateral";
}

function computeDsm(): { violations: DsmViolation[]; lateralCount: number } {
  const violations: DsmViolation[] = [];
  let lateralCount = 0;

  for (const [file, deps] of imports) {
    const fromLayer = fileToLayer.get(file) ?? -1;
    const fromGroup = fileToGroup.get(file) ?? "?";

    for (const dep of deps) {
      const toLayer = fileToLayer.get(dep) ?? -1;
      const toGroup = fileToGroup.get(dep) ?? "?";

      if (toLayer > fromLayer) {
        violations.push({
          from: file,
          fromLayer,
          fromGroup,
          to: dep,
          toLayer,
          toGroup,
          kind: "upward",
        });
      } else if (toLayer === fromLayer && file !== dep) {
        lateralCount++;
      }
    }
  }

  return { violations, lateralCount };
}

// ---------------------------------------------------------------------------
// 2. Coupling metrics (Robert Martin)
// ---------------------------------------------------------------------------

interface CouplingMetrics {
  file: string;
  layer: number;
  group: string;
  domain: string;
  ca: number; // afferent (dependents)
  ce: number; // efferent (dependencies)
  instability: number; // Ce / (Ca + Ce)
  /** True if file exports only types/interfaces (abstract). */
  abstract: boolean;
  /** "pain" = concrete + stable + many dependents (hard to change safely) */
  pain: number;
}

function computeCoupling(): CouplingMetrics[] {
  const results: CouplingMetrics[] = [];

  for (const file of allFiles) {
    const ca = importedBy.get(file)?.size ?? 0;
    const ce = imports.get(file)?.size ?? 0;
    const total = ca + ce;
    const instability = total === 0 ? 0 : ce / total;

    // Check if file is abstract (only type exports)
    const sf = project.getSourceFile(path.join(ROOT, file));
    let abstract = false;
    if (sf) {
      const exports = sf.getExportedDeclarations();
      abstract =
        exports.size > 0 &&
        [...exports.values()].flat().every((decl) => {
          const kind = decl.getKindName();
          return (
            kind === "InterfaceDeclaration" ||
            kind === "TypeAliasDeclaration" ||
            kind === "EnumDeclaration"
          );
        });
    }

    // Pain = dependents × stability × concreteness
    // High pain = many files depend on concrete implementation
    const stability = 1 - instability;
    const concreteness = abstract ? 0 : 1;
    const pain = ca * stability * concreteness;

    results.push({
      file,
      layer: fileToLayer.get(file) ?? -1,
      group: fileToGroup.get(file) ?? "?",
      domain: fileToDomain.get(file) ?? "?",
      ca,
      ce,
      instability: Math.round(instability * 100) / 100,
      abstract,
      pain: Math.round(pain * 10) / 10,
    });
  }

  return results.sort((a, b) => b.pain - a.pain);
}

// ---------------------------------------------------------------------------
// 3. Natural clustering (Louvain-inspired modularity optimization)
// ---------------------------------------------------------------------------

interface ClusterResult {
  file: string;
  cluster: number;
  declaredDomain: string;
  mismatch: boolean;
}

function computeClusters(): {
  clusters: Map<number, string[]>;
  results: ClusterResult[];
  domainDiff: { file: string; computed: string; declared: string }[];
} {
  // Build undirected adjacency (modularity works on undirected graphs)
  const nodes = allFiles;
  const nodeIdx = new Map<string, number>();
  nodes.forEach((file, idx) => nodeIdx.set(file, idx));

  const adj: Set<number>[] = nodes.map(() => new Set());
  let totalEdges = 0;

  for (const [file, deps] of imports) {
    const fi = nodeIdx.get(file)!;
    for (const dep of deps) {
      const di = nodeIdx.get(dep);
      if (di === undefined || di === fi) continue;
      if (!adj[fi].has(di)) {
        adj[fi].add(di);
        adj[di].add(fi);
        totalEdges++;
      }
    }
  }

  // Degree of each node (undirected)
  const degree = nodes.map((_, i) => adj[i].size);
  const m2 = totalEdges * 2; // 2m

  // Initialize: each node in its own community
  const community = nodes.map((_, i) => i);

  // Louvain phase 1: greedily move nodes to maximize modularity gain
  let improved = true;
  for (let iter = 0; iter < 20 && improved; iter++) {
    improved = false;
    for (let ni = 0; ni < nodes.length; ni++) {
      const currentComm = community[ni];

      // Count edges to each neighboring community
      const commEdges = new Map<number, number>();
      for (const neighbor of adj[ni]) {
        const nc = community[neighbor];
        commEdges.set(nc, (commEdges.get(nc) ?? 0) + 1);
      }

      // Sum of degrees in each candidate community
      const commDegreeSum = new Map<number, number>();
      for (let i = 0; i < nodes.length; i++) {
        const ci = community[i];
        if (commEdges.has(ci) || ci === currentComm) {
          commDegreeSum.set(ci, (commDegreeSum.get(ci) ?? 0) + degree[i]);
        }
      }

      // Find best community
      let bestComm = currentComm;
      let bestGain = 0;

      // Gain of removing from current community
      const kiIn = commEdges.get(currentComm) ?? 0;
      const sigmaCurrentExcl =
        (commDegreeSum.get(currentComm) ?? 0) - degree[ni];

      for (const [candComm, edgesToCand] of commEdges) {
        if (candComm === currentComm) continue;
        const sigmaCand = commDegreeSum.get(candComm) ?? 0;

        // Modularity gain = [edgesToCand/m - ki*sigmaCand/(2m²)] - [kiIn/m - ki*sigmaExcl/(2m²)]
        const gain =
          (edgesToCand - kiIn) / totalEdges -
          (degree[ni] * (sigmaCand - sigmaCurrentExcl)) / (m2 * totalEdges);

        if (gain > bestGain) {
          bestGain = gain;
          bestComm = candComm;
        }
      }

      if (bestComm !== currentComm) {
        community[ni] = bestComm;
        improved = true;
      }
    }
  }

  // Collect clusters
  const clusterMap = new Map<number, string[]>();
  for (let i = 0; i < nodes.length; i++) {
    const ci = community[i];
    if (!clusterMap.has(ci)) clusterMap.set(ci, []);
    clusterMap.get(ci)!.push(nodes[i]);
  }

  // Renumber clusters by size (largest = 0)
  const sorted = [...clusterMap.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );
  const renumber = new Map<number, number>();
  sorted.forEach(([oldId], newId) => renumber.set(oldId, newId));

  const finalClusters = new Map<number, string[]>();
  for (const [oldId, files] of clusterMap) {
    finalClusters.set(renumber.get(oldId)!, files);
  }

  // Build results and diff against declared domains
  const results: ClusterResult[] = nodes.map((file, i) => {
    const clusterId = renumber.get(community[i])!;
    const declared = fileToDomain.get(file) ?? "?";
    return { file, cluster: clusterId, declaredDomain: declared, mismatch: false };
  });

  // For each cluster, find the dominant declared domain
  const clusterDomains = new Map<number, Map<string, number>>();
  for (const res of results) {
    if (!clusterDomains.has(res.cluster))
      clusterDomains.set(res.cluster, new Map());
    const dm = clusterDomains.get(res.cluster)!;
    dm.set(res.declaredDomain, (dm.get(res.declaredDomain) ?? 0) + 1);
  }

  const dominantDomain = new Map<number, string>();
  for (const [clusterId, domCounts] of clusterDomains) {
    let best = "";
    let bestCount = 0;
    for (const [domain, count] of domCounts) {
      if (count > bestCount) {
        bestCount = count;
        best = domain;
      }
    }
    dominantDomain.set(clusterId, best);
  }

  // Mark mismatches
  const domainDiff: { file: string; computed: string; declared: string }[] = [];
  for (const res of results) {
    const computed = dominantDomain.get(res.cluster) ?? "?";
    if (res.declaredDomain !== computed && res.declaredDomain !== "?") {
      res.mismatch = true;
      domainDiff.push({
        file: res.file,
        computed,
        declared: res.declaredDomain,
      });
    }
  }

  return { clusters: finalClusters, results, domainDiff };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface FullReport {
  dsm?: ReturnType<typeof computeDsm>;
  coupling?: CouplingMetrics[];
  clusters?: ReturnType<typeof computeClusters>;
}

const report: FullReport = {};

if (showDsm) {
  report.dsm = computeDsm();
}

if (showCoupling) {
  report.coupling = computeCoupling();
}

if (showClusters) {
  report.clusters = computeClusters();
}

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// Human-readable output

console.log("\n================================================================");
console.log("  Architecture Health Report");
console.log("================================================================\n");
console.log(`  ${allFiles.length} files, ${[...imports.values()].reduce((s, v) => s + v.size, 0)} imports\n`);

if (showDsm && report.dsm) {
  const { violations, lateralCount } = report.dsm;
  console.log("-- 1. Dependency Structure Matrix ------------------------------\n");
  if (violations.length === 0) {
    console.log("  ✔ No upward layer violations\n");
  } else {
    console.log(`  ✘ ${violations.length} upward violation(s):\n`);
    for (const viol of violations) {
      console.log(
        `    ${short(viol.from)} (L${viol.fromLayer} ${viol.fromGroup})`,
      );
      console.log(
        `      → ${short(viol.to)} (L${viol.toLayer} ${viol.toGroup})\n`,
      );
    }
  }
  console.log(`  ${lateralCount} same-layer (lateral) imports\n`);
}

if (showCoupling && report.coupling) {
  const metrics = report.coupling;
  console.log("-- 2. Coupling Metrics ----------------------------------------\n");

  // Top pain points
  const painPoints = metrics.filter((m) => m.pain >= 5);
  if (painPoints.length > 0) {
    console.log(
      "  ⚠ Pain points (concrete + stable + many dependents):\n",
    );
    console.log(
      "    File                                Ca  Ce  I     Pain  Domain",
    );
    console.log(
      "    ----------------------------------  --  --  ----  ----  ------",
    );
    for (const m of painPoints) {
      const name = short(m.file).padEnd(38);
      const ca = String(m.ca).padStart(2);
      const ce = String(m.ce).padStart(2);
      const inst = m.instability.toFixed(2).padStart(4);
      const pain = m.pain.toFixed(1).padStart(4);
      console.log(`    ${name}${ca}  ${ce}  ${inst}  ${pain}  ${m.domain}`);
    }
  } else {
    console.log("  ✔ No high-pain files (threshold: 5.0)\n");
  }

  // Most unstable (many outgoing deps, few incoming)
  const unstable = metrics
    .filter((m) => m.instability >= 0.8 && m.ce >= 5)
    .sort((a, b) => b.ce - a.ce)
    .slice(0, 10);
  if (unstable.length > 0) {
    console.log(
      "\n  Most unstable (many deps, few dependents):\n",
    );
    console.log(
      "    File                                Ca  Ce  I     Domain",
    );
    console.log(
      "    ----------------------------------  --  --  ----  ------",
    );
    for (const m of unstable) {
      const name = short(m.file).padEnd(38);
      const ca = String(m.ca).padStart(2);
      const ce = String(m.ce).padStart(2);
      const inst = m.instability.toFixed(2).padStart(4);
      console.log(`    ${name}${ca}  ${ce}  ${inst}  ${m.domain}`);
    }
  }

  // Abstract + stable (good: widely used type-only files)
  const abstractStable = metrics
    .filter((m) => m.abstract && m.instability <= 0.3 && m.ca >= 3)
    .sort((a, b) => b.ca - a.ca);
  if (abstractStable.length > 0) {
    console.log(
      "\n  ✔ Well-placed abstractions (abstract + stable + used):\n",
    );
    for (const m of abstractStable) {
      console.log(
        `    ${short(m.file)} — ${m.ca} dependents, I=${m.instability}`,
      );
    }
  }
  console.log();
}

if (showClusters && report.clusters) {
  const { clusters, domainDiff } = report.clusters;
  console.log("-- 3. Natural Clustering (Louvain) ----------------------------\n");
  console.log(`  ${clusters.size} clusters discovered:\n`);

  for (const [id, files] of [...clusters.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    // Find dominant domain
    const domainCounts = new Map<string, number>();
    for (const file of files) {
      const domain = fileToDomain.get(file) ?? "?";
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    }
    const domains = [...domainCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([d, c]) => `${d}(${c})`)
      .join(", ");

    console.log(`  Cluster ${id} (${files.length} files) — ${domains}`);
    for (const file of files.sort()) {
      const declared = fileToDomain.get(file) ?? "?";
      const marker = domainDiff.some((d) => d.file === file) ? " ← MISMATCH" : "";
      console.log(`    ${short(file)} [${declared}]${marker}`);
    }
    console.log();
  }

  if (domainDiff.length > 0) {
    console.log("  ⚠ Domain mismatches (file clustered differently than declared):\n");
    for (const diff of domainDiff.sort((a, b) => a.file.localeCompare(b.file))) {
      console.log(
        `    ${short(diff.file)}: declared=${diff.declared}, clustered with=${diff.computed}`,
      );
    }
    console.log();
  } else {
    console.log("  ✔ All files cluster with their declared domain\n");
  }
}
