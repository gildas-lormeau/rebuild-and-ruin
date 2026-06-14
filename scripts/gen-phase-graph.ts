/**
 * gen-phase-graph — derive the runtime phase-transition graph from
 * `src/runtime/phase-machine.ts` and emit `docs/runtime-phase-graph.md`.
 *
 * The phase machine is a data-driven `TRANSITIONS` table: each entry has a
 * `from` guard, a `mutate` that calls an `enter*Phase` helper (the target
 * phase) plus engine ops and `ctx.broadcast?.X` markers, ordered `display`
 * steps, and a `postDisplay` that routes onward via `runTransitionInline`.
 * This script parses that structure with ts-morph and renders:
 *
 *   1. A Mermaid `stateDiagram-v2` of phase → phase edges (labelled by the
 *      transition that drives them).
 *   2. A per-transition record table (guard / enters / engine ops /
 *      broadcasts / display / dispatch targets / external dispatchers).
 *
 * The artifact is for *review*: it lets an agent reviewing the runtime check
 * the phase flow for holes (missing edge, mis-ordered finalize, a transition
 * that enters no phase) against a generated map instead of tracing call
 * chains by hand. See docs/runtime-invariants.md (R1, R3).
 *
 * Usage:
 *   deno run -A scripts/gen-phase-graph.ts            # write the doc
 *   deno run -A scripts/gen-phase-graph.ts --check    # fail if stale (CI)
 */

import { Project, SyntaxKind } from "ts-morph";

interface TransitionRecord {
  readonly id: string;
  readonly fromPhases: readonly string[];
  /** Phase entered by an `enter*Phase` call in mutate, or null for prep
   *  transitions that route onward without entering a phase themselves. */
  readonly entersPhase: string | null;
  readonly engineOps: readonly string[];
  readonly broadcasts: readonly string[];
  readonly display: readonly string[];
  /** Transition ids reached via `runTransitionInline`/`runTransition` in
   *  postDisplay (resolving a named route helper one level). */
  readonly dispatchTargets: readonly string[];
  /** True when postDisplay routes through `ctx.*Route` handlers (see
   *  CTX_ROUTE_EDGES) — its real targets are not statically derivable. */
  readonly ctxRouted: boolean;
}

const MACHINE_FILE = "src/runtime/phase-machine.ts";
const TICKS_FILE = "src/runtime/subsystems/phase-ticks.ts";
const ENTRY_FILE = "src/game/phase-entry.ts";
const OUT_FILE = "docs/runtime-phase-graph.md";
/** `enter*Phase` helper → the phase it enters. The machine never imports the
 *  Phase values these map to as data, so the mapping is declared here — but
 *  it is NOT trusted: `verifyEnterPhaseMap` derives the same mapping from the
 *  `setPhase(state, Phase.X)` calls in `game/phase-entry.ts` and fails the run
 *  on any mismatch, a new unmapped helper, or a stale entry. So a phase rename
 *  breaks the build instead of silently mislabeling the graph. */
const ENTER_PHASE: Record<string, string> = {
  enterCannonPhase: "CANNON_PLACE",
  enterModifierRevealPhase: "MODIFIER_REVEAL",
  enterBattlePhase: "BATTLE",
  enterUpgradePickPhase: "UPGRADE_PICK",
  enterWallBuildPhase: "WALL_BUILD",
  enterSelectionPhase: "CASTLE_SELECT",
};
/** Transitions whose onward routing happens through `ctx.*Route` handlers
 *  wired in phase-ticks.ts, not through a static `runTransitionInline`. These
 *  edges are NOT derivable from phase-machine.ts alone, so they are declared
 *  here and rendered as dashed/annotated edges. Keep in sync if the life-lost
 *  routing changes — the doc labels them "declared, not derived" so a reader
 *  knows to verify them manually. */
const CTX_ROUTE_EDGES: Record<string, { target: string; label: string }[]> = {
  "round-end": [
    { target: "[*]", label: "game-over" },
    { target: "CASTLE_SELECT", label: "reselect" },
    { target: "CANNON_PLACE", label: "continue → advance-to-cannon" },
  ],
};

await main();

