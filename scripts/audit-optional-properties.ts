/**
 * Audit every `prop?:` declaration in the codebase and classify each as
 * dead, read-only, write-only, fake-optional (consumers always assume
 * defined) or truly-optional (at least one consumer defends against
 * undefined).
 *
 * Output is JSON ready for piping/grep/jq. Items are sorted with the
 * actionable classes first (dead → write/read-only → fake-optional →
 * truly-optional) so an agent can pick the head of the list as cleanup
 * targets.
 *
 * Usage:
 *   deno run -A scripts/audit-optional-properties.ts [--filter <regex>] [--summary-only]
 *
 * Heuristic limitations: defended-read detection covers the common
 * patterns (`x?.foo`, `x.foo ?? d`, `x.foo || d`, `if (x.foo)`,
 * `typeof x.foo`, comparisons against `undefined`/`null`, `delete x.foo`,
 * destructuring with default). Less common defenses (`Object.hasOwn`,
 * narrowing via assertion functions, etc.) won't be detected — the
 * report will under-classify "fake-optional" rather than over-classify,
 * so a property flagged fake-optional should still get a fresh eyeball
 * before dropping the `?`.
 */

import path from "node:path";
import {
  type InterfaceDeclaration,
  type MethodSignature,
  type Node,
  Project,
  type PropertySignature,
  type SourceFile,
  SyntaxKind,
  type TypeAliasDeclaration,
} from "ts-morph";

interface RefStats {
  assigns: number;
  guardedReads: number;
  unguardedReads: number;
}

type Classification =
  | "dead"
  | "read-only"
  | "write-only"
  | "fake-optional"
  | "truly-optional";

interface Item {
  interface: string;
  property: string;
  file: string;
  line: number;
  classification: Classification;
  stats: RefStats;
  rationale: string;
}

interface Report {
  totals: {
    totalOptional: number;
    byClass: Record<Classification, number>;
  };
  items: Item[];
}

type RefKind =
  | "assign"
  | "read-guarded"
  | "read-unguarded"
  | "delete"
  | "type-only"
  | "other";

const CLASS_ORDER: Classification[] = [
  "dead",
  "write-only",
  "read-only",
  "fake-optional",
  "truly-optional",
];

main();

