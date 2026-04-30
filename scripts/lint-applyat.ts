/**
 * Lockstep applyAt-source lint.
 *
 * Wire-message handlers in `online-server-events.ts` must source
 * `applyAt` from the wire message (`msg`), never from a locally
 * computed value. The receiver's local sim tick is not the
 * originator's, so any locally computed `applyAt` would fire on a
 * different logical tick on each peer and break lockstep.
 *
 * Failure mode this catches: someone adds (or modifies) a state-
 * mutating wire-message handler and stamps `applyAt` from
 * `state.simTick + N`, a numeric literal, or any other locally
 * derived expression. TypeScript can't tell the difference — both
 * sides type as `number` — so the bug would slip through tsc and only
 * surface as cross-peer divergence under load.
 *
 * Rules (scoped to src/online/online-server-events.ts):
 *   1. Object-literal field `applyAt: <expr>` — `<expr>` must be the
 *      bare identifier `applyAt` (sourced from msg destructuring) or
 *      the property access `msg.applyAt`.
 *   2. Variable declaration `const|let applyAt = <expr>` — `<expr>`
 *      must be exactly `msg.applyAt`.
 *   3. Destructuring `const { ..., applyAt, ... } = X` — `X` must be
 *      the identifier `msg`.
 *
 * The reverse direction (every wire-message interface declaring
 * `applyAt` must be referenced by a scheduling handler) is left to
 * tsc + knip: a stale `applyAt` field on an unused message type would
 * surface as a knip warning on the message type itself.
 *
 * Usage:
 *   deno run -A scripts/lint-applyat.ts
 *
 * Exits 1 on violations.
 */

import process from "node:process";
import { Node, Project } from "ts-morph";

interface Violation {
  line: number;
  message: string;
  snippet: string;
}

const TARGET = "src/online/online-server-events.ts";

main();

function main(): void {
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  const sourceFile = project.addSourceFileAtPath(TARGET);

  const violations: Violation[] = [];

  sourceFile.forEachDescendant((node) => {
    // Rule 1: object-literal property assignment with key "applyAt".
    if (Node.isPropertyAssignment(node) && node.getName() === "applyAt") {
      // Skip type-position uses (interface/type-literal members are
      // PropertySignature, not PropertyAssignment, so we don't reach
      // this branch for them — but guard anyway).
      const initializer = node.getInitializer();
      if (!initializer) return;
      if (!isWireSourcedExpression(initializer)) {
        violations.push({
          line: node.getStartLineNumber(),
          message: `applyAt object-literal value must be \`applyAt\` (destructured from msg) or \`msg.applyAt\` — got \`${initializer.getText()}\`. Sourcing from anywhere else breaks lockstep.`,
          snippet: node.getText(),
        });
      }
      return;
    }

    // Rule 2: variable declaration `const|let applyAt = <expr>`.
    if (Node.isVariableDeclaration(node)) {
      const nameNode = node.getNameNode();
      if (Node.isIdentifier(nameNode) && nameNode.getText() === "applyAt") {
        const initializer = node.getInitializer();
        if (!initializer) return;
        if (!isMsgApplyAtAccess(initializer)) {
          violations.push({
            line: node.getStartLineNumber(),
            message: `\`applyAt\` variable must be initialized from \`msg.applyAt\` — got \`${initializer.getText()}\`. Lockstep requires the wire-supplied value.`,
            snippet: node.getText(),
          });
        }
        return;
      }

      // Rule 3: destructuring `const { ..., applyAt, ... } = X`.
      if (Node.isObjectBindingPattern(nameNode)) {
        const includesApplyAt = nameNode.getElements().some((el) => {
          const propNameNode = el.getPropertyNameNode();
          if (propNameNode) return propNameNode.getText() === "applyAt";
          return el.getNameNode().getText() === "applyAt";
        });
        if (!includesApplyAt) return;
        const initializer = node.getInitializer();
        if (!initializer) return;
        if (
          !Node.isIdentifier(initializer) ||
          initializer.getText() !== "msg"
        ) {
          violations.push({
            line: node.getStartLineNumber(),
            message: `applyAt destructured from \`${initializer.getText()}\` — must come from \`msg\`. Lockstep requires the wire-supplied value.`,
            snippet: node.getText(),
          });
        }
        return;
      }
    }
  });

  if (violations.length === 0) {
    console.log(`✔ applyAt-source lint OK (${TARGET})`);
    process.exit(0);
  }

  console.log(
    `✘ ${violations.length} applyAt-source violation(s) in ${TARGET}:\n`,
  );
  for (const violation of violations) {
    console.log(`  line ${violation.line}: ${violation.message}`);
    console.log(`    ${violation.snippet}\n`);
  }
  process.exit(1);
}

/** True if `expr` is the bare identifier `applyAt` or the property
 *  access `msg.applyAt`. Both are wire-sourced values per rules 2 and 3
 *  (destructuring / variable-from-msg.applyAt). */
function isWireSourcedExpression(expr: Node): boolean {
  if (Node.isIdentifier(expr) && expr.getText() === "applyAt") return true;
  return isMsgApplyAtAccess(expr);
}

function isMsgApplyAtAccess(expr: Node): boolean {
  if (!Node.isPropertyAccessExpression(expr)) return false;
  if (expr.getName() !== "applyAt") return false;
  const target = expr.getExpression();
  return Node.isIdentifier(target) && target.getText() === "msg";
}