async function main(): Promise<void> {
  const check = Deno.args.includes("--check");

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: false },
  });
  const machine = project.addSourceFileAtPath(MACHINE_FILE);

  // Verify the declared ENTER_PHASE map against ground truth BEFORE rendering —
  // a wrong-but-consistent map would otherwise produce a deterministic (and
  // silently mislabeled) graph that --check happily accepts.
  verifyEnterPhaseMap(project.addSourceFileAtPath(ENTRY_FILE));

  const gameOps = collectGameOps(machine);
  const stringConsts = collectStringConsts(machine);
  const records = collectTransitions(machine, gameOps, stringConsts);
  const externals = collectExternalDispatchers();

  const doc = render(records, externals);

  if (check) {
    const current = await readOrEmpty(OUT_FILE);
    if (current.trimEnd() !== doc.trimEnd()) {
      console.error(
        `✗ ${OUT_FILE} is stale. Run: deno run -A scripts/gen-phase-graph.ts`,
      );
      Deno.exit(1);
    }
    console.log(`✓ ${OUT_FILE} is up to date`);
    return;
  }

  await Deno.writeTextFile(OUT_FILE, doc);
  console.log(`✓ wrote ${OUT_FILE} (${records.length} transitions)`);
}

/** The set of identifiers imported from `../game/index.ts` — used to classify
 *  which calls inside a mutate body are engine ops worth surfacing. */
function collectGameOps(machine: import("ts-morph").SourceFile): Set<string> {
  const ops = new Set<string>();
  for (const imp of machine.getImportDeclarations()) {
    if (!imp.getModuleSpecifierValue().endsWith("game/index.ts")) continue;
    for (const named of imp.getNamedImports()) {
      // Type-only members (GameOverOutcome) are filtered: they're not calls.
      if (!named.isTypeOnly()) ops.add(named.getName());
    }
  }
  return ops;
}

/** Module-level `const NAME = "value"` (optionally `as const`) declarations —
 *  used to resolve `display` step `kind`s, which reference the `STEP_*`
 *  string consts rather than inlining the literal. */
function collectStringConsts(
  machine: import("ts-morph").SourceFile,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of machine.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init) continue;
    const match = /^["'](.+)["'](?:\s+as\s+const)?$/.exec(init.getText());
    if (match) out.set(decl.getName(), match[1]);
  }
  return out;
}

/** Derive `enter*Phase → phase` from `game/phase-entry.ts` and assert it
 *  matches the declared ENTER_PHASE map. Fails the run (exit 1) on a
 *  mismatch, a new exported `enter*Phase` helper missing from the map, or a
 *  declared entry with no matching helper. This is what turns ENTER_PHASE from
 *  a trusted constant into a checked one — without it, `--check` only guards
 *  output drift, not a wrong-but-consistent declaration. */
