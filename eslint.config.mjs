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
      "id-length": ["error", {
          min: 2,
          exceptions: [
            "_",
            "x", "y",       // pixel/world coordinates
            "r", "c",       // row/col (grid coordinates, unpackTile destructuring)
            "w", "h",       // width/height (lowercase)
            "W", "H",       // width/height (canvas constants in render code)
            "L", "R", "T", "B", // left/right/top/bottom bounds
            "i", "j", "k",  // loop indices
            "a", "b",       // sort comparators
            "e",            // event handlers
          ],
        }],

      // --- LLM-agent guardrails ---

      // Prevent type-safety erosion: agents reach for `any` when stuck
      "@typescript-eslint/no-explicit-any": "error",

      // Ban patterns that have safer alternatives (architecture audit)
      "no-restricted-syntax": [
        "error",
        {
          // isHost is VOLATILE — can flip during host promotion.
          // All reads must go through isHostInContext() (tick-context.ts).
          // All writes are restricted to session init/reset/promotion.
          selector: "MemberExpression[property.name='isHost']",
          message:
            "Direct .isHost access is banned (volatile field). Read via isHostInContext(session) from tick-context.ts; write only in session init/reset/promotion with eslint-disable.",
        },
      ],

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
