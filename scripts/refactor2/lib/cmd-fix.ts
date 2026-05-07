import {
  type Diagnostic,
  type DiagnosticMessageChain,
  Node,
  type SourceFile,
} from "ts-morph";
import { assertNotPinned } from "./pinned.ts";
import type { CommandContext, CommandResult, FileChange } from "./types.ts";

interface PendingFix {
  file: string;
  start: number;
  length: number;
  expression: string;
  expected: string;
}

const ASSIGNABILITY_CODES = new Set<number>([2322, 2345]);

export async function handle(
  ctx: CommandContext,
  verb: string,
): Promise<CommandResult> {
  if (verb !== "assignability") {
    return {
      ok: false,
      message: `unknown fix verb '${verb}'. Expected: assignability`,
    };
  }
  return await handleFixAssignability(ctx);
}

async function handleFixAssignability(
  ctx: CommandContext,
): Promise<CommandResult> {
  const helper = ctx.flagMap.get("helper");
  const cast = ctx.flagMap.get("cast");
  const target = ctx.flagMap.get("target");
  const maxPasses = parseInt(ctx.flagMap.get("max-passes") ?? "10", 10);

  if (!helper && !cast) {
    return {
      ok: false,
      message: "fix assignability: provide --helper <fn> or --cast <type>",
    };
  }
  if (helper && cast) {
    return {
      ok: false,
      message: "fix assignability: --helper and --cast are mutually exclusive",
    };
  }
  if (!target) {
    return {
      ok: false,
      message:
        "fix assignability: provide --target <type> (only errors flowing into this type are fixed)",
    };
  }
  if (!Number.isFinite(maxPasses) || maxPasses < 1) {
    return {
      ok: false,
      message: `fix assignability: --max-passes must be a positive integer (got '${ctx.flagMap.get("max-passes")}')`,
    };
  }

  const before = new Map<string, string>();
  for (const sf of ctx.project.getSourceFiles()) {
    before.set(sf.getFilePath(), sf.getFullText());
  }

  let totalFixes = 0;
  const visitedFiles = new Set<string>();
  let lastPassCount = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const fixes = collectFixes(ctx, target);
    if (fixes.length === 0) break;
    if (fixes.length === lastPassCount) {
      // No progress — bail to avoid infinite loop on un-fixable diagnostics
      return {
        ok: false,
        message: `fix assignability: no progress on pass ${pass + 1} (${fixes.length} unresolved error(s)). Wrapping cannot resolve these — check --target and inspect manually.`,
        data: fixes.slice(0, 10),
      };
    }
    lastPassCount = fixes.length;

    const grouped = groupBy(fixes, (fix) => fix.file);
    for (const [file, fileFixes] of grouped) {
      const sourceFile = ctx.project.getSourceFile(file);
      if (!sourceFile) continue;
      visitedFiles.add(file);
      const sorted = [...fileFixes].sort(
        (left, right) => right.start - left.start,
      );
      for (const fix of sorted) {
        applyFix(sourceFile, fix, helper, cast);
      }
    }
    totalFixes += fixes.length;
  }

  if (totalFixes === 0) {
    return {
      ok: true,
      noop: true,
      code: "E_ALREADY_DONE",
      message: `fix assignability: no errors flow into ${target}`,
    };
  }

  const touched = [...visitedFiles];
  assertNotPinned(touched, ctx.pinned, ctx.flags.force);

  const changes: FileChange[] = [];
  for (const file of touched) {
    const sourceFile = ctx.project.getSourceFile(file);
    if (!sourceFile) continue;
    const after = sourceFile.getFullText();
    const beforeText = before.get(file) ?? "";
    if (after !== beforeText) {
      changes.push({ file, before: beforeText, after });
    }
  }

  if (!ctx.flags.dryRun) {
    await ctx.project.save();
  }

  return {
    ok: true,
    message: ctx.flags.dryRun
      ? `fix assignability (dry-run): would wrap ${totalFixes} expression(s) across ${changes.length} file(s)`
      : `fix assignability: wrapped ${totalFixes} expression(s) across ${changes.length} file(s)`,
    changes,
  };
}