function verifyEnterPhaseMap(entry: import("ts-morph").SourceFile): void {
  const fns = entry.getFunctions();
  const names = new Set(fns.map((fn) => fn.getName()).filter(Boolean));
  // Only EXPORTED enter*Phase helpers are public entry points the machine
  // calls; private helpers (e.g. enterCannonPlacePhase) are resolution hops,
  // not map entries.
  const exported = new Set(
    fns.filter((fn) => fn.isExported()).map((fn) => fn.getName()),
  );

  // Each function's own first `setPhase(state, Phase.X)` target, if any.
  const directTarget = new Map<string, string | null>();
  const calleesOf = new Map<string, string[]>();
  for (const fn of fns) {
    const name = fn.getName();
    if (!name) continue;
    const body = fn.getBodyText() ?? "";
    const direct = /setPhase\(\s*state\s*,\s*Phase\.(\w+)\s*\)/.exec(body);
    directTarget.set(name, direct ? direct[1] : null);
    const callees = [...body.matchAll(/\b(\w+)\s*\(/g)]
      .map((match) => match[1])
      .filter((callee) => callee !== name && names.has(callee));
    calleesOf.set(name, callees);
  }

  // Effective target: own setPhase, else the first local helper it calls that
  // resolves to one (covers enterCannonPhase → enterCannonPlacePhase).
  const resolve = (name: string, seen: Set<string>): string | null => {
    if (seen.has(name)) return null;
    seen.add(name);
    const own = directTarget.get(name);
    if (own) return own;
    for (const callee of calleesOf.get(name) ?? []) {
      const viaCallee = resolve(callee, seen);
      if (viaCallee) return viaCallee;
    }
    return null;
  };

  const errors: string[] = [];
  const derived = new Map<string, string>();
  for (const name of names) {
    if (!exported.has(name) || !/^enter\w+Phase$/.test(name ?? "")) continue;
    const target = resolve(name!, new Set());
    if (!target) continue; // not a phase-entering helper
    derived.set(name!, target);
    const declared = ENTER_PHASE[name!];
    if (!declared) {
      errors.push(`  ${name} enters ${target} but is MISSING from ENTER_PHASE`);
    } else if (declared !== target) {
      errors.push(
        `  ${name}: declared ${declared}, but actually sets Phase.${target}`,
      );
    }
  }
  for (const name of Object.keys(ENTER_PHASE)) {
    if (!derived.has(name)) {
      errors.push(
        `  ${name} is in ENTER_PHASE but no such helper sets a phase`,
      );
    }
  }

  if (errors.length) {
    console.error(
      `✗ ENTER_PHASE map is out of sync with ${ENTRY_FILE}:\n${errors.join("\n")}`,
    );
    Deno.exit(1);
  }
}

function collectTransitions(
  machine: import("ts-morph").SourceFile,
  gameOps: Set<string>,
  stringConsts: Map<string, string>,
): TransitionRecord[] {
  const records: TransitionRecord[] = [];

  for (const decl of machine.getVariableDeclarations()) {
    if (decl.getTypeNode()?.getText() !== "Transition") continue;
    const obj = decl.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
    if (!obj) continue;

    const id = stringProp(obj, "id");
    if (!id) continue;

    const fromPhases = parseFrom(propText(obj, "from"));
    const mutateText = `${propText(obj, "mutate")}\n${propText(obj, "postMutate")}`;
    const entersPhase = firstEnterPhase(mutateText);
    const engineOps = callsIn(mutateText, gameOps);
    const broadcasts = broadcastsIn(mutateText);
    const display = parseDisplay(obj, stringConsts);

    const { targets, ctxRouted } = parsePostDisplay(obj, machine);

    records.push({
      id,
      fromPhases,
      entersPhase,
      engineOps,
      broadcasts,
      display,
      dispatchTargets: targets,
      ctxRouted,
    });
  }

  return records;
}

/** Grep phase-ticks.ts for `runTransition("id", ...)` sites — the tick-driven
 *  (timer / drained-action) dispatchers that kick each transition. */
function collectExternalDispatchers(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let text: string;
  try {
    text = Deno.readTextFileSync(TICKS_FILE);
  } catch {
    return out;
  }
  const lines = text.split("\n");
  const re = /runTransition\(\s*"([^"]+)"/;
  lines.forEach((line, idx) => {
    const match = re.exec(line);
    if (!match) return;
    const id = match[1];
    const loc = `phase-ticks.ts:${idx + 1}`;
    const list = out.get(id) ?? [];
    list.push(loc);
    out.set(id, list);
  });
  return out;
}

/** `Phase.WALL_BUILD` → ["WALL_BUILD"]; `[Phase.A, Phase.B]` → ["A","B"];
 *  `"*"` → ["*"]. */
function parseFrom(raw: string): string[] {
  if (raw === '"*"' || raw === "'*'") return ["*"];
  const phases = [...raw.matchAll(/Phase\.(\w+)/g)].map((match) => match[1]);
  return phases.length ? phases : [raw];
}

function firstEnterPhase(body: string): string | null {
  const match = /\benter(\w+Phase)\s*\(/.exec(body);
  if (!match) return null;
  const fn = `enter${match[1]}`;
  return ENTER_PHASE[fn] ?? fn;
}

function callsIn(body: string, names: Set<string>): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\b(\w+)\s*\(/g)) {
    if (names.has(match[1])) found.add(match[1]);
  }
  return [...found];
}

function broadcastsIn(body: string): string[] {
  const found = new Set<string>();
  // Matches `ctx.broadcast?.buildEnd?.()` — capture the marker name; the
  // trailing `?.()` invocation shape is irrelevant.
  for (const match of body.matchAll(/broadcast\?\.(\w+)/g)) {
    found.add(match[1]);
  }
  return [...found];
}

