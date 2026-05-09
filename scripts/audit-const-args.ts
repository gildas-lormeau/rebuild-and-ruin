/**
 * Find function parameters whose every call site passes the same constant
 * value — the parameter is effectively dead surface area.
 *
 * LLM agents lean on speculative parameterization ("flag for future
 * configurability") that no caller ever flips. This audit walks every
 * top-level function and arrow-const function in src/ + server/, collects
 * the call sites of each, classifies the argument at every parameter
 * index, and reports parameters where every observed call passes the
 * same literal (or the same identifier / property access, as a weaker
 * signal).
 *
 * Findings are grouped:
 *   inline-constant   every call passes the same literal — inline & remove
 *   same-binding      every call passes the same ident or property access
 *                     (e.g. `Tile.GRASS`, `state`) — candidate for closure
 *                     capture or hard-coding
 *   varies            multiple distinct values seen — leave alone
 *   untraceable       the function is passed by reference somewhere, or a
 *                     call uses spread / a non-literal expression we cannot
 *                     classify; "every call site" would be unsound
 *   no-calls          0 call sites tracked (knip should flag this already)
 *
 * Output is JSON for automation. Flags:
 *   --report               human-readable summary (default: JSON)
 *   --filter <regex>       scope to function names matching regex
 *   --min-calls <N>        hide findings with fewer than N call sites
 *   --include-bindings     show same-binding section (hidden by default —
 *                          mostly convention noise; each caller naming its
 *                          local `state` does not mean the param is dead)
 *
 * Heuristic limitations:
 *  - Top-level functions and top-level `const fn = (…) => …` only. No class
 *    methods (dispatched dynamically — too noisy), no nested functions.
 *  - Destructured / rest / underscore-prefixed parameters skipped.
 *  - Property-access arguments (`Tile.GRASS`, `Phase.BATTLE`) group under
 *    `same-binding` keyed by access text — identical text counts as same
 *    reference, even if (rarely) two enum members stringify the same.
 *  - Default values that are non-literal expressions (`Date.now()`) demote
 *    every call that omits the arg to `untraceable`.
 */

import path from "node:path";
import process from "node:process";
import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  type Node,
  type ParameterDeclaration,
  Project,
  SyntaxKind,
} from "ts-morph";

type ArgClass =
  | { kind: "literal"; literal: string }
  | { kind: "ident"; name: string }
  | { kind: "default-used" }
  | { kind: "spread" }
  | { kind: "non-literal" };

interface CallObservation {
  file: string;
  line: number;
  argClass: ArgClass;
  snippet: string;
}

type Proposal =
  | "inline-constant"
  | "same-binding"
  | "varies"
  | "untraceable"
  | "no-calls";

interface Finding {
  function: string;
  param: string;
  paramIndex: number;
  paramType: string;
  hasDefault: boolean;
  defaultLiteral: string | null;
  file: string;
  line: number;
  proposal: Proposal;
  constantValue: string | null;
  callCount: number;
  observations: CallObservation[];
}

type Candidate = {
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression;
  nameNode: Identifier;
  qualifiedName: string;
};

const args = process.argv.slice(2);
const wantReport = args.includes("--report");
const includeBindings = args.includes("--include-bindings");
const filterIdx = args.indexOf("--filter");
const filterRe =
  filterIdx >= 0 && args[filterIdx + 1]
    ? new RegExp(args[filterIdx + 1])
    : null;
const minCallsIdx = args.indexOf("--min-calls");
const minCalls =
  minCallsIdx >= 0 && args[minCallsIdx + 1]
    ? Number.parseInt(args[minCallsIdx + 1], 10)
    : 1;
const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});
const candidates: Candidate[] = [];
const findings: Finding[] = [];

project.addSourceFilesAtPaths(["src/**/*.ts", "server/**/*.ts"]);

