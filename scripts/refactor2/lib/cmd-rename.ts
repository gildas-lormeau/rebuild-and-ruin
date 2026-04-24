import { spawnSync } from "node:child_process";
import { parseAddress, resolveSymbol, toRel } from "./addressing.ts";
import {
  fileOnDisk,
  hasTopLevelDecl,
  loadSourceFile,
  typeHasMemberAcrossProject,
} from "./idempotent.ts";
import type { CommandContext, CommandResult } from "./types.ts";
import { assertPinnedSafe, runV1 } from "./v1-bridge.ts";

interface VerifyOutcome {
  verified: boolean;
  tscOutput?: string;
}

export async function handle(
  ctx: CommandContext,
  verb: string,
): Promise<CommandResult> {
  switch (verb) {
    case "symbol":
      return await handleSymbol(ctx);
    case "prop":
      return await handleProp(ctx);
    case "file":
      return await handleFile(ctx);
    case "in-file":
      return await handleInFile(ctx);
    default:
      return {
        ok: false,
        message: `unknown rename verb: ${verb} (expected: symbol | prop | file | in-file)`,
      };
  }
}

async function handleSymbol(ctx: CommandContext): Promise<CommandResult> {
  const subject = ctx.positional[0];
  if (!subject) {
    return {
      ok: false,
      message: "usage: rename symbol <name-or-file#name> --to <newName>",
    };
  }
  const newName = ctx.flagMap.get("to");
  if (!newName) {
    return { ok: false, message: "rename symbol: missing --to <newName>" };
  }

  let file: string;
  let name: string;
  const hashIndex = subject.indexOf("#");
  if (hashIndex >= 0) {
    file = subject.slice(0, hashIndex);
    name = subject.slice(hashIndex + 1);
    if (!file || !name) {
      return {
        ok: false,
        message: `rename symbol: malformed qualified address '${subject}' (expected file#name)`,
      };
    }
  } else {
    const resolved = resolveSymbol(ctx.project, subject, {
      near: ctx.flags.near,
    });
    file = toRel(resolved.file);
    name = resolved.name;
  }

  if (ctx.flags.idempotent) {
    if (name === newName) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `rename symbol: old and new names are identical ('${name}')`,
      };
    }
    const sourceFile = loadSourceFile(ctx.project, ctx.cwd, file);
    if (sourceFile) {
      const hasOld = hasTopLevelDecl(sourceFile, name);
      const hasNew = hasTopLevelDecl(sourceFile, newName);
      if (!hasOld && hasNew) {
        return {
          ok: true,
          noop: true,
          code: "E_ALREADY_DONE",
          message: `rename symbol: '${newName}' already exists in ${file} and '${name}' is absent — assuming prior run completed`,
        };
      }
    }
  }

  const v1Args = [file, name, newName];
  if (ctx.flags.cascade) v1Args.push("--cascade");

  assertPinnedSafe("rename-symbol", v1Args, ctx.pinned, ctx.flags.force);
  const result = runV1("rename-symbol", v1Args, { dryRun: ctx.flags.dryRun });
  return await finalizeV1Result(ctx, result, {
    action: "rename symbol",
    detail: `${file}#${name} -> ${newName}`,
  });
}

async function handleProp(ctx: CommandContext): Promise<CommandResult> {
  const subject = ctx.positional[0];
  if (!subject) {
    return {
      ok: false,
      message: "usage: rename prop <Type.prop> --to <newProp>",
    };
  }
  const newProp = ctx.flagMap.get("to");
  if (!newProp) {
    return { ok: false, message: "rename prop: missing --to <newProp>" };
  }

  const address = parseAddress(subject);
  if (!address.member) {
    return {
      ok: false,
      message: `rename prop: expected 'Type.prop' form, got '${subject}'`,
    };
  }

  if (ctx.flags.idempotent) {
    if (address.member === newProp) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `rename prop: old and new prop names are identical ('${newProp}')`,
      };
    }
    const hasOld = typeHasMemberAcrossProject(
      ctx.project,
      address.name,
      address.member,
    );
    const hasNew = typeHasMemberAcrossProject(
      ctx.project,
      address.name,
      newProp,
    );
    if (!hasOld && hasNew) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `rename prop: '${address.name}.${newProp}' already exists and '${address.name}.${address.member}' is absent — assuming prior run completed`,
      };
    }
  }

  const v1Args = [address.name, address.member, newProp];
  if (ctx.flags.cascade) v1Args.push("--cascade");

  assertPinnedSafe("rename-prop", v1Args, ctx.pinned, ctx.flags.force);
  const result = runV1("rename-prop", v1Args, { dryRun: ctx.flags.dryRun });
  return await finalizeV1Result(ctx, result, {
    action: "rename prop",
    detail: `${address.name}.${address.member} -> ${newProp}`,
  });
}

