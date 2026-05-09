/**
 * Reference classifier for `audit-optional-properties.ts`.
 *
 * Pure function over a ts-morph `Node` (a reference returned by
 * `findReferencesAsNodes()` on a property declaration's name identifier).
 * Classifies what the reference is doing — assigning, reading defensively,
 * reading without a guard, deleting, etc.
 *
 * Lives in its own module so the patterns are testable from a fixture
 * (see `audit-optional-classifier.test.ts`) without spinning up a real
 * Project against the codebase. The audit script imports `classifyRef`
 * for the reference loop in `collectStats`.
 */

import { type Node, SyntaxKind } from "ts-morph";

export type RefKind =
  | "assign"
  | "read-guarded"
  | "read-unguarded"
  | "delete"
  | "type-only"
  | "other";

export type Classification =
  | "dead"
  | "suspicious-dead"
  | "read-only"
  | "suspicious-read-only"
  | "write-only"
  | "suspicious-write-only"
  | "fake-optional"
  | "ambiguous-fake"
  | "truly-optional";

export interface RefStats {
  assigns: number;
  guardedReads: number;
  unguardedReads: number;
}

/** Roll up per-reference stats + construction-site analysis + project-wide
 *  identifier-match count into a Classification. Pure function — testable
 *  independent of ts-morph. The audit driver feeds it the numbers it computed
 *  via `classifyRef`, contextual-type literal walking, and identifier indexing.
 *
 *  Demotion rules (precision-first; we'd rather a fake-optional finding need
 *  human review than have the agent drop `?` and hit a tsc error):
 *  - dead → suspicious-dead when identifier occurrences exist elsewhere
 *  - write-only → suspicious-write-only on the same signal
 *  - fake-optional → ambiguous-fake when EITHER a construction site omits the
 *    field (dropping `?` would tsc-error) OR identifier occurrences exist that
 *    the symbol-search didn't account for (likely read through a structurally-
 *    typed helper) */
export function classifyProperty(
  stats: RefStats,
  omittedAt: number,
  stringMatches: number,
  constructionSites: number,
): Classification {
  const reads = stats.guardedReads + stats.unguardedReads;
  // Construction-site literals that set the field count as "assigns" the
  // symbol-search may have missed. Real example: `FullStateMessage.*` wire
  // fields populated via a contextually-typed literal in `online-serialize.ts`
  // — ts-morph misses the assigns, but the literal IS visible to us through
  // `getContextualType()`.
  const settingSites = Math.max(0, constructionSites - omittedAt);
  const effectiveAssigns = Math.max(stats.assigns, settingSites);
  // Identifier matches that the symbol-search didn't account for. Gross
  // `stringMatches` includes the assigns/reads we already counted, so the
  // suspicion signal is whatever's *left* once those are netted out.
  const unaccountedMatches = Math.max(0, stringMatches - stats.assigns - reads);
  if (effectiveAssigns === 0 && reads === 0) {
    return unaccountedMatches > 0 ? "suspicious-dead" : "dead";
  }
  if (effectiveAssigns === 0 && reads > 0) {
    // Same demotion pattern as suspicious-write-only: identifier matches the
    // symbol-search didn't account for likely indicate an assign through a
    // structurally-typed sibling/literal (e.g. `ZoomButtonDeps.aimAtZone` set
    // by a no-return-type-annotation factory whose contextual type doesn't
    // resolve back to the interface).
    return unaccountedMatches > 0 ? "suspicious-read-only" : "read-only";
  }
  if (effectiveAssigns > 0 && reads === 0) {
    return unaccountedMatches > 0 ? "suspicious-write-only" : "write-only";
  }
  if (stats.guardedReads > 0) return "truly-optional";
  if (omittedAt > 0 || unaccountedMatches > 0) return "ambiguous-fake";
  return "fake-optional";
}

/** Classify a single reference identifier returned by ts-morph's
 *  `findReferencesAsNodes()` on a property's NameNode. */
