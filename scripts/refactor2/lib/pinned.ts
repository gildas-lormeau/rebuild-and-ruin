import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PinnedFileError } from "./types.ts";

const PINNED_FILE = ".refactor-pinned";
const DEFAULT_PATTERNS: ReadonlyArray<string> = [
  "test/determinism-fixtures/**",
  ".readonly-literals-baseline.json",
  ".import-layers.json",
  ".domain-boundaries.json",
];

export function loadPinned(cwd: string): ReadonlyArray<string> {
  const filePath = path.join(cwd, PINNED_FILE);
  if (!existsSync(filePath)) return DEFAULT_PATTERNS;
  const text = readFileSync(filePath, "utf8");
  const custom: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    custom.push(line);
  }
  return custom.length ? custom : DEFAULT_PATTERNS;
}

export function assertNotPinned(
  files: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
  force: boolean,
): void {
  if (force) return;
  const hits = filterPinned(files, patterns);
  if (hits.length > 0) {
    throw new PinnedFileError(hits);
  }
}

export function filterPinned(
  files: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
): string[] {
  return files.filter((file) => isPinned(file, patterns));
}

export function isPinned(
  file: string,
  patterns: ReadonlyArray<string>,
): boolean {
  const relative = normalize(file);
  return patterns.some((pattern) => matchesPattern(relative, pattern));
}

function normalize(file: string): string {
  const absRoot = process.cwd();
  const abs = path.isAbsolute(file) ? file : path.resolve(absRoot, file);
  const rel = path.relative(absRoot, abs);
  return rel.split(path.sep).join("/");
}

function matchesPattern(file: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(file);
}

function globToRegex(pattern: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 2;
        if (pattern[index] === "/") index++;
      } else {
        source += "[^/]*";
        index++;
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index++;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
    index++;
  }
  source += "$";
  return new RegExp(source);
}
