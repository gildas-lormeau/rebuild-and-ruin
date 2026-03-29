import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",

      // --- LLM-agent guardrails ---

      // Prevent type-safety erosion: agents reach for `any` when stuck
      "@typescript-eslint/no-explicit-any": "error",

      // Enforce project naming conventions so agents can't invent names
      "@typescript-eslint/naming-convention": [
        "error",
        // Types, interfaces, type aliases, enums, classes: PascalCase
        { selector: "typeLike", format: ["PascalCase"] },
        // Enum members: UPPER_CASE (allow PascalCase for Tile.Grass/Water)
        {
          selector: "enumMember",
          format: ["UPPER_CASE", "PascalCase"],
        },
        // Function declarations: camelCase
        { selector: "function", format: ["camelCase"] },
        // Class methods: camelCase
        { selector: "method", format: ["camelCase"], leadingUnderscore: "allow" },
      ],
    },
  },
];
