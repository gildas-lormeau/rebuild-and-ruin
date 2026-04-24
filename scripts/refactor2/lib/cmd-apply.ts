import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CommandContext,
  CommandResult,
  Manifest,
  ManifestOp,
} from "./types.ts";
import { assertPinnedSafe, runV1, type V1Result } from "./v1-bridge.ts";

interface OpResult {
  op: string;
  ok: boolean;
  message: string;
}

interface ApplySummary {
  results: OpResult[];
  applied: number;
  total: number;
}

const KNOWN_OPS: ReadonlySet<ManifestOp["op"]> = new Set<ManifestOp["op"]>([
  "rename.symbol",
  "rename.prop",
  "rename.file",
  "move.export",
  "expose.reexport",
  "expose.redirect",
  "remove.export",
  "inline.constant",
  "inline.param",
  "imports.merge",
]);

export async function handle(
  ctx: CommandContext,
  _verb: string,
): Promise<CommandResult> {
  const manifestPath = ctx.positional[0];
  if (!manifestPath) {
    return {
      ok: false,
      message: "usage: refactor apply <manifest.json> [--dry-run] [--verify]",
    };
  }

  const absPath = resolve(ctx.cwd, manifestPath);
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      message: `apply: cannot read manifest '${manifestPath}': ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      message: `apply: manifest is not valid JSON: ${(err as Error).message}`,
    };
  }

  const ops = extractOps(parsed);
  if (!ops.ok) {
    return { ok: false, message: `apply: ${ops.error}` };
  }

  const validation = validateOps(ops.ops);
  if (!validation.ok) {
    return { ok: false, message: `apply: ${validation.error}` };
  }

  const summary = await executeOps(ctx, ops.ops);

  let message = `applied ${summary.applied}/${summary.total} ops`;
  const firstFailure = summary.results.find((result) => !result.ok);
  if (firstFailure) {
    message = `${message}; first failure: [${firstFailure.op}] ${firstFailure.message}`;
  }

  if (
    ctx.flags.verify &&
    !ctx.flags.dryRun &&
    summary.applied === summary.total
  ) {
    const tsc = runTsc();
    if (!tsc.ok) {
      message = `${message}\n[verify] tsc --noEmit failed (writes not rolled back):\n${tsc.output}`;
    } else {
      message = `${message}\n[verify] tsc --noEmit ok`;
    }
  }

  return {
    ok: summary.applied === summary.total,
    message,
    data: summary.results,
  };
}

function extractOps(
  parsed: unknown,
): { ok: true; ops: unknown[] } | { ok: false; error: string } {
  if (Array.isArray(parsed)) {
    return { ok: true, ops: parsed };
  }
  if (parsed && typeof parsed === "object" && "ops" in parsed) {
    const opsField = (parsed as Manifest).ops;
    if (!Array.isArray(opsField)) {
      return { ok: false, error: "manifest.ops must be an array" };
    }
    return { ok: true, ops: opsField };
  }
  return {
    ok: false,
    error: "manifest must be an array or an object with an 'ops' array",
  };
}

function validateOps(
  ops: unknown[],
): { ok: true } | { ok: false; error: string } {
  for (let index = 0; index < ops.length; index++) {
    const entry = ops[index];
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `op[${index}] is not an object` };
    }
    const opField = (entry as { op?: unknown }).op;
    if (typeof opField !== "string") {
      return {
        ok: false,
        error: `op[${index}] missing 'op' field (string)`,
      };
    }
    if (!KNOWN_OPS.has(opField as ManifestOp["op"])) {
      return {
        ok: false,
        error: `op[${index}] has unknown op '${opField}'. Known: ${[...KNOWN_OPS].join(", ")}`,
      };
    }
  }
  return { ok: true };
}

function executeOps(ctx: CommandContext, ops: unknown[]): ApplySummary {
  const results: OpResult[] = [];
  let applied = 0;
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index] as ManifestOp;
    const outcome = runOp(op, ctx.flags.dryRun, ctx.pinned, ctx.flags.force);
    results.push(outcome);
    if (outcome.ok) {
      applied++;
      continue;
    }
    if (!ctx.flags.dryRun) {
      break;
    }
  }
  return { results, applied, total: ops.length };
}

function runOp(
  op: ManifestOp,
  dryRun: boolean,
  pinned: ReadonlyArray<string>,
  force: boolean,
): OpResult {
  switch (op.op) {
    case "rename.symbol": {
      const args = [op.file, op.name, op.newName];
      if (op.cascade) args.push("--cascade");
      assertPinnedSafe("rename-symbol", args, pinned, force);
      return toResult(op.op, runV1("rename-symbol", args, { dryRun }));
    }
    case "rename.prop": {
      const args = op.file
        ? [op.file, op.typeName, op.prop, op.newProp]
        : [op.typeName, op.prop, op.newProp];
      assertPinnedSafe("rename-prop", args, pinned, force);
      return toResult(op.op, runV1("rename-prop", args, { dryRun }));
    }
    case "rename.file": {
      assertPinnedSafe("rename-file", [op.from, op.to], pinned, force);
      return toResult(
        op.op,
        runV1("rename-file", [op.from, op.to], { dryRun }),
      );
    }
    case "move.export": {
      const symbols = Array.isArray(op.symbol) ? op.symbol : [op.symbol];
      if (symbols.length === 0) {
        return {
          op: op.op,
          ok: false,
          message: "move.export requires at least one symbol",
        };
      }
      let args: string[];
      if (symbols.length === 1) {
        args = [op.from, op.to, symbols[0]];
      } else {
        args = ["--from", op.from, "--to", op.to];
        for (const sym of symbols) {
          args.push("--symbol", sym);
        }
      }
      assertPinnedSafe("move-export", args, pinned, force);
      return toResult(op.op, runV1("move-export", args, { dryRun }));
    }
    case "expose.reexport": {
      const args = [op.barrel, op.from, op.symbol];
      if (op.type) args.push("--type");
      assertPinnedSafe("add-reexport", args, pinned, force);
      return toResult(op.op, runV1("add-reexport", args, { dryRun }));
    }
    case "expose.redirect": {
      assertPinnedSafe(
        "redirect-import",
        [op.symbol, op.from, op.to],
        pinned,
        force,
      );
      return toResult(
        op.op,
        runV1("redirect-import", [op.symbol, op.from, op.to], { dryRun }),
      );
    }
    case "remove.export": {
      assertPinnedSafe("remove-export", [op.file, op.name], pinned, force);
      return toResult(
        op.op,
        runV1("remove-export", [op.file, op.name], { dryRun }),
      );
    }
    case "inline.constant": {
      assertPinnedSafe(
        "fold-constant",
        [op.file, op.name, op.value],
        pinned,
        force,
      );
      return toResult(
        op.op,
        runV1("fold-constant", [op.file, op.name, op.value], { dryRun }),
      );
    }
    case "inline.param": {
      const args = [op.file, op.fn, op.param, op.value];
      if (op.dropParam) args.push("--drop-param");
      assertPinnedSafe("inline-param", args, pinned, force);
      return toResult(op.op, runV1("inline-param", args, { dryRun }));
    }
    case "imports.merge": {
      const args = op.files.length > 0 ? op.files : ["--all"];
      assertPinnedSafe("merge-imports", args, pinned, force);
      return toResult(op.op, runV1("merge-imports", args, { dryRun }));
    }
    default:
      return assertUnreachable(op);
  }
}

function toResult(opName: string, result: V1Result): OpResult {
  const body = result.stdout.trim() || result.stderr.trim();
  return {
    op: opName,
    ok: result.ok,
    message: body || (result.ok ? "ok" : `exit ${result.code}`),
  };
}

function assertUnreachable(op: never): OpResult {
  const opField = (op as { op?: string }).op ?? "<unknown>";
  return {
    op: opField,
    ok: false,
    message: `unhandled op '${opField}'`,
  };
}

function runTsc(): { ok: boolean; output: string } {
  const result = spawnSync("npx", ["tsc", "--noEmit"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}
