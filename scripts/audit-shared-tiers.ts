/**
 * Audit: shared/ tier health — inversions + behavior parked below its tier.
 *
 * Companion to rule 9 in `scripts/lint-restricted-imports.ts`. The lint only
 * BLOCKS new inversions (behind a baseline that grandfathers the existing
 * ones), so by design it hides current debt. This audit SURFACES everything,
 * including grandfathered edges, and adds a second pass the lint cannot do.
 *
 * The shared/ dependency DAG is `platform <- core <- {sim, ui}`: platform is
 * zero-dep, core imports only platform, and sim/ui each import core+platform
 * but not each other (disjoint siblings).
 *
 * Section A — TIER INVERSIONS (mechanical, reliable):
 *   Every `shared/<lower>` file importing `shared/<higher>`. This is a
 *   misplaced file or a symbol parked too high — fix by extracting the symbol
 *   down or relocating the file. Catches `system-interfaces` / `types`
 *   (FrameContext.mode) today.
 *
 * Section B — BEHAVIOR BELOW ITS TIER (heuristic, the wall-destroy shape):
 *   A FUNCTION exported from `shared/core` whose consumers are exclusively the
 *   PRESENTATION tier (render/input) — never logic (game/ai),
 *   orchestration (runtime/controllers), net (online/protocol/server), or
 *   another shared/ file. Such a function is rendering/input behavior living
 *   in a lower tier; no inversion exists yet, so the lint is blind to it. This
 *   is exactly what `wallDestroyAnimAt` (consumed only by render) was before
 *   its split. ANY non-presentation consumer exonerates the symbol — runtime
 *   is the orchestrator, not presentation, so a runtime-only function is NOT
 *   flagged; and the wall-destroy DURATION constant legitimately stayed in
 *   core because a shared/ file (battle-types) consumed it. Net-only
 *   de-share candidates are out of scope here — use
 *   `audit-shared-domain-spread.ts` for those.
 *
 * AUDIT-ONLY: always exits 0, no baseline. Section B is heuristic — each hit
 * needs the per-file judgment (is the lone consumer tier its true home?).
 *
 * Usage:
 *   deno run -A scripts/audit-shared-tiers.ts [--json]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import process from "node:process";

interface ImportRec {
  importer: string; // repo-relative path of the importing file
  source: string; // raw module specifier
  target: string | null; // resolved repo-relative target, or null if external
  names: string[]; // named bindings (type-or-value; aliases reduced to local)
  line: number;
}

interface Inversion {
  file: string;
  line: number;
  fromTier: string;
  toTier: string;
  source: string;
}

interface ParkedFn {
  file: string;
  symbol: string;
  consumerDomains: string[];
}

interface ExportRec {
  name: string;
  isFunction: boolean;
}

/** shared/ DAG: each tier may import itself + everything below it. */
const SHARED_TIER_ALLOWED: Record<string, ReadonlySet<string>> = {
  platform: new Set(["platform"]),
  core: new Set(["platform", "core"]),
  sim: new Set(["platform", "core", "sim"]),
  ui: new Set(["platform", "core", "ui"]),
};
const SRC = join(process.cwd(), "src");

main();

function main(): void {
  const asJson = process.argv.includes("--json");
  const files = collectFiles(SRC);

  // One pass: parse every import in src/ with resolved targets.
  const allImports: ImportRec[] = [];
  const exportsByFile = new Map<string, ExportRec[]>();
  for (const file of files) {
    const rel = relative(process.cwd(), file);
    const content = readFileSync(file, "utf8");
    allImports.push(...parseImports(rel, content));
    if (sharedTier(rel)) exportsByFile.set(rel, parseExports(content));
  }

  const inversions = findInversions(allImports);
  const parked = findParkedBehavior(allImports, exportsByFile);

  if (asJson) {
    console.log(JSON.stringify({ inversions, parked }, null, 2));
    return;
  }
  report(inversions, parked);
}

