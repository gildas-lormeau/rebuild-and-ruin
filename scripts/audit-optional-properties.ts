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
  type ObjectLiteralExpression,
  Project,
  type PropertySignature,
  SyntaxKind,
  type Symbol as TsmSymbol,
  type Type,
  type TypeAliasDeclaration,
} from "ts-morph";

interface RefStats {
  assigns: number;
  guardedReads: number;
  unguardedReads: number;
}

type Classification =
  | "dead"
  | "suspicious-dead"
  | "read-only"
  | "write-only"
  | "fake-optional"
  | "ambiguous-fake"
  | "truly-optional";

interface Item {
  interface: string;
  property: string;
  file: string;
  line: number;
  classification: Classification;
  stats: RefStats;
  /** Construction-site analysis (only meaningful for fake-optional + ambiguous-fake). */
  constructionSites: number;
  omittedAt: number;
  /** Total identifier occurrences project-wide with this name (minus the
   *  declaration itself). High values on a "dead" finding hint at structural-
   *  typing false positives — references the symbol-search missed. */
  stringMatches: number;
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

type Container = InterfaceDeclaration | TypeAliasDeclaration;

interface ContextCounts {
  constructionSites: number;
  omittedAt: number;
  stringMatches: number;
}

const CLASS_ORDER: Classification[] = [
  "dead",
  "write-only",
  "read-only",
  "fake-optional",
  "ambiguous-fake",
  "suspicious-dead",
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

  // Phase 1: index every interface / type-literal alias by its declaration
  // symbol, so we can match contextual types back to their declaration node.
  const containersBySymbol = new Map<TsmSymbol, Container>();
  for (const sf of project.getSourceFiles()) {
    for (const iface of sf.getInterfaces()) {
      const sym = iface.getSymbol();
      if (sym) containersBySymbol.set(sym, iface);
    }
    for (const alias of sf.getTypeAliases()) {
      const typeNode = alias.getTypeNode();
      if (!typeNode || !typeNode.isKind(SyntaxKind.TypeLiteral)) continue;
      const sym = alias.getSymbol();
      if (sym) containersBySymbol.set(sym, alias);
    }
  }

  // Phase 2: walk every object literal in the project, ask for its contextual
  // type, map back to the declaration node(s). Per-container literal lists are
  // the input to the construction-site omission check.
  const literalsByContainer = new Map<Container, ObjectLiteralExpression[]>();
  for (const sf of project.getSourceFiles()) {
    for (const obj of sf.getDescendantsOfKind(
      SyntaxKind.ObjectLiteralExpression,
    )) {
      const ctxType = obj.getContextualType();
      if (!ctxType) continue;
      for (const c of resolveContainersFromType(ctxType, containersBySymbol)) {
        let arr = literalsByContainer.get(c);
        if (!arr) {
          arr = [];
          literalsByContainer.set(c, arr);
        }
        arr.push(obj);
      }
    }
  }

  // Phase 3: count identifier occurrences project-wide. Subtract 1 for the
  // declaration when looking up a property name; whatever remains is the
  // string-level reference count outside the symbol's resolution.
  const identCountByName = new Map<string, number>();
  for (const sf of project.getSourceFiles()) {
    for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const name = id.getText();
      identCountByName.set(name, (identCountByName.get(name) ?? 0) + 1);
    }
  }

  // Phase 4: audit each optional member, augmented with omission + string-match
  // counts.
  const items: Item[] = [];
  for (const [, container] of containersBySymbol) {
    auditContainer(container, literalsByContainer, identCountByName, items);
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
    "suspicious-dead": 0,
    "write-only": 0,
    "read-only": 0,
    "fake-optional": 0,
    "ambiguous-fake": 0,
    "truly-optional": 0,
  };
  for (const item of filtered) byClass[item.classification]++;

  const report: Report = {
    totals: { totalOptional: filtered.length, byClass },
    items: args["summary-only"] ? [] : filtered,
  };
  console.log(JSON.stringify(report, null, 2));
}

function auditContainer(
  container: Container,
  literalsByContainer: Map<Container, ObjectLiteralExpression[]>,
  identCountByName: Map<string, number>,
  out: Item[],
): void {
  const containerName = container.getName();
  const literals = literalsByContainer.get(container) ?? [];
  const properties: Array<PropertySignature | MethodSignature> = [];
  if (container.isKind(SyntaxKind.InterfaceDeclaration)) {
    properties.push(
      ...container.getProperties().filter((p) => p.hasQuestionToken()),
      ...container.getMethods().filter((m) => m.hasQuestionToken()),
    );
  } else {
    const typeNode = container.getTypeNode();
    if (typeNode?.isKind(SyntaxKind.TypeLiteral)) {
      for (const member of typeNode.getMembers()) {
        if (member.isKind(SyntaxKind.PropertySignature)) {
          const prop = member.asKindOrThrow(SyntaxKind.PropertySignature);
          if (prop.hasQuestionToken()) properties.push(prop);
        } else if (member.isKind(SyntaxKind.MethodSignature)) {
          const method = member.asKindOrThrow(SyntaxKind.MethodSignature);
          if (method.hasQuestionToken()) properties.push(method);
        }
      }
    }
  }
  for (const prop of properties) {
    out.push(buildItem(containerName, prop, literals, identCountByName));
  }
}