for (const sf of project.getSourceFiles()) {
  for (const fn of sf.getFunctions()) {
    const nameNode = fn.getNameNode();
    if (!nameNode) continue;
    if (!fn.hasBody()) continue;
    candidates.push({ fn, nameNode, qualifiedName: nameNode.getText() });
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer();
    if (!init) continue;
    if (
      !init.isKind(SyntaxKind.ArrowFunction) &&
      !init.isKind(SyntaxKind.FunctionExpression)
    ) {
      continue;
    }
    const nameNode = v.getNameNode();
    if (!nameNode.isKind(SyntaxKind.Identifier)) continue;
    candidates.push({
      fn: init as ArrowFunction | FunctionExpression,
      nameNode: nameNode.asKindOrThrow(SyntaxKind.Identifier),
      qualifiedName: v.getName(),
    });
  }
}

for (const cand of candidates) {
  if (filterRe && !filterRe.test(cand.qualifiedName)) continue;
  collectFindings(cand);
}

findings.sort(compareFindings);

if (wantReport) {
  printReport(findings);
} else {
  console.log(JSON.stringify(findings, null, 2));
}

function collectFindings(cand: Candidate): void {
  const params = cand.fn.getParameters();
  if (params.length === 0) return;

  const { callSites, hasNonCallRef } = findCallSites(cand.nameNode);

  for (let paramIndex = 0; paramIndex < params.length; paramIndex++) {
    const param = params[paramIndex];
    if (!analyzableParam(param)) continue;

    const observations = observeArgs(callSites, paramIndex);
    let { proposal, constantValue } = decideProposal(observations, param);
    if (hasNonCallRef && proposal !== "no-calls") {
      proposal = "untraceable";
      constantValue = null;
    }

    findings.push({
      function: cand.qualifiedName,
      param: param.getName(),
      paramIndex,
      paramType: param.getTypeNode()?.getText() ?? param.getType().getText(),
      hasDefault: param.getInitializer() !== undefined,
      defaultLiteral: literalOfDefault(param),
      file: path.relative(process.cwd(), cand.fn.getSourceFile().getFilePath()),
      line: cand.nameNode.getStartLineNumber(),
      proposal,
      constantValue,
      callCount: observations.length,
      observations,
    });
  }
}

function analyzableParam(param: ParameterDeclaration): boolean {
  const nameNode = param.getNameNode();
  if (!nameNode.isKind(SyntaxKind.Identifier)) return false;
  if (param.isRestParameter()) return false;
  if (param.getName().startsWith("_")) return false;
  return true;
}

function findCallSites(nameNode: Identifier): {
  callSites: CallExpression[];
  hasNonCallRef: boolean;
} {
  const refs = nameNode.findReferencesAsNodes();
  const callSites: CallExpression[] = [];
  let hasNonCallRef = false;
  for (const ref of refs) {
    if (ref === nameNode) continue;
    if (isNeutralRef(ref)) continue;
    const call = callSiteFor(ref);
    if (call) callSites.push(call);
    else hasNonCallRef = true;
  }
  return { callSites, hasNonCallRef };
}

function isNeutralRef(ref: Node): boolean {
  if (ref.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) return true;
  if (ref.getFirstAncestorByKind(SyntaxKind.ExportDeclaration)) return true;
  const parent = ref.getParent();
  if (parent?.isKind(SyntaxKind.TypeQuery)) return true;
  if (parent?.isKind(SyntaxKind.ExportSpecifier)) return true;
  if (parent?.isKind(SyntaxKind.ImportSpecifier)) return true;
  return false;
}

function callSiteFor(ref: Node): CallExpression | null {
  const parent = ref.getParent();
  if (!parent) return null;
  if (parent.isKind(SyntaxKind.CallExpression)) {
    const call = parent.asKindOrThrow(SyntaxKind.CallExpression);
    return call.getExpression() === ref ? call : null;
  }
  if (parent.isKind(SyntaxKind.PropertyAccessExpression)) {
    const access = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (access.getNameNode() !== ref) return null;
    const grand = access.getParent();
    if (!grand || !grand.isKind(SyntaxKind.CallExpression)) return null;
    const call = grand.asKindOrThrow(SyntaxKind.CallExpression);
    return call.getExpression() === access ? call : null;
  }
  return null;
}