function main(): void {
  const args = parseArgs(Deno.args);
  const filter =
    typeof args.filter === "string" ? new RegExp(args.filter) : null;

  const project = new Project({
    tsConfigFilePath: path.resolve("tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([
    "src/**/*.ts",
    "server/**/*.ts",
    "test/**/*.ts",
  ]);

  const items: Item[] = [];
  for (const sf of project.getSourceFiles()) {
    for (const iface of sf.getInterfaces()) {
      auditInterface(iface, items);
    }
    for (const alias of sf.getTypeAliases()) {
      auditTypeAlias(alias, items);
    }
  }

  const filtered = filter
    ? items.filter((i) => filter.test(i.interface) || filter.test(i.property))
    : items;

  filtered.sort((a, b) => {
    const c =
      CLASS_ORDER.indexOf(a.classification) -
      CLASS_ORDER.indexOf(b.classification);
    if (c !== 0) return c;
    return `${a.interface}.${a.property}`.localeCompare(
      `${b.interface}.${b.property}`,
    );
  });

  const byClass: Record<Classification, number> = {
    dead: 0,
    "write-only": 0,
    "read-only": 0,
    "fake-optional": 0,
    "truly-optional": 0,
  };
  for (const item of filtered) byClass[item.classification]++;

  const report: Report = {
    totals: { totalOptional: filtered.length, byClass },
    items: args["summary-only"] ? [] : filtered,
  };
  console.log(JSON.stringify(report, null, 2));
}

function auditInterface(iface: InterfaceDeclaration, out: Item[]): void {
  const ifaceName = iface.getName();
  for (const prop of iface.getProperties()) {
    if (!prop.hasQuestionToken()) continue;
    out.push(buildItem(ifaceName, prop));
  }
  for (const method of iface.getMethods()) {
    if (!method.hasQuestionToken()) continue;
    out.push(buildItem(ifaceName, method));
  }
}

function auditTypeAlias(alias: TypeAliasDeclaration, out: Item[]): void {
  const typeNode = alias.getTypeNode();
  if (!typeNode || !typeNode.isKind(SyntaxKind.TypeLiteral)) return;
  const tl = typeNode.asKindOrThrow(SyntaxKind.TypeLiteral);
  const aliasName = alias.getName();
  for (const member of tl.getMembers()) {
    if (member.isKind(SyntaxKind.PropertySignature)) {
      const prop = member.asKindOrThrow(SyntaxKind.PropertySignature);
      if (prop.hasQuestionToken()) out.push(buildItem(aliasName, prop));
    } else if (member.isKind(SyntaxKind.MethodSignature)) {
      const method = member.asKindOrThrow(SyntaxKind.MethodSignature);
      if (method.hasQuestionToken()) out.push(buildItem(aliasName, method));
    }
  }
}

function buildItem(
  containerName: string,
  prop: PropertySignature | MethodSignature,
): Item {
  const sf = prop.getSourceFile();
  const file = path.relative(Deno.cwd(), sf.getFilePath());
  const line = sf.getLineAndColumnAtPos(prop.getStart()).line;
  const propName = prop.getName();
  const stats = collectStats(prop);
  const classification = classify(stats);
  return {
    interface: containerName,
    property: propName,
    file,
    line,
    classification,
    stats,
    rationale: rationaleFor(classification, stats),
  };
}

function collectStats(prop: PropertySignature | MethodSignature): RefStats {
  const stats: RefStats = { assigns: 0, guardedReads: 0, unguardedReads: 0 };
  const declId = prop.getNameNode();
  if (!declId || !declId.isKind(SyntaxKind.Identifier)) return stats;
  const refs = declId
    .asKindOrThrow(SyntaxKind.Identifier)
    .findReferencesAsNodes();
  for (const ref of refs) {
    if (ref === declId) continue;
    const kind = classifyRef(ref);
    if (kind === "assign") stats.assigns++;
    else if (kind === "read-guarded") stats.guardedReads++;
    else if (kind === "read-unguarded") stats.unguardedReads++;
    else if (kind === "delete") stats.assigns++;
  }
  return stats;
}

function classify(stats: RefStats): Classification {
  const reads = stats.guardedReads + stats.unguardedReads;
  if (stats.assigns === 0 && reads === 0) return "dead";
  if (stats.assigns === 0 && reads > 0) return "read-only";
  if (stats.assigns > 0 && reads === 0) return "write-only";
  if (stats.guardedReads > 0) return "truly-optional";
  return "fake-optional";
}

function rationaleFor(c: Classification, s: RefStats): string {
  switch (c) {
    case "dead":
      return "no references found; likely safe to delete";
    case "write-only":
      return `${s.assigns} assigns, 0 reads; declared but never observed`;
    case "read-only":
      return `${s.guardedReads + s.unguardedReads} reads, 0 assigns; always undefined at runtime`;
    case "fake-optional":
      return `${s.unguardedReads} reads, none defended against undefined; consider dropping the \`?\``;
    case "truly-optional":
      return `${s.guardedReads} guarded read(s), ${s.unguardedReads} unguarded; consumers handle undefined`;
  }
}

function classifyRef(node: Node): RefKind {
  const parent = node.getParent();
  if (!parent) return "other";

  if (parent.isKind(SyntaxKind.PropertySignature)) return "type-only";
  if (parent.isKind(SyntaxKind.MethodSignature)) return "type-only";

  if (parent.isKind(SyntaxKind.PropertyAssignment)) {
    const pa = parent.asKindOrThrow(SyntaxKind.PropertyAssignment);
    if (pa.getNameNode() === node) return "assign";
  }
  if (parent.isKind(SyntaxKind.ShorthandPropertyAssignment)) return "assign";

  if (parent.isKind(SyntaxKind.BindingElement)) {
    const be = parent.asKindOrThrow(SyntaxKind.BindingElement);
    if (be.getInitializer()) return "read-guarded";
    return "read-unguarded";
  }

  if (parent.isKind(SyntaxKind.PropertyAccessExpression)) {
    const pae = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pae.getNameNode() === node) {
      return classifyPropertyAccessRead(pae);
    }
    return "other";
  }

  return "other";
}

