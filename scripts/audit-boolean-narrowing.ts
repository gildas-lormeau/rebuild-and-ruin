/**
 * Find `?: boolean` property declarations whose every write is `true` or
 * `undefined` — never `false`, never a wide-boolean expression.
 *
 * LLM agents tend to declare wider than they use ("safe" optional booleans)
 * even when the actual flag is binary (`set true to enable, clear with
 * undefined`). Tightening these to `?: true` documents the real shape and
 * exposes any defensive `?? false` / `=== false` reads as
 * `useless-guards` follow-ups.
 *
 * Findings are grouped:
 *   tighten-to-true  every write is narrow `true | undefined` — safe to tighten
 *   ambiguous        at least one write is `false` or wide-boolean — leave alone
 *   write-only       declared but never written from any tracked site (rare;
 *                    audit-optional-properties already covers this class)
 *
 * Output is JSON for automation. Use `--report` for a human-readable summary.
 *
 * Heuristic limitations: shorthand-property assigns (`{ mortar }` referring
 * to a local) inherit the local's type — if the local is `boolean`, that
 * shows up as wide-boolean even when the actual values flowing through are
 * narrow. False-positive on "ambiguous"; never false-positive on
 * "tighten-to-true".
 */

import path from "node:path";
import process from "node:process";
import {
  type Identifier,
  type InterfaceDeclaration,
  type Node,
  Project,
  type PropertySignature,
  SyntaxKind,
  type TypeAliasDeclaration,
  type TypeLiteralNode,
} from "ts-morph";

type ValueClass =
  | "true"
  | "false"
  | "undefined"
  | "narrow"
  | "wide"
  | "unknown";

interface WriteSite {
  file: string;
  line: number;
  snippet: string;
  value: ValueClass;
}

type Proposal = "tighten-to-true" | "ambiguous" | "write-only";

interface Finding {
  interface: string;
  property: string;
  file: string;
  line: number;
  proposal: Proposal;
  writeCount: number;
  writes: WriteSite[];
}

const args = process.argv.slice(2);
const wantReport = args.includes("--report");
const filterIdx = args.indexOf("--filter");
const filterRe =
  filterIdx >= 0 && args[filterIdx + 1]
    ? new RegExp(args[filterIdx + 1])
    : null;
const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});
const candidates: { sig: PropertySignature; container: string }[] = [];
const findings: Finding[] = [];

project.addSourceFilesAtPaths(["src/**/*.ts", "server/**/*.ts"]);

for (const sf of project.getSourceFiles()) {
  for (const iface of sf.getInterfaces()) collectFromInterface(iface);
  for (const ta of sf.getTypeAliases()) collectFromTypeAlias(ta);
}

for (const { sig, container } of candidates) {
  const finding = analyzeField(sig, container);
  if (filterRe && !filterRe.test(`${finding.interface}.${finding.property}`)) {
    continue;
  }
  findings.push(finding);
}

findings.sort((finA, finB) => proposalRank(finA) - proposalRank(finB));

if (wantReport) {
  printReport(findings);
} else {
  console.log(JSON.stringify(findings, null, 2));
}

function collectFromInterface(iface: InterfaceDeclaration): void {
  for (const member of iface.getProperties()) {
    if (isOptionalBoolean(member)) {
      candidates.push({ sig: member, container: iface.getName() });
    }
  }
}

function collectFromTypeAlias(ta: TypeAliasDeclaration): void {
  const node = ta.getTypeNode();
  if (!node || !node.isKind(SyntaxKind.TypeLiteral)) return;
  const lit = node.asKindOrThrow(SyntaxKind.TypeLiteral) as TypeLiteralNode;
  for (const member of lit.getProperties()) {
    if (isOptionalBoolean(member)) {
      candidates.push({ sig: member, container: ta.getName() });
    }
  }
}

function isOptionalBoolean(sig: PropertySignature): boolean {
  if (!sig.hasQuestionToken()) return false;
  const typeNode = sig.getTypeNode();
  return typeNode?.getText() === "boolean";
}

function analyzeField(sig: PropertySignature, container: string): Finding {
  const nameNode = sig.getNameNode();
  const refs = (nameNode as Identifier).findReferencesAsNodes();
  const writes: WriteSite[] = [];
  for (const ref of refs) {
    if (ref === nameNode) continue;
    const valueNode = writeValueOf(ref);
    if (!valueNode) continue;
    writes.push(makeWriteSite(ref, valueNode));
  }
  return {
    interface: container,
    property: nameNode.getText(),
    file: path.relative(process.cwd(), sig.getSourceFile().getFilePath()),
    line: sig.getStartLineNumber(),
    proposal: decideProposal(writes),
    writeCount: writes.length,
    writes,
  };
}

/** If `ref` is the name-position of an assignment, return the value node
 *  written; otherwise null. Type references and reads return null. */