async function handleFile(ctx: CommandContext): Promise<CommandResult> {
  const oldPath = ctx.positional[0];
  if (!oldPath) {
    return {
      ok: false,
      message: "usage: rename file <oldPath> --to <newPath>",
    };
  }
  const newPath = ctx.flagMap.get("to");
  if (!newPath) {
    return { ok: false, message: "rename file: missing --to <newPath>" };
  }

  if (ctx.flags.idempotent) {
    if (oldPath === newPath) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `rename file: old and new paths are identical ('${oldPath}')`,
      };
    }
    const oldExists = fileOnDisk(ctx.cwd, oldPath);
    const newExists = fileOnDisk(ctx.cwd, newPath);
    if (!oldExists && newExists) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `rename file: '${newPath}' exists and '${oldPath}' is absent — assuming prior run completed`,
      };
    }
  }

  assertPinnedSafe(
    "rename-file",
    [oldPath, newPath],
    ctx.pinned,
    ctx.flags.force,
  );
  const result = runV1("rename-file", [oldPath, newPath], {
    dryRun: ctx.flags.dryRun,
  });
  return await finalizeV1Result(ctx, result, {
    action: "rename file",
    detail: `${oldPath} -> ${newPath}`,
  });
}

async function handleInFile(ctx: CommandContext): Promise<CommandResult> {
  const name = ctx.positional[0];
  if (!name) {
    return {
      ok: false,
      message:
        "usage: rename in-file <name> --to <newName> --files <glob> [--files <glob>...]",
    };
  }
  const newName = ctx.flagMap.get("to");
  if (!newName) {
    return { ok: false, message: "rename in-file: missing --to <newName>" };
  }
  const files = ctx.flagMulti.get("files") ?? [];
  if (files.length === 0) {
    return {
      ok: false,
      message: "rename in-file: missing --files <glob> (repeatable)",
    };
  }

  if (ctx.flags.idempotent) {
    if (name === newName) {
      return {
        ok: true,
        noop: true,
        code: "E_ALREADY_DONE",
        message: `rename in-file: old and new names are identical ('${name}')`,
      };
    }
    const concreteFiles = files.filter(
      (candidate) => !hasGlobChars(candidate) && fileOnDisk(ctx.cwd, candidate),
    );
    if (concreteFiles.length > 0 && concreteFiles.length === files.length) {
      let allMigrated = true;
      for (const candidate of concreteFiles) {
        const sourceFile = loadSourceFile(ctx.project, ctx.cwd, candidate);
        if (!sourceFile) {
          allMigrated = false;
          break;
        }
        const hasOld = hasTopLevelDecl(sourceFile, name);
        const hasNew = hasTopLevelDecl(sourceFile, newName);
        if (hasOld || !hasNew) {
          allMigrated = false;
          break;
        }
      }
      if (allMigrated) {
        return {
          ok: true,
          noop: true,
          code: "E_ALREADY_DONE",
          message: `rename in-file: '${newName}' already present and '${name}' absent in all ${concreteFiles.length} file(s) — assuming prior run completed`,
        };
      }
    }
  }

  const v1Args = [name, newName, ...files];
  if (ctx.flags.cascade) v1Args.push("--cascade");

  assertPinnedSafe("rename-in-file", v1Args, ctx.pinned, ctx.flags.force);
  const result = runV1("rename-in-file", v1Args, { dryRun: ctx.flags.dryRun });
  return await finalizeV1Result(ctx, result, {
    action: "rename in-file",
    detail: `${name} -> ${newName} in ${files.length} glob(s)`,
  });
}

function finalizeV1Result(
  ctx: CommandContext,
  result: { ok: boolean; stdout: string; stderr: string; code: number },
  info: { action: string; detail: string },
): CommandResult {
  const body = result.stdout.trim() || result.stderr.trim();
  const baseMessage = body
    ? `${info.action}: ${info.detail}\n${body}`
    : `${info.action}: ${info.detail}`;

  if (!result.ok) {
    return { ok: false, message: baseMessage };
  }

  if (ctx.flags.verify && !ctx.flags.dryRun) {
    const verify = runTsc();
    if (!verify.verified) {
      // V1 has already written files; rollback is not possible without git.
      // Surface tsc output as a warning and keep ok=true so the caller sees
      // the V1 success but can still act on the regression.
      return {
        ok: true,
        message:
          `${baseMessage}\n[verify] tsc --noEmit reported errors (V1 writes not rolled back):\n${verify.tscOutput ?? ""}`.trimEnd(),
      };
    }
    return { ok: true, message: `${baseMessage}\n[verify] tsc --noEmit ok` };
  }

  return { ok: true, message: baseMessage };
}

function runTsc(): VerifyOutcome {
  const result = spawnSync("npx", ["tsc", "--noEmit"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { verified: result.status === 0, tscOutput: output };
}

function hasGlobChars(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}
