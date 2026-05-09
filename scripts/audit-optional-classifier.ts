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

  return "read-unguarded";
}