/** Section A: shared lower-tier files importing a higher shared tier. */
function findInversions(imports: ImportRec[]): Inversion[] {
  const out: Inversion[] = [];
  for (const imp of imports) {
    const fromTier = sharedTier(imp.importer);
    if (!fromTier || !imp.target) continue;
    const toTier = sharedTier(imp.target);
    if (!toTier || toTier === fromTier) continue;
    if (SHARED_TIER_ALLOWED[fromTier]!.has(toTier)) continue;
    out.push({
      file: imp.importer,
      line: imp.line,
      fromTier,
      toTier,
      source: imp.source,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Section B: functions in core/sim consumed only by upper (view/net) tiers. */
function findParkedBehavior(
  imports: ImportRec[],
  exportsByFile: Map<string, ExportRec[]>,
): ParkedFn[] {
  // (targetFile -> symbol -> set of consumer domains)
  const consumers = new Map<string, Map<string, Set<string>>>();
  for (const imp of imports) {
    if (!imp.target) continue;
    const dom = domainOf(imp.importer);
    let perSym = consumers.get(imp.target);
    if (!perSym) consumers.set(imp.target, (perSym = new Map()));
    for (const name of imp.names) {
      let set = perSym.get(name);
      if (!set) perSym.set(name, (set = new Set()));
      set.add(dom);
    }
  }

  const out: ParkedFn[] = [];
  for (const [file, exps] of exportsByFile) {
    // core only: render/input can import core freely (that is how
    // wallDestroyAnimAt sat there), but rule 8 fences them out of shared/sim,
    // so a sim function consumed by presentation is impossible — scanning sim
    // here would be vacuous.
    if (sharedTier(file) !== "core") continue;
    const perSym = consumers.get(file);
    for (const exp of exps) {
      if (!exp.isFunction) continue;
      const doms = perSym?.get(exp.name);
      if (!doms || doms.size === 0) continue; // dead / knip's job
      // Exonerated by ANY non-presentation consumer (logic, orchestration,
      // net, shared, entry): something below or beside this tier legitimately
      // needs it, so it is genuine shared vocabulary. Flag only when EVERY
      // consumer is pure presentation (render/input) — the wall-destroy shape.
      const allPresentation = [...doms].every(
        (d) => tierOfDomain(d) === "presentation",
      );
      if (!allPresentation) continue;
      out.push({ file, symbol: exp.name, consumerDomains: [...doms].sort() });
    }
  }
  return out.sort(
    (a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
  );
}

function report(inversions: Inversion[], parked: ParkedFn[]): void {
  console.log("=== Section A — tier inversions (shared lower -> higher) ===");
  console.log("    DAG: platform <- core <- {sim, ui}\n");
  if (inversions.length === 0) {
    console.log("  none\n");
  } else {
    for (const inv of inversions) {
      console.log(
        `  ${inv.file}:${inv.line}  ${inv.fromTier} -> ${inv.toTier}  ("${inv.source}")`,
      );
    }
    console.log(
      `\n  ${inversions.length} inversion(s). Fix: extract the imported symbol DOWN to the lower tier, or relocate the importing file.\n`,
    );
  }

  console.log("=== Section B — behavior parked below its tier (heuristic) ===");
  console.log(
    "    core functions consumed ONLY by presentation (render/input) — never",
  );
  console.log(
    "    by logic/orchestration/net/shared. The wall-destroy shape. (sim is",
  );
  console.log("    fenced from render/input by rule 8, so it is core-only.)\n");
  if (parked.length === 0) {
    console.log("  none\n");
  } else {
    for (const p of parked) {
      console.log(
        `  ${p.file}  ${p.symbol}()  -> ${p.consumerDomains.join(", ")}`,
      );
    }
    console.log(
      `\n  ${parked.length} candidate(s). Heuristic — confirm each: is the lone consumer tier its true home? If so, move the function there.\n`,
    );
  }
}

function sharedTier(rel: string): string | null {
  const m = rel.match(/^src\/shared\/(core|sim|ui|platform)\//);
  return m ? m[1]! : null;
}

function domainOf(rel: string): string {
  if (rel.startsWith("src/shared/")) return "shared";
  const m = rel.match(/^src\/([^/]+)\//);
  return m ? m[1]! : "entry"; // src/<root>.ts entries
}

/** Two-way split for Section B. `presentation` (render/input) is pure
 *  rendering + raw input — a core/sim function used ONLY here is behavior
 *  parked below its tier. Everything else is `exempt`: logic (game/ai) and
 *  orchestration (runtime/controllers) legitimately drive the sim; net
 *  (online/protocol/server) is the serialize boundary; shared is internal
 *  vocabulary; entry roots compose. A single exempt consumer exonerates a
 *  symbol. (runtime is the orchestrator, NOT presentation — runtime-only
 *  consumption is expected and must not be flagged.) */
function tierOfDomain(domain: string): string {
  return domain === "render" || domain === "input" ? "presentation" : "exempt";
}

function parseImports(importer: string, content: string): ImportRec[] {
  const out: ImportRec[] = [];
  const re = /import\s+(type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const declType = !!m[1];
    const clause = m[2]!;
    const source = m[3]!;
    const line = content.slice(0, m.index).split("\n").length;
    out.push({
      importer,
      source,
      target: resolveTarget(importer, source),
      names: parseNames(clause, declType),
      line,
    });
  }
  return out;
}

function parseNames(clause: string, declType: boolean): string[] {
  const brace = clause.match(/\{([\s\S]*)\}/);
  if (!brace) return []; // default / namespace imports — not name-tracked
  const names: string[] = [];
  for (const raw of brace[1]!.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const cleaned = part.replace(/^type\s+/, "");
    names.push(cleaned.split(/\s+as\s+/)[0]!.trim());
  }
  void declType;
  return names;
}

function resolveTarget(importer: string, source: string): string | null {
  if (!source.startsWith(".")) return null; // external package
  let resolved = normalize(join(dirname(importer), source));
  if (!resolved.endsWith(".ts")) resolved += ".ts";
  return resolved;
}

function parseExports(content: string): ExportRec[] {
  const out: ExportRec[] = [];
  const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  const constFnRe =
    /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/g;
  const dataRe =
    /export\s+(?:const|let|interface|type|enum|class)\s+([A-Za-z_$][\w$]*)/g;
  const fnNames = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(content)) !== null) fnNames.add(m[1]!);
  while ((m = constFnRe.exec(content)) !== null) fnNames.add(m[1]!);
  const seen = new Set<string>();
  for (const name of fnNames) {
    out.push({ name, isFunction: true });
    seen.add(name);
  }
  while ((m = dataRe.exec(content)) !== null) {
    if (!seen.has(m[1]!)) out.push({ name: m[1]!, isFunction: false });
  }
  return out;
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...collectFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
      results.push(full);
  }
  return results;
}
