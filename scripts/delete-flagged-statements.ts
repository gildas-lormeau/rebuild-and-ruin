/**
 * One-shot tool: read tsc TS6133/TS6196 (declared-but-never-used) errors
 * from stdin and remove the offending declaration at each file:line.
 * Companion to demote-flagged-exports.ts — together they handle the
 * "demote then prune" cascade when an ignore is removed and the dead
 * code that was hiding behind it surfaces in waves.
 *
 * Usage: tsc --noEmit 2>&1 | grep "TS61" | deno run -A scripts/delete-flagged-statements.ts
 */

import { Project, type Statement } from "ts-morph";

const text = await new Response(Deno.stdin.readable).text();
const targets = new Map<string, Set<number>>();
const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

let removed = 0;
let missed = 0;

for (const line of text.split("\n")) {
  // tsc format: src/path.ts(123,10): error TS6133: '...' is declared...
  const match = line.match(/^([^(]+\.ts)\((\d+),\d+\):\s+error TS61\d\d:/);
  if (!match) continue;
  const file = match[1]!;
  const lineNo = Number(match[2]);
  let set = targets.get(file);
  if (!set) {
    set = new Set();
    targets.set(file, set);
  }
  set.add(lineNo);
}

for (const [file, lines] of targets) {
  const sf = project.addSourceFileAtPath(file);
  // Collect first, then remove (mutating during iteration shifts indices).
  const toRemove: Statement[] = [];
  for (const stmt of sf.getStatements()) {
    if (lines.has(stmt.getStartLineNumber())) toRemove.push(stmt);
  }
  if (toRemove.length === 0) {
    missed += lines.size;
    continue;
  }
  for (const stmt of toRemove) stmt.remove();
  removed += toRemove.length;
  if (toRemove.length < lines.size) missed += lines.size - toRemove.length;
}

await project.save();

console.log(`removed ${removed}, missed ${missed}`);