/** Walk a contextual type and resolve every tracked container it points at,
 *  recursing into unions. Intersections / Pick / Omit / Partial are skipped
 *  in v1 — they preserve the underlying symbol but with modified property
 *  shape, so naively counting them would mis-flag (e.g. \`Partial<X>\` literals
 *  legitimately omit fields without the original \`?\` being load-bearing). */
function resolveContainersFromType(
  type: Type,
  containers: Map<TsmSymbol, Container>,
  visited: Set<Type> = new Set(),
): Container[] {
  if (visited.has(type)) return [];
  visited.add(type);
  const out: Container[] = [];
  const sym = type.getSymbol() ?? type.getAliasSymbol();
  if (sym && containers.has(sym)) out.push(containers.get(sym) as Container);
  if (type.isUnion()) {
    for (const m of type.getUnionTypes()) {
      out.push(...resolveContainersFromType(m, containers, visited));
    }
  }
  return out;
}

function buildItem(
  containerName: string,
  prop: PropertySignature | MethodSignature,
  literals: ObjectLiteralExpression[],
  identCountByName: Map<string, number>,
): Item {
  const sf = prop.getSourceFile();
  const file = path.relative(Deno.cwd(), sf.getFilePath());
  const line = sf.getLineAndColumnAtPos(prop.getStart()).line;
  const propName = prop.getName();
  const stats = collectStats(prop);
  const omittedAt = countOmissions(literals, propName);
  // -1 to discount the declaration's own identifier; clamp to 0 to defend
  // against weird cases (computed names, etc. that wouldn't show as Identifier).
  const stringMatches = Math.max(0, (identCountByName.get(propName) ?? 0) - 1);
  const classification = classify(stats, omittedAt, stringMatches);
  return {
    interface: containerName,
    property: propName,
    file,
    line,
    classification,
    stats,
    constructionSites: literals.length,
    omittedAt,
    stringMatches,
    rationale: rationaleFor(classification, stats, {
      constructionSites: literals.length,
      omittedAt,
      stringMatches,
    }),
  };
}

/** Count construction-site literals that don't set this property. Literals
 *  with a spread (`...rest`) are skipped — we can't tell statically whether
 *  the spread provides the property. */
function countOmissions(
  literals: ObjectLiteralExpression[],
  propName: string,
): number {
  let omitted = 0;
  for (const lit of literals) {
    let hasSpread = false;
    for (const member of lit.getProperties()) {
      if (member.isKind(SyntaxKind.SpreadAssignment)) {
        hasSpread = true;
        break;
      }
    }
    if (hasSpread) continue;
    if (lit.getProperty(propName) === undefined) omitted++;
  }
  return omitted;
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

function classify(
  stats: RefStats,
  omittedAt: number,
  stringMatches: number,
): Classification {
  const reads = stats.guardedReads + stats.unguardedReads;
  if (stats.assigns === 0 && reads === 0) {
    // 0 symbol references, but identifiers with this name appear elsewhere —
    // ts-morph likely missed references through structural / contextual typing
    // (e.g. wire DTO assigned via object literal, or read through a sibling
    // type with the same shape).
    return stringMatches > 0 ? "suspicious-dead" : "dead";
  }
  if (stats.assigns === 0 && reads > 0) return "read-only";
  if (stats.assigns > 0 && reads === 0) return "write-only";
  if (stats.guardedReads > 0) return "truly-optional";
  // Fake-optional pattern (no consumer defends), but if any construction site
  // omits the field, dropping `?` would be a hard tsc error — surface as a
  // separate class so the agent investigates the constructors first.
  return omittedAt > 0 ? "ambiguous-fake" : "fake-optional";
}

function rationaleFor(
  c: Classification,
  s: RefStats,
  ctx: ContextCounts,
): string {
  switch (c) {
    case "dead":
      return "no references found; likely safe to delete";
    case "suspicious-dead":
      return `0 symbol references but ${ctx.stringMatches} identifier match(es) with this name elsewhere — ts-morph likely missed references through structural / contextual typing; verify before deleting`;
    case "write-only":
      return `${s.assigns} assigns, 0 reads; declared but never observed`;
    case "read-only":
      return `${s.guardedReads + s.unguardedReads} reads, 0 assigns; always undefined at runtime`;
    case "fake-optional":
      return `${s.unguardedReads} reads (none defended), ${ctx.constructionSites} construction site(s) all set the field; safe to drop \`?\``;
    case "ambiguous-fake":
      return `${s.unguardedReads} reads (none defended), but ${ctx.omittedAt} of ${ctx.constructionSites} construction site(s) omit the field — dropping \`?\` would tsc-error; either set the field at the omitting sites or add guards to the readers`;
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
    // Destructuring is type-propagation, not a value-level read: `const { x } =
    // obj` makes a local of type `T | undefined` (or `T` with a default), and
    // TypeScript's strict-null-checks enforce undefined-safety at the leaf use.
    // Treating destructure as guarded avoids classifying legitimate
    // "optional-pass-through" plumbing as fake-optional. False-negative on
    // "fake" is preferred over flagging real optionals.
    return "read-guarded";
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
  // `obj.foo?.bar` — `foo`'s parent PAE (`obj.foo`) has no `?.` itself, but
  // the grandparent PAE (`obj.foo?.bar`) carries the optional chain to the
  // next access. Same pattern for `obj.foo?.bar.baz`, `obj.foo?.bar?.()`, etc.
  if (
    paeParent?.isKind(SyntaxKind.PropertyAccessExpression) &&
    paeParent
      .asKindOrThrow(SyntaxKind.PropertyAccessExpression)
      .hasQuestionDotToken()
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