function observeArgs(
  callSites: CallExpression[],
  paramIndex: number,
): CallObservation[] {
  const observations: CallObservation[] = [];
  for (const call of callSites) {
    const callArgs = call.getArguments();
    const file = path.relative(
      process.cwd(),
      call.getSourceFile().getFilePath(),
    );
    const line = call.getStartLineNumber();

    const hasSpread = callArgs.some((arg) =>
      arg.isKind(SyntaxKind.SpreadElement),
    );
    if (hasSpread) {
      observations.push({
        file,
        line,
        argClass: { kind: "spread" },
        snippet: trimSnippet(call.getText()),
      });
      continue;
    }

    const arg = callArgs[paramIndex];
    if (!arg) {
      observations.push({
        file,
        line,
        argClass: { kind: "default-used" },
        snippet: trimSnippet(call.getText()),
      });
      continue;
    }

    observations.push({
      file,
      line,
      argClass: classifyArg(arg),
      snippet: trimSnippet(arg.getText()),
    });
  }
  return observations;
}

function decideProposal(
  observations: CallObservation[],
  param: ParameterDeclaration,
): { proposal: Proposal; constantValue: string | null } {
  if (observations.length === 0) {
    return { proposal: "no-calls", constantValue: null };
  }

  const distinct = new Set<string>();
  const defaultLit = literalOfDefault(param);

  for (const obs of observations) {
    const arg = obs.argClass;
    if (arg.kind === "spread" || arg.kind === "non-literal") {
      return { proposal: "varies", constantValue: null };
    }
    if (arg.kind === "literal") {
      distinct.add(`L:${arg.literal}`);
    } else if (arg.kind === "ident") {
      distinct.add(`I:${arg.name}`);
    } else {
      // default-used
      if (defaultLit === null) {
        return { proposal: "untraceable", constantValue: null };
      }
      distinct.add(
        defaultLit.startsWith("ident:")
          ? `I:${defaultLit.slice("ident:".length)}`
          : `L:${defaultLit}`,
      );
    }
  }

  if (distinct.size !== 1) {
    return { proposal: "varies", constantValue: null };
  }
  const only = [...distinct][0];
  if (only.startsWith("L:")) {
    return { proposal: "inline-constant", constantValue: only.slice(2) };
  }
  if (only.startsWith("I:")) {
    return { proposal: "same-binding", constantValue: only.slice(2) };
  }
  return { proposal: "varies", constantValue: null };
}

function literalOfDefault(param: ParameterDeclaration): string | null {
  const init = param.getInitializer();
  if (!init) return null;
  const cls = classifyArg(init);
  if (cls.kind === "literal") return cls.literal;
  if (cls.kind === "ident") return `ident:${cls.name}`;
  return null;
}

function classifyArg(node: Node): ArgClass {
  const text = node.getText().trim();
  if (
    text === "true" ||
    text === "false" ||
    text === "null" ||
    text === "undefined"
  ) {
    return { kind: "literal", literal: text };
  }
  if (node.isKind(SyntaxKind.NumericLiteral)) {
    return { kind: "literal", literal: `num:${text}` };
  }
  if (
    node.isKind(SyntaxKind.StringLiteral) ||
    node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
  ) {
    return { kind: "literal", literal: `str:${text}` };
  }
  if (node.isKind(SyntaxKind.PrefixUnaryExpression)) {
    const unary = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
    const op = unary.getOperatorToken();
    if (op === SyntaxKind.MinusToken || op === SyntaxKind.PlusToken) {
      const operand = unary.getOperand();
      if (operand.isKind(SyntaxKind.NumericLiteral)) {
        return { kind: "literal", literal: `num:${text}` };
      }
    }
  }
  if (node.isKind(SyntaxKind.Identifier)) {
    return { kind: "ident", name: text };
  }
  if (node.isKind(SyntaxKind.PropertyAccessExpression)) {
    return { kind: "ident", name: text };
  }
  return { kind: "non-literal" };
}

