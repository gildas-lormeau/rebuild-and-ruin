/**
 * One-shot tool: read knip-flagged file:line:col entries from stdin and
 * remove the `export` modifier from each declaration. Used to clean up the
 * batch of dead exports surfaced when `src/render/3d/sprites/**` was
 * removed from knip's ignore. Keep around for similar future sweeps.
 *
 * Usage: cat /tmp/knip-flagged.txt | deno run -A scripts/demote-flagged-exports.ts
 */

import { Project, type Statement } from "ts-morph";

const text = await new Response(Deno.stdin.readable).text();
const targets = new Map<string, Set<number>>();
const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

let demoted = 0;
let missed = 0;

for (const line of text.split("\n")) {
  const trimmed = line.trim();
  const match = trimmed.match(/^(\S+\.ts):(\d+):\d+$/);
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
  for (const stmt of sf.getStatements()) {
    if (!lines.has(stmt.getStartLineNumber())) continue;
    const candidate = stmt as Statement & {
      isExported?(): boolean;
      setIsExported?(value: boolean): unknown;
    };
    if (
      typeof candidate.isExported === "function" &&
      typeof candidate.setIsExported === "function" &&
      candidate.isExported()
    ) {
      candidate.setIsExported(false);
      demoted++;
    } else {
      missed++;
    }
  }
}

await project.save();

console.log(`demoted ${demoted}, missed ${missed}`);
