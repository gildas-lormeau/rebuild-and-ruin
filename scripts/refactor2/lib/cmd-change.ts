import { Node, type SourceFile } from "ts-morph";
import { resolveAll, toRel } from "./addressing.ts";
import { assertNotPinned } from "./pinned.ts";
import type { CommandContext, CommandResult, FileChange } from "./types.ts";

interface RetypeTarget {
  node: Node;
  label: string;
  file: string;
  currentType: string;
}

export async function handle(
  ctx: CommandContext,
  verb: string,
): Promise<CommandResult> {
  if (verb !== "type") {
    return {
      ok: false,
      message: `unknown change verb '${verb}'. Expected: type`,
    };
  }
  return await handleChangeType(ctx);
}

async function handleChangeType(ctx: CommandContext): Promise<CommandResult> {
  const newType = ctx.flagMap.get("to");
  if (!newType) {
    return { ok: false, message: "change type: missing --to <newType>" };
  }

  const positional = ctx.positional;
  const paramsNamed = ctx.flagMap.get("params-named");
  const fromType = ctx.flagMap.get("from-type");
  const importFrom = ctx.flagMap.get("import-from");
  const importTypeOnly = ctx.flagMap.get("import-type") === "true";

  if (positional.length === 0 && !paramsNamed) {
    return {
      ok: false,
      message:
        "change type: provide <Type.member>... positional or --params-named <name> [--from-type <type>]",
    };
  }

  const targets: RetypeTarget[] = [];
  for (const subject of positional) {
    const result = resolveMemberTargets(ctx, subject);
    if (result.error) return { ok: false, message: result.error };
    targets.push(...result.targets);
  }
  if (paramsNamed) {
    targets.push(...resolveParamsNamed(ctx, paramsNamed, fromType));
  }

  if (targets.length === 0) {
    return {
      ok: false,
      message: `change type: no targets matched (positional=${positional.join(",") || "none"}, paramsNamed=${paramsNamed ?? "none"})`,
    };
  }

  const pending = targets.filter((target) => target.currentType !== newType);
  if (ctx.flags.idempotent && pending.length === 0) {
    return {
      ok: true,
      noop: true,
      code: "E_ALREADY_DONE",
      message: `change type: every target already typed ${newType} (${targets.length} target(s))`,
    };
  }

  const touchedFiles = unique(pending.map((target) => target.file));
  assertNotPinned(touchedFiles, ctx.pinned, ctx.flags.force);

  const before = new Map<string, string>();
  for (const file of touchedFiles) {
    const sf = ctx.project.getSourceFile(file);
    if (sf) before.set(file, sf.getFullText());
  }

  for (const target of pending) {
    setTypeOnNode(target.node, newType);
  }

  if (importFrom) {
    const baseName = extractBaseTypeName(newType);
    if (baseName) {
      for (const file of touchedFiles) {
        const sf = ctx.project.getSourceFile(file);
        if (sf) ensureImport(sf, baseName, importFrom, importTypeOnly);
      }
    }
  }

  const changes: FileChange[] = [];
  for (const file of touchedFiles) {
    const sf = ctx.project.getSourceFile(file);
    if (!sf) continue;
    const after = sf.getFullText();
    const beforeText = before.get(file) ?? "";
    if (after === beforeText) continue;
    changes.push({ file, before: beforeText, after });
  }

  if (!ctx.flags.dryRun) {
    await ctx.project.save();
  }

  const summary = pending.map((target) => ({
    label: target.label,
    file: toRel(target.file),
    from: target.currentType,
    to: newType,
  }));

  return {
    ok: true,
    message: ctx.flags.dryRun
      ? `change type (dry-run): would retype ${pending.length} target(s) to ${newType} across ${changes.length} file(s)`
      : `change type: retyped ${pending.length} target(s) to ${newType} across ${changes.length} file(s)`,
    changes,
    data: summary,
  };
}