function writeValueOf(ref: Node): Node | null {
  const parent = ref.getParent();
  if (!parent) return null;

  if (parent.isKind(SyntaxKind.PropertyAssignment)) {
    const propAssign = parent.asKindOrThrow(SyntaxKind.PropertyAssignment);
    if (propAssign.getNameNode() !== ref) return null;
    return propAssign.getInitializer() ?? null;
  }

  // Shorthand: `{ damaged }` — the ref node IS the value node. Its type
  // is the local's type (boolean parameter, narrow flag, etc.), so the
  // existing classifyValue path resolves correctly.
  if (parent.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
    return ref;
  }

  if (parent.isKind(SyntaxKind.PropertyAccessExpression)) {
    const access = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (access.getNameNode() !== ref) return null;
    const grand = access.getParent();
    if (!grand || !grand.isKind(SyntaxKind.BinaryExpression)) return null;
    const bin = grand.asKindOrThrow(SyntaxKind.BinaryExpression);
    if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken)
      return null;
    if (bin.getLeft() !== access) return null;
    return bin.getRight();
  }

  return null;
}

function makeWriteSite(ref: Node, valueNode: Node): WriteSite {
  return {
    file: path.relative(process.cwd(), ref.getSourceFile().getFilePath()),
    line: ref.getStartLineNumber(),
    snippet: valueNode.getText().replace(/\s+/g, " ").slice(0, 80),
    value: classifyValue(valueNode),
  };
}

function classifyValue(node: Node): ValueClass {
  const text = node.getText().trim();
  if (text === "true") return "true";
  if (text === "false") return "false";
  if (text === "undefined") return "undefined";

  const type = node.getType();
  if (type.isBooleanLiteral()) {
    return type.getText() === "true" ? "true" : "false";
  }
  if (type.isUndefined()) return "undefined";
  if (type.isBoolean()) return "wide";

  // Union: e.g. `true | undefined` → narrow; `boolean | undefined` → wide.
  if (type.isUnion()) {
    const parts = type.getUnionTypes();
    let sawFalse = false;
    let sawWideBool = false;
    let allKnown = true;
    for (const part of parts) {
      if (part.isUndefined()) continue;
      if (part.isBooleanLiteral()) {
        if (part.getText() === "false") sawFalse = true;
        continue;
      }
      if (part.isBoolean()) {
        sawWideBool = true;
        continue;
      }
      allKnown = false;
    }
    if (sawWideBool) return "wide";
    if (sawFalse) return "false";
    if (allKnown) return "narrow";
  }
  return "unknown";
}

function decideProposal(writes: WriteSite[]): Proposal {
  if (writes.length === 0) return "write-only";
  let allNarrow = true;
  for (const write of writes) {
    if (write.value === "false" || write.value === "wide") return "ambiguous";
    if (write.value === "unknown") allNarrow = false;
  }
  return allNarrow ? "tighten-to-true" : "ambiguous";
}

function proposalRank(finding: Finding): number {
  if (finding.proposal === "tighten-to-true") return 0;
  if (finding.proposal === "ambiguous") return 1;
  return 2;
}

function printReport(items: Finding[]): void {
  const groups = new Map<Proposal, Finding[]>([
    ["tighten-to-true", []],
    ["ambiguous", []],
    ["write-only", []],
  ]);
  for (const item of items) groups.get(item.proposal)?.push(item);

  const tighten = groups.get("tighten-to-true")!;
  console.log(`\n=== Tighten to ?: true (${tighten.length}) ===`);
  for (const item of tighten) {
    console.log(
      `  ${item.interface}.${item.property}  ${item.file}:${item.line}  (${item.writeCount} writes)`,
    );
    for (const write of item.writes) {
      console.log(
        `      ${write.value.padEnd(9)} ${write.file}:${write.line}  ${write.snippet}`,
      );
    }
  }

  const ambiguous = groups.get("ambiguous")!;
  console.log(
    `\n=== Ambiguous: ${ambiguous.length} (false / wide-boolean writes seen) ===`,
  );
  for (const item of ambiguous) {
    const offenders = item.writes.filter(
      (write) =>
        write.value === "false" ||
        write.value === "wide" ||
        write.value === "unknown",
    );
    console.log(
      `  ${item.interface}.${item.property}  ${item.file}:${item.line}`,
    );
    for (const write of offenders.slice(0, 3)) {
      console.log(
        `      ${write.value.padEnd(9)} ${write.file}:${write.line}  ${write.snippet}`,
      );
    }
  }

  const writeOnly = groups.get("write-only")!;
  console.log(
    `\n=== Write-only / no-writes: ${writeOnly.length} (skipped — see audit:optional) ===`,
  );

  console.log(
    `\nTotal candidates: ${items.length}  →  tighten: ${tighten.length}, ambiguous: ${ambiguous.length}, write-only: ${writeOnly.length}`,
  );
}
