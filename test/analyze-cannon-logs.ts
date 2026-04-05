/**
 * Analyze [cannon] logs from e2e test.
 * Checks:
 * 1. Phantom never moves while mouse is inside its footprint (INSIDE → no move)
 * 2. Phantom only moves when mouse exits (EXITED)
 * 3. No jumps > 1 tile on exit moves
 *
 * Usage: npx tsx test/analyze-cannon-logs.ts logs/<file>.log
 */

import { readFileSync } from "fs";



const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx test/analyze-cannon-logs.ts <logfile>");
  process.exit(1);
}

const lines = readFileSync(file, "utf-8").split("\n");

let insideCount = 0;
let exitedCount = 0;
let insideButMoved = 0;
let jumpFails = 0;
let prevRow = -1;
let prevCol = -1;

const RE_INSIDE = /\[cannon\] sz=(\d+) world=\(([^,]+),([^)]+)\) INSIDE/;
const RE_EXITED = /\[cannon\] sz=(\d+) world=\(([^,]+),([^)]+)\) EXITED.*\((\d+),(\d+)\)→\((\d+),(\d+)\)/;
const RE_OLD = /\[cannon\] sz=(\d+) world=\(([^,]+),([^)]+)\) cursor=\((\d+),(\d+)\)/;

const failures: string[] = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]!;
  const lineNum = i + 1;

  const mInside = line.match(RE_INSIDE);
  if (mInside) {
    insideCount++;
    continue;
  }

  const mExited = line.match(RE_EXITED);
  if (mExited) {
    exitedCount++;
    const row = Number(mExited[4]);
    const col = Number(mExited[5]);
    if (prevRow >= 0) {
      const dRow = Math.abs(row - prevRow);
      const dCol = Math.abs(col - prevCol);
      if (dRow > 1 || dCol > 1) {
        if (jumpFails < 10) {
          failures.push(`  line ${lineNum}: jump (${prevRow},${prevCol})→(${row},${col})`);
        }
        jumpFails++;
      }
    }
    prevRow = row;
    prevCol = col;
    continue;
  }

  // Old-format log (no INSIDE/EXITED) means the bbox check isn't running
  const mOld = line.match(RE_OLD);
  if (mOld) {
    insideButMoved++;
    if (insideButMoved <= 5) {
      failures.push(`  line ${lineNum}: old-format log (bbox check not active): ${line.slice(0, 120)}`);
    }
  }
}

const total = insideCount + exitedCount + insideButMoved;

console.log(`\nParsed ${total} [cannon] entries from ${file}\n`);

if (total === 0) {
  console.log("FAIL: no [cannon] log entries found — mouse path not exercised");
  process.exit(1);
}

console.log(`  INSIDE (no move): ${insideCount}`);
console.log(`  EXITED (moved):   ${exitedCount}`);
console.log(`  Old format:       ${insideButMoved}`);
console.log(`  Jump violations:  ${jumpFails}`);

if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
}

if (insideButMoved === 0 && jumpFails === 0 && insideCount > 0) {
  console.log(`\nPASS — phantom stable inside bbox (${insideCount} stable, ${exitedCount} moves)\n`);
} else {
  console.log(`\nFAIL\n`);
  process.exit(1);
}
