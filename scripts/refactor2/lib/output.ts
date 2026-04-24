import path from "node:path";
import process from "node:process";
import {
  type CommandResult,
  type OutputFormat,
  RefactorError,
} from "./types.ts";

export function emitError(err: unknown, format: OutputFormat): void {
  if (format === "json") {
    if (err instanceof RefactorError) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            code: err.code,
            message: err.message,
            details: err.details,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(
        JSON.stringify(
          {
            ok: false,
            code: "E_INTERNAL",
            message: err instanceof Error ? err.message : String(err),
          },
          null,
          2,
        ),
      );
    }
    return;
  }
  if (err instanceof RefactorError) {
    console.error(`[${err.code}] ${err.message}`);
    return;
  }
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
}

export function emit(result: CommandResult, format: OutputFormat): void {
  switch (format) {
    case "json":
      console.log(JSON.stringify(serializeResult(result), null, 2));
      return;
    case "diff":
    case "patch":
      emitDiff(result, format);
      return;
    default:
      emitHuman(result);
  }
}

export function exitCode(result: CommandResult): number {
  if (!result.ok) return 1;
  if (result.noop) return 3;
  return 0;
}

function emitHuman(result: CommandResult): void {
  if (result.message) console.log(result.message);
  if (result.changes?.length) {
    for (const change of result.changes) {
      console.log(`  ${change.file}`);
    }
    console.log(`(${result.changes.length} file(s) changed)`);
  }
  if (result.data !== undefined) {
    console.log(JSON.stringify(result.data, null, 2));
  }
}

function emitDiff(result: CommandResult, format: OutputFormat): void {
  if (!result.changes?.length) {
    if (result.message) console.log(`# ${result.message}`);
    return;
  }
  for (const change of result.changes) {
    const header =
      format === "patch"
        ? `--- a/${rel(change.file)}\n+++ b/${rel(change.file)}`
        : `# ${rel(change.file)}`;
    console.log(header);
    console.log(unifiedDiff(change.before, change.after));
  }
}

function serializeResult(result: CommandResult) {
  return {
    ok: result.ok,
    code: result.code,
    noop: result.noop ?? false,
    message: result.message,
    changes:
      result.changes?.map((change) => ({
        file: rel(change.file),
        added: countLines(change.after) - countLines(change.before),
      })) ?? [],
    data: result.data,
  };
}

function rel(absPath: string): string {
  return path.relative(process.cwd(), absPath) || absPath;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function unifiedDiff(before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  const lines: string[] = [];
  for (let index = 0; index < maxLen; index++) {
    const bLine = beforeLines[index];
    const aLine = afterLines[index];
    if (bLine === aLine) continue;
    if (bLine !== undefined) lines.push(`-${bLine}`);
    if (aLine !== undefined) lines.push(`+${aLine}`);
  }
  return lines.join("\n");
}
