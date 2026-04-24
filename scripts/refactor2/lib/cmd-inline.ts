import { spawnSync } from "node:child_process";
import { parseAddress } from "./addressing.ts";
import type { CommandContext, CommandResult } from "./types.ts";
import { assertPinnedSafe, runV1 } from "./v1-bridge.ts";

export function handle(ctx: CommandContext, verb: string): CommandResult {
  switch (verb) {
    case "constant":
      return handleInlineConstant(ctx);
    case "param":
      return handleInlineParam(ctx);
    default:
      return {
        ok: false,
        message: `unknown inline verb '${verb}'. Expected: constant, param`,
      };
  }
}

function handleInlineConstant(ctx: CommandContext): CommandResult {
  const name = ctx.positional[0];
  const file = ctx.flagMap.get("file");
  const value = ctx.flagMap.get("value");
  if (!name || !file || !value) {
    return {
      ok: false,
      message:
        "inline constant requires <name> (positional), --file <file>, --value <true|false>",
    };
  }
  if (value !== "true" && value !== "false") {
    return {
      ok: false,
      message: `inline constant: --value must be 'true' or 'false' (got '${value}')`,
    };
  }

  assertPinnedSafe(
    "fold-constant",
    [file, name, value],
    ctx.pinned,
    ctx.flags.force,
  );
  const result = runV1("fold-constant", [file, name, value], {
    dryRun: ctx.flags.dryRun,
  });
  return finalize(ctx, result, "inline constant");
}

function handleInlineParam(ctx: CommandContext): CommandResult {
  const subject = ctx.positional[0];
  const file = ctx.flagMap.get("file");
  const value = ctx.flagMap.get("value");
  if (!subject || !file || !value) {
    return {
      ok: false,
      message:
        "inline param requires <fn.param> (positional), --file <file>, --value <true|false>",
    };
  }
  if (value !== "true" && value !== "false") {
    return {
      ok: false,
      message: `inline param: --value must be 'true' or 'false' (got '${value}')`,
    };
  }

  const address = parseAddress(subject);
  const fn = address.name;
  const param = address.member;
  if (!fn || !param) {
    return {
      ok: false,
      message: `inline param: <fn.param> must be a dotted address (got '${subject}')`,
    };
  }

  const args = [file, fn, param, value];
  if (ctx.flags.dropParam) args.push("--drop-param");

  assertPinnedSafe("inline-param", args, ctx.pinned, ctx.flags.force);
  const result = runV1("inline-param", args, { dryRun: ctx.flags.dryRun });
  return finalize(ctx, result, "inline param");
}

function finalize(
  ctx: CommandContext,
  result: { ok: boolean; stdout: string; stderr: string },
  label: string,
): CommandResult {
  const baseMessage = result.ok
    ? result.stdout.trim() || `${label} completed`
    : `${label} failed: ${result.stderr.trim() || result.stdout.trim()}`;

  if (!result.ok) {
    return { ok: false, message: baseMessage };
  }

  if (ctx.flags.verify && !ctx.flags.dryRun) {
    const tsc = runTsc();
    if (!tsc.ok) {
      return {
        ok: true,
        message: `${baseMessage}\nwarning: --verify tsc --noEmit failed:\n${tsc.output}`,
      };
    }
  }

  return { ok: true, message: baseMessage };
}

function runTsc(): { ok: boolean; output: string } {
  const result = spawnSync("npx", ["tsc", "--noEmit"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}
