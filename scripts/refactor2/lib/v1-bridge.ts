import { spawnSync } from "node:child_process";
import { assertNotPinned } from "./pinned.ts";

export interface V1Result {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

const V1_SCRIPT = "scripts/refactor.ts";

export function v1Available(): boolean {
  const result = spawnSync("deno", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

export function assertPinnedSafe(
  command: string,
  args: string[],
  pinned: ReadonlyArray<string>,
  force: boolean,
): void {
  if (force) return;
  const touched = v1DryPreview(command, args);
  assertNotPinned(touched, pinned, force);
}

export function v1DryPreview(command: string, args: string[]): string[] {
  const result = runV1(command, args, { dryRun: true });
  if (!result.ok) return [];
  return extractTouchedFiles(result.stdout);
}

export function runV1(
  command: string,
  args: string[],
  opts: { dryRun?: boolean } = {},
): V1Result {
  const extras: string[] = [];
  if (opts.dryRun) extras.push("--dry-run");
  const result = spawnSync(
    "deno",
    ["run", "-A", V1_SCRIPT, command, ...args, ...extras],
    { encoding: "utf8" },
  );
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };
}

export function extractTouchedFiles(v1Output: string): string[] {
  const touched = new Set<string>();
  const patterns = [
    /\[dry-run\] Would modify: (\S+)/g,
    /^\s*Writing (\S+)/gm,
    /^\s*Updated (\S+)/gm,
    /^\s*Modified (\S+)/gm,
  ];
  for (const regex of patterns) {
    for (const match of v1Output.matchAll(regex)) {
      touched.add(match[1]);
    }
  }
  return [...touched];
}