function compareFindings(finA: Finding, finB: Finding): number {
  const rankDiff = proposalRank(finA.proposal) - proposalRank(finB.proposal);
  if (rankDiff !== 0) return rankDiff;
  return finB.callCount - finA.callCount;
}

function proposalRank(proposal: Proposal): number {
  switch (proposal) {
    case "inline-constant":
      return 0;
    case "same-binding":
      return 1;
    case "varies":
      return 2;
    case "untraceable":
      return 3;
    case "no-calls":
      return 4;
  }
}

function trimSnippet(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 80);
}

function printReport(items: Finding[]): void {
  const groups = new Map<Proposal, Finding[]>([
    ["inline-constant", []],
    ["same-binding", []],
    ["varies", []],
    ["untraceable", []],
    ["no-calls", []],
  ]);
  for (const item of items) groups.get(item.proposal)?.push(item);

  const inlineAll = groups.get("inline-constant") ?? [];
  const inline = inlineAll.filter((item) => item.callCount >= minCalls);
  console.log(
    `\n=== inline-constant (${inline.length} params, ${sumCalls(inline)} call sites${minCalls > 1 ? `; ${inlineAll.length - inline.length} hidden by --min-calls ${minCalls}` : ""}) ===`,
  );
  for (const item of inline) {
    console.log(
      `  ${item.function}(#${item.paramIndex} ${item.param}: ${item.paramType})  ${item.file}:${item.line}  always = ${formatValue(item.constantValue)}  (${item.callCount} calls)`,
    );
    for (const obs of item.observations.slice(0, 3)) {
      console.log(`      ${obs.file}:${obs.line}  ${obs.snippet}`);
    }
  }

  const sameBindingAll = groups.get("same-binding") ?? [];
  const sameBinding = sameBindingAll.filter(
    (item) => item.callCount >= minCalls,
  );
  if (includeBindings) {
    console.log(
      `\n=== same-binding (${sameBinding.length} params, ${sumCalls(sameBinding)} call sites${minCalls > 1 ? `; ${sameBindingAll.length - sameBinding.length} hidden by --min-calls ${minCalls}` : ""}) ===`,
    );
    for (const item of sameBinding) {
      console.log(
        `  ${item.function}(#${item.paramIndex} ${item.param}: ${item.paramType})  ${item.file}:${item.line}  always = ${item.constantValue}  (${item.callCount} calls)`,
      );
    }
  } else {
    console.log(
      `\n=== same-binding: ${sameBindingAll.length} hidden (pass --include-bindings to show; mostly convention noise — every caller happens to name its local the same) ===`,
    );
  }

  const untraceable = groups.get("untraceable") ?? [];
  const varies = groups.get("varies") ?? [];
  const noCalls = groups.get("no-calls") ?? [];
  console.log(
    `\n=== other ===\n  varies: ${varies.length}\n  untraceable: ${untraceable.length}\n  no-calls: ${noCalls.length} (knip territory)`,
  );

  console.log(
    `\nTotal params analyzed: ${items.length}  →  inline: ${inlineAll.length}, same-binding: ${sameBindingAll.length}, varies: ${varies.length}, untraceable: ${untraceable.length}, no-calls: ${noCalls.length}`,
  );
}

function sumCalls(items: Finding[]): number {
  return items.reduce((sum, item) => sum + item.callCount, 0);
}

function formatValue(value: string | null): string {
  if (value === null) return "<null>";
  if (value.startsWith("num:")) return value.slice(4);
  if (value.startsWith("str:")) return value.slice(4);
  return value;
}
