/**
 * Non-runtime architecture lint — enforce subsystem consumer boundaries for
 * game, online, input, and render domains.
 *
 * This complements scripts/lint-architecture.ts (runtime-only conventions)
 * by constraining who can import internal non-runtime subsystem files.
 *
 * Usage:
 *   deno run -A scripts/lint-architecture-non-runtime.ts
 */

import process from "node:process";
import { Project } from "ts-morph";

interface Violation {
  importer: string;
  imported: string;
  rule: string;
}

interface BoundaryRule {
  name: string;
  matchesImported: (file: string) => boolean;
  isAllowedImporter: (file: string) => boolean;
}

function normalizeFile(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

const rules: BoundaryRule[] = [
  {
    name: "game-subsystems",
    matchesImported: (file) =>
      file.startsWith("src/game/") &&
      (file.endsWith("-system.ts") ||
        file.endsWith("/phase-setup.ts") ||
        file.endsWith("/round-modifiers.ts") ||
        file.endsWith("/upgrade-system.ts")),
    isAllowedImporter: (file) =>
      startsWithAny(file, ["src/game/"]) ||
      file === "src/online/online-server-events.ts" ||
      file === "src/online/online-phase-transitions.ts" ||
      file === "src/online/online-serialize.ts",
  },
  {
    name: "online-runtime-subsystems",
    matchesImported: (file) =>
      file.startsWith("src/online/online-runtime-") &&
      file !== "src/online/online-runtime-deps.ts" &&
      file !== "src/online/online-runtime-game.ts",
    isAllowedImporter: (file) =>
      file === "src/online/online-runtime-game.ts" ||
      file === "src/online/online-runtime-deps.ts" ||
      file === "src/online/online-runtime-lobby.ts",
  },
  {
    name: "input-subsystems",
    matchesImported: (file) =>
      file.startsWith("src/input/input-") && file !== "src/input/input.ts",
    isAllowedImporter: (file) =>
      file === "src/runtime/runtime-composition.ts" ||
      startsWithAny(file, ["src/input/"]),
  },
  {
    name: "render-subsystems",
    matchesImported: (file) =>
      file.startsWith("src/render/render-") &&
      file !== "src/render/render-composition.ts" &&
      file !== "src/render/render-canvas.ts",
    isAllowedImporter: (file) =>
      startsWithAny(file, ["src/render/"]) ||
      file === "src/runtime/runtime-composition.ts" ||
      file === "src/main.ts" ||
      file === "src/online/online-runtime-lobby.ts",
  },
];

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

project.addSourceFilesAtPaths("src/**/*.ts");

const sourceFiles = project
  .getSourceFiles()
  .filter((sf) => !sf.getBaseName().endsWith(".d.ts"));

const violations: Violation[] = [];
let checkedImports = 0;

for (const sourceFile of sourceFiles) {
  const importer = normalizeFile(sourceFile.getFilePath()).replace(
    `${process.cwd()}/`,
    "",
  );

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const resolved = importDecl.getModuleSpecifierSourceFile();
    if (!resolved) continue;

    const imported = normalizeFile(resolved.getFilePath()).replace(
      `${process.cwd()}/`,
      "",
    );
    if (!imported.startsWith("src/")) continue;
    checkedImports++;

    for (const rule of rules) {
      if (!rule.matchesImported(imported)) continue;
      if (rule.isAllowedImporter(importer)) continue;

      violations.push({
        importer,
        imported,
        rule: rule.name,
      });
    }
  }
}

if (violations.length === 0) {
  console.log(
    `\n✔ No non-runtime architecture boundary violations (${sourceFiles.length} files, ${checkedImports} imports checked)\n`,
  );
  process.exit(0);
}

violations.sort((a, b) => {
  if (a.rule !== b.rule) return a.rule.localeCompare(b.rule);
  if (a.imported !== b.imported) return a.imported.localeCompare(b.imported);
  return a.importer.localeCompare(b.importer);
});

console.log(
  `\n✘ ${violations.length} non-runtime architecture boundary violation(s):\n`,
);
for (const violation of violations) {
  console.log(
    `  [${violation.rule}] ${violation.importer} -> ${violation.imported}`,
  );
}
console.log("");

process.exit(1);