function resolveMemberTargets(
  ctx: CommandContext,
  subject: string,
): { error?: string; targets: RetypeTarget[] } {
  const dotIdx = subject.indexOf(".");
  if (dotIdx < 0) {
    return {
      error: `change type: positional must be <Type.member>, got '${subject}'`,
      targets: [],
    };
  }
  const typeName = subject.slice(0, dotIdx);
  const memberName = subject.slice(dotIdx + 1);
  const matches = resolveAll(ctx.project, typeName, { near: ctx.flags.near });
  if (matches.length === 0) {
    return { error: `change type: no type named '${typeName}'`, targets: [] };
  }
  if (matches.length > 1) {
    const list = matches
      .map((match) => `  - ${toRel(match.file)}#${match.name}`)
      .join("\n");
    return {
      error: `change type: '${typeName}' is ambiguous (${matches.length} matches):\n${list}`,
      targets: [],
    };
  }

  const match = matches[0];
  const sourceFile = match.sourceFile;
  const targets: RetypeTarget[] = [];

  const intf = sourceFile.getInterface(typeName);
  if (intf) {
    const property = intf.getProperty(memberName);
    if (property) {
      targets.push({
        node: property,
        label: `${typeName}.${memberName}`,
        file: match.file,
        currentType: property.getTypeNode()?.getText() ?? "any",
      });
    }
  }

  if (targets.length === 0) {
    const cls = sourceFile.getClass(typeName);
    if (cls) {
      const property = cls.getProperty(memberName);
      if (property && Node.isPropertyDeclaration(property)) {
        targets.push({
          node: property,
          label: `${typeName}.${memberName}`,
          file: match.file,
          currentType: property.getTypeNode()?.getText() ?? "any",
        });
      }
    }
  }

  if (targets.length === 0) {
    const alias = sourceFile.getTypeAlias(typeName);
    if (alias) {
      const typeNode = alias.getTypeNode();
      if (typeNode && Node.isTypeLiteral(typeNode)) {
        for (const member of typeNode.getMembers()) {
          if (
            Node.isPropertySignature(member) &&
            member.getName() === memberName
          ) {
            targets.push({
              node: member,
              label: `${typeName}.${memberName}`,
              file: match.file,
              currentType: member.getTypeNode()?.getText() ?? "any",
            });
          }
        }
      }
    }
  }

  if (targets.length === 0) {
    return {
      error: `change type: no member '${memberName}' on '${typeName}' in ${toRel(match.file)}`,
      targets: [],
    };
  }
  return { targets };
}

function resolveParamsNamed(
  ctx: CommandContext,
  name: string,
  fromType: string | undefined,
): RetypeTarget[] {
  const targets: RetypeTarget[] = [];
  for (const sourceFile of ctx.project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isParameterDeclaration(node)) return;
      if (node.getName() !== name) return;
      const typeNode = node.getTypeNode();
      const currentType = typeNode?.getText() ?? "any";
      if (fromType && currentType !== fromType) return;
      targets.push({
        node,
        label: `param ${name} in ${describeFunctionContext(node)}`,
        file: sourceFile.getFilePath(),
        currentType,
      });
    });
  }
  return targets;
}

function describeFunctionContext(param: Node): string {
  const fnLike = param.getFirstAncestor(
    (ancestor) =>
      Node.isFunctionDeclaration(ancestor) ||
      Node.isMethodDeclaration(ancestor) ||
      Node.isArrowFunction(ancestor) ||
      Node.isFunctionExpression(ancestor) ||
      Node.isConstructorDeclaration(ancestor),
  );
  if (!fnLike) return "<unknown>";
  if (Node.isFunctionDeclaration(fnLike) || Node.isMethodDeclaration(fnLike)) {
    return fnLike.getName() ?? "<anon>";
  }
  if (Node.isConstructorDeclaration(fnLike)) {
    return `${fnLike.getParent().getName() ?? "<anon>"}.constructor`;
  }
  const varDecl = fnLike.getFirstAncestor(Node.isVariableDeclaration);
  if (varDecl) return varDecl.getName();
  return "<anon>";
}

function setTypeOnNode(node: Node, newType: string): void {
  if (Node.isPropertySignature(node)) {
    node.setType(newType);
    return;
  }
  if (Node.isPropertyDeclaration(node)) {
    node.setType(newType);
    return;
  }
  if (Node.isParameterDeclaration(node)) {
    node.setType(newType);
    return;
  }
  if (Node.isVariableDeclaration(node)) {
    node.setType(newType);
    return;
  }
}

function ensureImport(
  sourceFile: SourceFile,
  name: string,
  modulePath: string,
  typeOnly: boolean,
): void {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.getModuleSpecifierValue() !== modulePath) continue;
    for (const specifier of importDecl.getNamedImports()) {
      if (specifier.getName() === name) return;
    }
    importDecl.addNamedImport(name);
    return;
  }
  sourceFile.addImportDeclaration({
    moduleSpecifier: modulePath,
    namedImports: [name],
    isTypeOnly: typeOnly,
  });
}

function extractBaseTypeName(typeText: string): string | undefined {
  const match = typeText.match(/[A-Z][A-Za-z0-9_]*/);
  return match?.[0];
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
