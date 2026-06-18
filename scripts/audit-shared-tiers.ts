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
 * Section C — WRITE-SURFACE PARKED IN CORE (heuristic, the player-rules shape):
 *   A `shared/core` function that MUTATES one of its parameters (assigns to a
 *   param property, or calls a mutating method on it — directly or via an
 *   `as`-cast alias). Deterministic write behavior over a game struct is what
 *   `shared/sim/` is for ("the struct modules in core/ carry no logic, so the
 *   write-surfaces live [in sim]"). This is the core<->sim axis Section B
 *   (core<->ui) is blind to — it found `selectPlayerTower` after `player-rules`
 *   moved by hand. NOTE the false-positive classes the report names: a
 *   write-surface is not automatically a SIM write-surface — GameState
 *   constructor-setters (setGameMode) and cosmetic animation agers
 *   (ageImpacts) mutate params too but legitimately stay in core.
 *
 * Section D — STATIC VOCABULARY PARKED IN SIM (heuristic, the pieces shape):
 *   The symmetric inverse of C — a `shared/sim` function that is PURE (no Rng,
 *   mutates no param) yet takes ≥1 parameter, none typed as a live game-state
 *   struct (`LIVE_STATE_TYPES`). It operates on static DEFINITIONS, not state
 *   (`rotateCW(piece: PieceShape)`), so it is determinism-irrelevant vocabulary
 *   over-fenced in sim and could move down to core. The hard part is the FP
 *   wall: sim legitimately holds pure board QUERIES (`hasWallAt`,
 *   `isCannonCaptured`) — they are excluded because they take a live-state
 *   param. The live-state filter is what makes this axis tool-able rather than
 *   a noisy "any pure sim fn" flag; it is intentionally generous (substring
 *   match) to miss-rather-than-misflag.
 *
 * AUDIT-ONLY: always exits 0, no baseline. Sections B/C/D are heuristic — each
 * hit needs the per-symbol judgment the report describes.
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

interface ParkedMutator {
  file: string;
  symbol: string;
  /** The mutation site that proves it writes its argument. */
  evidence: string;
}

interface ParkedVocab {
  file: string;
  symbol: string;
  /** The param list that shows it operates on static definitions, not state. */
  params: string;
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
/** Mutating methods that, called on a parameter (or a property of one),
 *  prove the function writes through its argument. */
const MUTATING_METHODS =
  "add|delete|clear|set|push|pop|shift|unshift|splice|sort|reverse|fill";
/** Live game-state struct names. A sim function whose params name one of these
 *  operates on evolving game state (a query/behavior that belongs in sim);
 *  matched as a SUBSTRING (no `\b`) so compound types — `CapturedCannonState`,
 *  `GameViewState`, `ValidPlayerId` — all count, biasing Section D toward
 *  false-NEGATIVES (miss a candidate) over false-positives (wrongly flag a
 *  legitimate board query). The list is the curated heart of the heuristic. */
const LIVE_STATE_TYPES =
  /Player|GameState|GameViewState|BuildViewState|CannonViewState|BattleViewState|ModernState|LobbyState|SelectionState|Cannon|Grunt|BurningPit|Tower|House|BonusSquare|BagState|OccupancyCache/;

main();

function main(): void {
  const asJson = process.argv.includes("--json");
  const files = collectFiles(SRC);

  // One pass: parse every import in src/ with resolved targets, and keep
  // the raw text of each shared/core file (Section C needs function bodies).
  const allImports: ImportRec[] = [];
  const exportsByFile = new Map<string, ExportRec[]>();
  const coreContent = new Map<string, string>();
  const simContent = new Map<string, string>();
  for (const file of files) {
    const rel = relative(process.cwd(), file);
    const content = readFileSync(file, "utf8");
    allImports.push(...parseImports(rel, content));
    if (sharedTier(rel)) exportsByFile.set(rel, parseExports(content));
    if (sharedTier(rel) === "core") coreContent.set(rel, content);
    if (sharedTier(rel) === "sim") simContent.set(rel, content);
  }

  const inversions = findInversions(allImports);
  const parked = findParkedBehavior(allImports, exportsByFile);
  const mutators = findParkedMutators(coreContent);
  const vocab = findParkedVocabulary(simContent);

  if (asJson) {
    console.log(
      JSON.stringify({ inversions, parked, mutators, vocab }, null, 2),
    );
    return;
  }
  report(inversions, parked, mutators, vocab);
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

/** Section C: write-surfaces parked in core that belong in sim. A `shared/core`
 *  function that MUTATES one of its parameters (assigns to a param property, or
 *  calls a mutating method on it — directly or via an `as`-cast alias) is
 *  deterministic write behavior over a game struct. The README reserves that
 *  for `shared/sim/` ("the struct modules in core/ carry no logic, so the
 *  write-surfaces live [in sim]") — it is exactly what `player-rules.ts` was
 *  before it moved. This is the core<->sim axis Section B (core<->ui) cannot
 *  see. Heuristic: brace/paren-balanced body scan, so string/comment braces or
 *  object return types can occasionally skew a body slice. */
function findParkedMutators(coreContent: Map<string, string>): ParkedMutator[] {
  const out: ParkedMutator[] = [];
  for (const [file, content] of coreContent) {
    for (const fn of extractFunctions(content)) {
      const evidence = mutatesParam(fn.params, fn.body);
      if (evidence) out.push({ file, symbol: fn.name, evidence });
    }
  }
  return out.sort(
    (a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
  );
}

/** Section D: static vocabulary parked in sim that belongs in core — the
 *  symmetric inverse of Section C, and the axis that hid the pieces shape
 *  catalog / rotation from every other tool. A `shared/sim` function is a
 *  candidate when it is PURE (consumes no Rng AND mutates no param — the
 *  opposite of what earns a place in sim) yet still takes ≥1 parameter, none
 *  of whose types name a live game-state struct (`LIVE_STATE_TYPES`). Such a
 *  function operates on static DEFINITIONS (e.g. `rotateCW(piece: PieceShape)`),
 *  not evolving state, so it is determinism-irrelevant vocabulary over-fenced
 *  in sim. The ≥1-param rule excludes pure zero-arg producers (`initialLives`),
 *  which are cohesive with their write-surface cluster; the live-state filter
 *  excludes the legitimate pure board queries (`hasWallAt(state: …)`,
 *  `isCannonCaptured(…, cannon: Cannon)`). Heuristic — the candidate still
 *  needs the cohesion judgment (does it share data with sim behavior?). */
function findParkedVocabulary(simContent: Map<string, string>): ParkedVocab[] {
  const out: ParkedVocab[] = [];
  for (const [file, content] of simContent) {
    for (const fn of extractFunctions(content)) {
      if (touchesRng(fn.params, fn.body)) continue; // genuine sim (RNG draw)
      if (mutatesParam(fn.params, fn.body)) continue; // genuine sim (write)
      if (parseParamNames(fn.params).length === 0) continue; // zero-arg producer
      if (LIVE_STATE_TYPES.test(fn.params)) continue; // operates on live state
      out.push({ file, symbol: fn.name, params: collapse(fn.params) });
    }
  }
  return out.sort(
    (a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
  );
}

/** True when a function consumes randomness — a parameter typed `Rng`, or any
 *  `rng` reference in the body. RNG consumption is the headline sim signal. */
function touchesRng(params: string, body: string): boolean {
  return /\bRng\b/.test(params) || /\brng\b/.test(body);
}

/** Pull exported function declarations with their param list + body text,
 *  via paren/brace balancing. Skips overload signatures (no body). */
function extractFunctions(
  content: string,
): { name: string; params: string; body: string }[] {
  const out: { name: string; params: string; body: string }[] = [];
  const head =
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(content)) !== null) {
    const name = m[1]!;
    const params = balanced(content, head.lastIndex - 1, "(", ")");
    if (!params) continue;
    // Walk past the return type to the body's opening brace. An overload
    // (signature ending in `;` before any `{`) has no body — skip it.
    let i = params.end;
    while (i < content.length && content[i] !== "{" && content[i] !== ";") i++;
    if (content[i] !== "{") continue;
    const body = balanced(content, i, "{", "}");
    if (!body) continue;
    out.push({ name, params: params.text, body: body.text });
  }
  return out;
}

/** Return the substring inside the balanced `open`/`close` pair that starts at
 *  `start`, plus the index just past the closing delimiter. */
function balanced(
  source: string,
  start: number,
  open: string,
  close: string,
): { text: string; end: number } | null {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === open) depth++;
    else if (c === close && --depth === 0) {
      return { text: source.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** If the body writes through a parameter, return the proving snippet; else
 *  null. Tracks `const alias = param as T` / `const alias = param` aliases so
 *  the common `const w = player as Writable; w.lives = …` shape is caught. */
function mutatesParam(paramList: string, body: string): string | null {
  const names = new Set(parseParamNames(paramList));
  if (names.size === 0) return null;
  for (const m of body.matchAll(
    /(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*(?:as\b|;)/g,
  )) {
    if (names.has(m[2]!)) names.add(m[1]!);
  }
  for (const name of names) {
    // `name.prop = …` (incl. compound `+=`), excluding ==, =>, <=, >=.
    const assign = new RegExp(
      `\\b${name}(?:\\.\\w+)+\\s*[+\\-*/]?=(?![=>])`,
    ).exec(body);
    if (assign) return collapse(assign[0]);
    const method = new RegExp(
      `\\b${name}(?:\\.\\w+)*\\.(?:${MUTATING_METHODS})\\s*\\(`,
    ).exec(body);
    if (method) return collapse(method[0]);
  }
  return null;
}

/** Extract bare parameter identifiers from a param list (drops types,
 *  defaults, destructuring, `this`). */
function parseParamNames(paramList: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of paramList) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      pushParamName(current, names);
      current = "";
      continue;
    }
    current += ch;
  }
  pushParamName(current, names);
  return names;
}

function pushParamName(raw: string, out: string[]): void {
  const name = raw
    .trim()
    .replace(/^(?:readonly\s+)?/, "")
    .match(/^([A-Za-z_$][\w$]*)/)?.[1];
  if (name && name !== "this") out.push(name);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function report(
  inversions: Inversion[],
  parked: ParkedFn[],
  mutators: ParkedMutator[],
  vocab: ParkedVocab[],
): void {
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

  console.log(
    "=== Section C — write-surfaces parked in core (should be sim) ===",
  );
  console.log(
    "    core functions that MUTATE a parameter (assign to a param property",
  );
  console.log(
    "    or call a mutating method on it). Deterministic write behavior over a",
  );
  console.log(
    "    game struct belongs in shared/sim/ — the player-rules shape.\n",
  );
  if (mutators.length === 0) {
    console.log("  none\n");
  } else {
    for (const mut of mutators) {
      console.log(`  ${mut.file}  ${mut.symbol}()   [${mut.evidence}]`);
    }
    console.log(
      `\n  ${mutators.length} candidate(s). Heuristic — "write-surface" is not\n` +
        '  the same as "deterministic-sim write-surface." Classify each:\n' +
        "    (a) cross-domain deterministic mutation of a game struct → move to sim\n" +
        "        (the player-rules / selectPlayerTower shape);\n" +
        "    (b) state-assembly helper cohesive with its type, e.g. a GameState\n" +
        "        constructor-setter like setGameMode → leave;\n" +
        "    (c) cosmetic/animation state aged each frame (ageImpacts) → leave;\n" +
        "        it belongs with its anim state, NOT the deterministic sim.\n",
    );
  }

  console.log(
    "=== Section D — static vocabulary parked in sim (could be core) ===",
  );
  console.log(
    "    pure sim functions (no Rng, no param mutation) that take ≥1 param,",
  );
  console.log(
    "    none typed as a live game-state struct — they operate on static",
  );
  console.log(
    "    definitions (PieceShape), not state. The inverse of Section C.\n",
  );
  if (vocab.length === 0) {
    console.log("  none\n");
  } else {
    for (const v of vocab) {
      console.log(`  ${v.file}  ${v.symbol}(${v.params})`);
    }
    console.log(
      `\n  ${vocab.length} candidate(s). Heuristic — purity alone is not\n` +
        "  misplacement (sim holds pure board QUERIES by design; those take a\n" +
        "  live-state param and are excluded). Confirm each: is it determinism-\n" +
        "  irrelevant vocabulary that shares no data with the sim behavior around\n" +
        "  it? If so, move it to core with the types it operates on.\n",
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