function parseDisplay(
  obj: import("ts-morph").ObjectLiteralExpression,
  stringConsts: Map<string, string>,
): string[] {
  const arr = getProp(obj, "display")?.getInitializerIfKind(
    SyntaxKind.ArrayLiteralExpression,
  );
  if (!arr) return [];
  const steps: string[] = [];
  for (const el of arr.getElements()) {
    const stepObj = el.asKind(SyntaxKind.ObjectLiteralExpression);
    if (!stepObj) continue;
    // `kind` references a STEP_* const, not a literal — resolve it.
    const kindRaw = propText(stepObj, "kind");
    const kind =
      stringConsts.get(kindRaw) ?? stringProp(stepObj, "kind") ?? "?";
    const banner = stringProp(stepObj, "bannerKind");
    steps.push(banner ? `${kind}(${banner})` : kind);
  }
  return steps;
}

function stringProp(
  obj: import("ts-morph").ObjectLiteralExpression,
  name: string,
): string | null {
  const raw = propText(obj, name);
  const match = /^["'](.+)["']$/.exec(raw);
  return match ? match[1] : null;
}

function propText(
  obj: import("ts-morph").ObjectLiteralExpression,
  name: string,
): string {
  return getProp(obj, name)?.getInitializer()?.getText() ?? "";
}

/** Resolve postDisplay's onward dispatch targets. postDisplay is either an
 *  inline arrow (scan its body) or a named helper identifier (resolve the
 *  function declaration in the same file, scan ITS body) for
 *  `runTransitionInline`/`runTransition` string-literal targets. Flags
 *  ctx-routed transitions (life-lost routing) whose targets aren't static. */
function parsePostDisplay(
  obj: import("ts-morph").ObjectLiteralExpression,
  machine: import("ts-morph").SourceFile,
): { targets: string[]; ctxRouted: boolean } {
  const init = getProp(obj, "postDisplay")?.getInitializer();
  if (!init) return { targets: [], ctxRouted: false };

  let body = init.getText();
  // Named helper: resolve its declaration and use its body instead.
  if (init.getKind() === SyntaxKind.Identifier) {
    const fn = machine.getFunction(init.getText());
    if (fn) body = fn.getText();
  }

  const targets = new Set<string>();
  for (const match of body.matchAll(
    /runTransition(?:Inline)?\(\s*"([^"]+)"/g,
  )) {
    targets.add(match[1]);
  }
  const ctxRouted = /\b(lifeLostRoute|resolveAfterLifeLost)\b/.test(body);
  return { targets: [...targets], ctxRouted };
}

function getProp(
  obj: import("ts-morph").ObjectLiteralExpression,
  name: string,
): import("ts-morph").PropertyAssignment | undefined {
  const prop = obj.getProperty(name);
  return prop?.asKind(SyntaxKind.PropertyAssignment);
}

