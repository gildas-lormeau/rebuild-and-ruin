import { spawnSync } from "node:child_process";
import path from "node:path";
import { Node, type SourceFile } from "ts-morph";
import type { CommandContext, CommandResult } from "./types.ts";
import { assertPinnedSafe, runV1 } from "./v1-bridge.ts";

interface PruneSummary {
  file: string;
  removedSpecifiers: string[];
  removedDeclarations: number;
}

export function handle(
  ctx: CommandContext,
  verb: string,
): Promise<CommandResult> {
  switch (verb) {
    case "merge":
      return handleMerge(ctx);
    case "prune":
      return handlePrune(ctx);
    case "sort":
      return handleSort(ctx);
    default:
      return Promise.resolve({
        ok: false,
        message: `unknown imports verb '${verb}'. Expected: merge, prune, sort`,
      });
  }
}

function handleMerge(ctx: CommandContext): Promise<CommandResult> {
  const args: string[] = [];
  if (ctx.flags.all) {
    args.push("--all");
  } else if (ctx.positional.length > 0) {
    args.push(...ctx.positional);
  } else {
    return Promise.resolve({
      ok: false,
      message: "imports merge requires <file...> or --all",
    });
  }

  assertPinnedSafe("merge-imports", args, ctx.pinned, ctx.flags.force);
  const result = runV1("merge-imports", args, { dryRun: ctx.flags.dryRun });
  if (!result.ok) {
    return Promise.resolve({
      ok: false,
      message: `imports merge failed: ${result.stderr.trim() || result.stdout.trim()}`,
    });
  }
  return Promise.resolve({
    ok: true,
    message: result.stdout.trim() || "imports merge completed",
  });
}

async function handlePrune(ctx: CommandContext): Promise<CommandResult> {
  const patterns = ctx.positional;
  if (patterns.length === 0) {
    return {
      ok: false,
      message: "imports prune requires <glob...> or file paths",
    };
  }

  const matched = collectSourceFiles(ctx, patterns);
  if (matched.length === 0) {
    return {
      ok: false,
      message: `imports prune: no files matched ${patterns.join(", ")}`,
    };
  }

  const summaries: PruneSummary[] = [];
  for (const sf of matched) {
    const summary = pruneFile(sf);
    if (
      summary.removedSpecifiers.length > 0 ||
      summary.removedDeclarations > 0
    ) {
      summaries.push(summary);
    }
  }

  if (summaries.length === 0) {
    return { ok: true, message: "imports prune: no unused imports found" };
  }

  if (!ctx.flags.dryRun) {
    await ctx.project.save();
  }

  const totalSpecs = summaries.reduce(
    (acc, cur) => acc + cur.removedSpecifiers.length,
    0,
  );
  const message = ctx.flags.dryRun
    ? `imports prune (dry-run): would remove ${totalSpecs} unused import(s) across ${summaries.length} file(s)`
    : `imports prune: removed ${totalSpecs} unused import(s) across ${summaries.length} file(s)`;

  return { ok: true, message, data: summaries };
}

function handleSort(ctx: CommandContext): Promise<CommandResult> {
  const patterns = ctx.positional;
  if (patterns.length === 0) {
    return Promise.resolve({
      ok: false,
      message: "imports sort requires <glob...> or file paths",
    });
  }

  const args = ["biome", "check", "--write", ...patterns];
  const result = spawnSync("npx", args, { encoding: "utf8" });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const ok = result.status === 0;

  if (!ok) {
    return Promise.resolve({
      ok: false,
      message: `imports sort (biome) failed: ${stderr.trim() || stdout.trim()}`,
    });
  }
  return Promise.resolve({
    ok: true,
    message: stdout.trim() || "imports sort completed",
  });
}

function collectSourceFiles(
  ctx: CommandContext,
  patterns: string[],
): SourceFile[] {
  const seen = new Set<string>();
  const collected: SourceFile[] = [];

  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const regex = globToRegExp(pattern);
      for (const sf of ctx.project.getSourceFiles()) {
        const absPath = sf.getFilePath();
        const relPath = path.relative(ctx.cwd, absPath);
        if (regex.test(relPath) || regex.test(absPath)) {
          addUnique(seen, collected, sf);
        }
      }
    } else {
      const absPath = path.isAbsolute(pattern)
        ? pattern
        : path.resolve(ctx.cwd, pattern);
      const existing =
        ctx.project.getSourceFile(absPath) ?? safeAdd(ctx, absPath);
      if (existing) addUnique(seen, collected, existing);
    }
  }
  return collected;
}

function addUnique(
  seen: Set<string>,
  collected: SourceFile[],
  sf: SourceFile,
): void {
  const key = sf.getFilePath();
  if (seen.has(key)) return;
  seen.add(key);
  collected.push(sf);
}

function safeAdd(ctx: CommandContext, absPath: string): SourceFile | undefined {
  try {
    return ctx.project.addSourceFileAtPath(absPath);
  } catch {
    return undefined;
  }
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 2;
        if (glob[index] === "/") index += 1;
        continue;
      }
      pattern += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      index += 1;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(char)) {
      pattern += `\\${char}`;
      index += 1;
      continue;
    }
    pattern += char;
    index += 1;
  }
  return new RegExp(`^${pattern}$`);
}

function pruneFile(sf: SourceFile): PruneSummary {
  const summary: PruneSummary = {
    file: sf.getFilePath(),
    removedSpecifiers: [],
    removedDeclarations: 0,
  };

  for (const importDecl of [...sf.getImportDeclarations()]) {
    for (const specifier of [...importDecl.getNamedImports()]) {
      const aliasNode = specifier.getAliasNode();
      const nameNode = aliasNode ?? specifier.getNameNode();
      if (!Node.isIdentifier(nameNode)) continue;
      const refs = nameNode.findReferencesAsNodes();
      const externalRefs = refs.filter((ref) => ref !== nameNode);
      if (externalRefs.length === 0) {
        summary.removedSpecifiers.push(specifier.getName());
        specifier.remove();
      }
    }

    const nothingLeft =
      importDecl.getNamedImports().length === 0 &&
      !importDecl.getDefaultImport() &&
      !importDecl.getNamespaceImport();
    if (nothingLeft) {
      importDecl.remove();
      summary.removedDeclarations += 1;
    }
  }

  return summary;
}