function classifyPropertyAccessRead(pae: Node): RefKind {
  if (
    pae.isKind(SyntaxKind.PropertyAccessExpression) &&
    pae.asKindOrThrow(SyntaxKind.PropertyAccessExpression).hasQuestionDotToken()
  ) {
    return "read-guarded";
  }

  // `obj.method?.()` — the `?.` token sits on the CallExpression parent of the
  // PropertyAccessExpression, not on the PAE itself, so the check above misses
  // this very common defensive pattern.
  const paeParent = pae.getParent();
  if (
    paeParent?.isKind(SyntaxKind.CallExpression) &&
    paeParent.asKindOrThrow(SyntaxKind.CallExpression).hasQuestionDotToken()
  ) {
    return "read-guarded";
  }

  let cursor: Node = pae;
  for (let depth = 0; depth < 6; depth++) {
    const p = cursor.getParent();
    if (!p) break;

    if (p.isKind(SyntaxKind.BinaryExpression)) {
      const be = p.asKindOrThrow(SyntaxKind.BinaryExpression);
      const op = be.getOperatorToken().getKind();
      if (op === SyntaxKind.EqualsToken && be.getLeft() === cursor) {
        return "assign";
      }
      const guardOps = new Set<number>([
        SyntaxKind.EqualsEqualsEqualsToken,
        SyntaxKind.ExclamationEqualsEqualsToken,
        SyntaxKind.EqualsEqualsToken,
        SyntaxKind.ExclamationEqualsToken,
      ]);
      if (guardOps.has(op)) {
        const other = be.getLeft() === cursor ? be.getRight() : be.getLeft();
        const text = other.getText();
        if (text === "undefined" || text === "null") return "read-guarded";
      }
      if (op === SyntaxKind.QuestionQuestionToken && be.getLeft() === cursor) {
        return "read-guarded";
      }
      if (
        (op === SyntaxKind.BarBarToken ||
          op === SyntaxKind.AmpersandAmpersandToken) &&
        be.getLeft() === cursor
      ) {
        return "read-guarded";
      }
    }

    if (p.isKind(SyntaxKind.DeleteExpression)) return "delete";
    if (p.isKind(SyntaxKind.TypeOfExpression)) return "read-guarded";

    if (p.isKind(SyntaxKind.IfStatement)) {
      const ifs = p.asKindOrThrow(SyntaxKind.IfStatement);
      if (ifs.getExpression() === cursor) return "read-guarded";
    }
    if (p.isKind(SyntaxKind.ConditionalExpression)) {
      const cond = p.asKindOrThrow(SyntaxKind.ConditionalExpression);
      if (cond.getCondition() === cursor) return "read-guarded";
    }
    if (p.isKind(SyntaxKind.WhileStatement)) {
      const ws = p.asKindOrThrow(SyntaxKind.WhileStatement);
      if (ws.getExpression() === cursor) return "read-guarded";
    }

    if (p.isKind(SyntaxKind.PrefixUnaryExpression)) {
      // `!obj.x` is essentially always defensive — `!` only makes sense when
      // the operand can be falsy, so the negation itself is a guard signal.
      // (Walking up to find an enclosing if/while is too narrow: it misses
      // `if (cond || !obj.x) return;`, `cond && !obj.x ? ...`, `return !obj.x`,
      // etc., which are all defensive uses.)
      const unary = p.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
      if (unary.getOperatorToken() === SyntaxKind.ExclamationToken) {
        return "read-guarded";
      }
      cursor = p;
      continue;
    }
    if (p.isKind(SyntaxKind.ParenthesizedExpression)) {
      cursor = p;
      continue;
    }

    break;
  }

  return "read-unguarded";
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}