function render(
  records: readonly TransitionRecord[],
  externals: Map<string, string[]>,
): string {
  const byId = new Map(records.map((r) => [r.id, r] as const));
  const lines: string[] = [];

  lines.push("# Runtime phase-transition graph");
  lines.push("");
  lines.push("<!-- GENERATED by scripts/gen-phase-graph.ts — DO NOT EDIT.");
  lines.push("     Regenerate after editing src/runtime/phase-machine.ts:");
  lines.push("       deno run -A scripts/gen-phase-graph.ts -->");
  lines.push("");
  lines.push(
    "Derived from the `TRANSITIONS` table in " +
      "[`src/runtime/phase-machine.ts`](../src/runtime/phase-machine.ts). " +
      "A review aid for the phase flow — see " +
      "[runtime-invariants.md](runtime-invariants.md) (R1, R3).",
  );
  lines.push("");

  // ── Mermaid ──
  lines.push("## Phase flow");
  lines.push("");
  lines.push("```mermaid");
  lines.push("stateDiagram-v2");
  for (const edge of buildPhaseEdges(records, byId)) {
    lines.push(`  ${edge}`);
  }
  lines.push("```");
  lines.push("");
  lines.push(
    "> Dashed/annotated `round-end` exits route through `ctx.lifeLostRoute` " +
      "handlers wired in `phase-ticks.ts` — **declared, not derived** from " +
      "the machine. Verify those manually.",
  );
  lines.push("");

  // ── Per-transition records ──
  lines.push("## Transitions");
  lines.push("");
  for (const r of records) {
    lines.push(`### \`${r.id}\``);
    lines.push("");
    lines.push(`- **guard (from):** ${fmtList(r.fromPhases)}`);
    lines.push(
      `- **enters phase:** ${r.entersPhase ?? "— (prep; routes onward)"}`,
    );
    lines.push(`- **engine ops:** ${fmtList(r.engineOps)}`);
    lines.push(`- **broadcasts:** ${fmtList(r.broadcasts)}`);
    lines.push(`- **display:** ${fmtList(r.display)}`);
    const dispatch = r.ctxRouted
      ? [
          ...r.dispatchTargets,
          "_ctx.lifeLostRoute → game-over / reselect / advance-to-cannon_",
        ]
      : r.dispatchTargets;
    lines.push(`- **dispatches:** ${fmtList(dispatch)}`);
    lines.push(`- **external dispatchers:** ${fmtList(externals.get(r.id))}`);
    lines.push("");
  }

  // ── Coverage notes (auto-derived review hints) ──
  lines.push("## Review hints (auto-derived)");
  lines.push("");
  const entered = new Set(
    records.flatMap((r) => (r.entersPhase ? [r.entersPhase] : [])),
  );
  const allPhases = new Set(
    records.flatMap((r) => r.fromPhases.filter((p) => p !== "*")),
  );
  const externalOnly = [...allPhases].filter((p) => !entered.has(p)).sort();
  lines.push(
    "- **Phases entered only from outside the machine:** " +
      fmtList(externalOnly) +
      " — these are entered by a subsystem (e.g. `selection`), not by any " +
      "`enter*Phase` inside `phase-machine.ts`. Confirm their entry path.",
  );
  const noExternal = records
    .filter((r) => !externals.has(r.id) && r.fromPhases[0] !== "*")
    .map((r) => r.id);
  lines.push(
    "- **Transitions with no tick-driven dispatcher in `phase-ticks.ts`:** " +
      fmtList(noExternal) +
      " — reached only via another transition's postDisplay (inline routing).",
  );
  lines.push("");

  return `${lines.join("\n")}\n`;
}

/** Phase → phase Mermaid edges. Each transition contributes
 *  `from --> resolvedTarget : id`. Targets resolve transitively through
 *  prep-transition dispatch chains; ctx-routed transitions use the declared
 *  CTX_ROUTE_EDGES fallback. */
function buildPhaseEdges(
  records: readonly TransitionRecord[],
  byId: ReadonlyMap<string, TransitionRecord>,
): string[] {
  const edges: string[] = [];
  const seen = new Set<string>();
  const push = (from: string, to: string, label: string): void => {
    const key = `${from}>${to}:${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(`${node(from)} --> ${node(to)}: ${label}`);
  };

  for (const r of records) {
    const sources = r.fromPhases.map((p) => (p === "*" ? "[*]" : p));
    if (CTX_ROUTE_EDGES[r.id]) {
      for (const src of sources) {
        for (const e of CTX_ROUTE_EDGES[r.id]) {
          push(src, e.target, `${r.id} (${e.label})`);
        }
      }
      continue;
    }
    const targets = resolveTargets(r, byId, new Set());
    for (const src of sources) {
      for (const tgt of targets.size ? [...targets] : ["[*]"]) {
        push(src, tgt, r.id);
      }
    }
  }
  return edges;
}

/** A transition's target phase(s): its own `enters` phase, else the union of
 *  its dispatch targets' resolved phases (following prep chains). */
function resolveTargets(
  r: TransitionRecord,
  byId: ReadonlyMap<string, TransitionRecord>,
  guard: Set<string>,
): Set<string> {
  if (r.entersPhase) return new Set([r.entersPhase]);
  if (guard.has(r.id)) return new Set();
  guard.add(r.id);
  const out = new Set<string>();
  for (const targetId of r.dispatchTargets) {
    const target = byId.get(targetId);
    if (!target) continue;
    for (const phase of resolveTargets(target, byId, guard)) out.add(phase);
  }
  return out;
}

function node(phase: string): string {
  return phase === "[*]" ? "[*]" : phase;
}

function fmtList(items: readonly string[] | undefined): string {
  if (!items || items.length === 0) return "—";
  return items
    .map((item) => (item.startsWith("_") ? item : `\`${item}\``))
    .join(", ");
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}