function collectFixes(ctx: CommandContext, target: string): PendingFix[] {
  const fixes: PendingFix[] = [];
  const seen = new Set<string>();
  const diagnostics = ctx.project.getPreEmitDiagnostics();

  for (const diagnostic of diagnostics) {
    const code = diagnostic.getCode();
    if (!ASSIGNABILITY_CODES.has(code)) continue;
    const sourceFile = diagnostic.getSourceFile();
    const start = diagnostic.getStart();
    const length = diagnostic.getLength();
    if (!sourceFile || start === undefined || length === undefined) continue;

    const message = flattenMessage(diagnostic);
    if (!messageExpectsType(message, target)) continue;

    const filePath = sourceFile.getFilePath();
    const span = adjustSpanToValueExpression(sourceFile, start, length);
    const key = `${filePath}:${span.start}:${span.length}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const expression = sourceFile
      .getFullText()
      .slice(span.start, span.start + span.length);
    fixes.push({
      file: filePath,
      start: span.start,
      length: span.length,
      expression,
      expected: target,
    });
  }
  return fixes;
}

function adjustSpanToValueExpression(
  sourceFile: SourceFile,
  start: number,
  length: number,
): { start: number; length: number } {
  // For object-literal `{ zone: 0 }`, TS reports the span on the property name
  // `zone`. Wrapping that yields nonsense (`asZoneId(zone): 0`). Detect and
  // redirect to the initializer.
  const node = sourceFile.getDescendantAtPos(start);
  if (!node) return { start, length };
  const parent = node.getParent();
  if (parent && Node.isPropertyAssignment(parent)) {
    if (parent.getNameNode().getStart() === start) {
      const initializer = parent.getInitializer();
      if (initializer) {
        return {
          start: initializer.getStart(),
          length: initializer.getEnd() - initializer.getStart(),
        };
      }
    }
  }
  // Shorthand `{ zone }` — equivalent to `{ zone: zone }`; wrap the identifier
  // as the initializer (it's both name and value).
  if (parent && Node.isShorthandPropertyAssignment(parent)) {
    const ident = parent.getNameNode();
    return {
      start: ident.getStart(),
      length: ident.getEnd() - ident.getStart(),
    };
  }
  return { start, length };
}

function messageExpectsType(message: string, target: string): boolean {
  // The diagnostic message chain expands branded aliases in follow-on lines
  // (e.g. "...assignable to type 'ZoneId'." then "...not assignable to type
  // '{ readonly __brand: ... }'."). The first "is not assignable to ... type
  // '<X>'" capture is the surface-level expected type that the source actually
  // declared — match that.
  const surface = message.match(
    /is not assignable to (?:parameter of type|type) '([^']+)'/,
  )?.[1];
  if (!surface) return false;
  if (surface === target) return true;
  // Match union/array forms like "ZoneId | null" or "ZoneId[]"
  const re = new RegExp(`(^|[\\s|&([])${escapeRegex(target)}(\\b|\\[)`);
  return re.test(surface);
}

function flattenMessage(diagnostic: Diagnostic): string {
  const text = diagnostic.getMessageText();
  if (typeof text === "string") return text;
  return flattenChain(text);
}

function flattenChain(chain: DiagnosticMessageChain): string {
  let out = chain.getMessageText();
  const next = chain.getNext();
  if (!next) return out;
  for (const child of next) {
    out += `\n  ${flattenChain(child)}`;
  }
  return out;
}

function applyFix(
  sourceFile: SourceFile,
  fix: PendingFix,
  helper: string | undefined,
  cast: string | undefined,
): void {
  const wrapped = helper
    ? `${helper}(${fix.expression})`
    : `(${fix.expression} as ${cast})`;
  sourceFile.replaceText([fix.start, fix.start + fix.length], wrapped);
}

function groupBy<T, K>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