export function classifyRef(node: Node): RefKind {
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

/** Classify a PropertyAccessExpression read for guard patterns. The
 *  surrounding context decides whether the read is defended — `?.`,
 *  `??`/`||`/`&&` LHS, comparisons against `undefined`/`null`, `typeof`,
 *  `delete`, if/while/?: tests, and any `!obj.x` count as guards. */
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

  // `const route = ctx.lifeLostRoute; if (!route) return;` — the read of
  // `ctx.lifeLostRoute` is itself unguarded, but the local alias has a guard.
  // Walk local's references for defensive patterns before declaring this
  // unguarded. Only applied at fall-through so the cheap checks above shortcut.
  if (
    pae.isKind(SyntaxKind.PropertyAccessExpression) &&
    isAliasedAndDefended(pae)
  ) {
    return "read-guarded";
  }
  return "read-unguarded";
}

/** Detect the `const local = obj.foo; ...if (!local) ...` pattern. The PAE
 *  must be the initializer of a single-name variable declaration; if any
 *  reference of the local is itself in a guard context, the property access
 *  is effectively defended. Skips destructuring (the binding-pattern path is
 *  already handled as guarded by `classifyRef`). */
function isAliasedAndDefended(pae: Node): boolean {
  const parent = pae.getParent();
  if (!parent?.isKind(SyntaxKind.VariableDeclaration)) return false;
  const decl = parent.asKindOrThrow(SyntaxKind.VariableDeclaration);
  if (decl.getInitializer() !== pae) return false;
  const nameNode = decl.getNameNode();
  if (!nameNode.isKind(SyntaxKind.Identifier)) return false;
  const localId = nameNode.asKindOrThrow(SyntaxKind.Identifier);
  for (const ref of localId.findReferencesAsNodes()) {
    if (ref === localId) continue;
    if (isReferenceDefensive(ref)) return true;
  }
  return false;
}

/** Same family of guard patterns as `classifyPropertyAccessRead`, but applied
 *  to a plain Identifier reference (not a PAE). Used by the alias check. */
function isReferenceDefensive(ref: Node): boolean {
  const parent = ref.getParent();
  if (!parent) return false;
  if (parent.isKind(SyntaxKind.PrefixUnaryExpression)) {
    const u = parent.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
    if (u.getOperatorToken() === SyntaxKind.ExclamationToken) return true;
  }
  if (parent.isKind(SyntaxKind.IfStatement)) {
    if (parent.asKindOrThrow(SyntaxKind.IfStatement).getExpression() === ref) {
      return true;
    }
  }
  if (parent.isKind(SyntaxKind.WhileStatement)) {
    if (
      parent.asKindOrThrow(SyntaxKind.WhileStatement).getExpression() === ref
    ) {
      return true;
    }
  }
  if (parent.isKind(SyntaxKind.ConditionalExpression)) {
    if (
      parent.asKindOrThrow(SyntaxKind.ConditionalExpression).getCondition() ===
      ref
    ) {
      return true;
    }
  }
  if (parent.isKind(SyntaxKind.TypeOfExpression)) return true;
  if (parent.isKind(SyntaxKind.BinaryExpression)) {
    const be = parent.asKindOrThrow(SyntaxKind.BinaryExpression);
    const op = be.getOperatorToken().getKind();
    if (op === SyntaxKind.QuestionQuestionToken && be.getLeft() === ref) {
      return true;
    }
    if (
      (op === SyntaxKind.BarBarToken ||
        op === SyntaxKind.AmpersandAmpersandToken) &&
      be.getLeft() === ref
    ) {
      return true;
    }
    const guardOps = new Set<number>([
      SyntaxKind.EqualsEqualsEqualsToken,
      SyntaxKind.ExclamationEqualsEqualsToken,
      SyntaxKind.EqualsEqualsToken,
      SyntaxKind.ExclamationEqualsToken,
    ]);
    if (guardOps.has(op)) {
      const other = be.getLeft() === ref ? be.getRight() : be.getLeft();
      const text = other.getText();
      if (text === "undefined" || text === "null") return true;
    }
  }
  return false;
}
