import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  {
    // Sprite scene files author geometry math in ±1 frustum coords using
    // short mathematical identifiers (N/E/S/W masks, r/R radii, x/y/z UV
    // axes, pz extrusion depth, etc.) — see sprites/CONVENTIONS.md. The
    // id-length rule is at odds with that style; exempt the whole folder.
    ignores: ["src/render/3d/sprites/**"],
  },
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
          min: 3,
          exceptions: [
            "_",
            "x", "y", "z",  // pixel/world coordinates
            "r", "c",       // row/col (grid coordinates, unpackTile destructuring)
            "w", "h",       // width/height (lowercase)
            "W", "H",       // width/height (canvas constants in render code)
            "L", "R", "T", "B", // left/right/top/bottom bounds
            "i", "j", "k",  // loop indices
            "a", "b",       // sort comparators
            "e",            // event handlers
            "id",           // identifier (player/entity IDs)
            "cz", "dz",     // collision/interaction zone radius
            "dt",           // delta time
            "t",            // timestamp (ms) in MIDI/music event data
            "hp",           // hit points
            "ms",           // milliseconds
            "ok",           // boolean result
            "ui",           // user interface (acronym)
            "on",           // boolean helper
            "sz",           // size (pixel math)
            "hi",           // highlight RGB
            "up",           // direction (key bindings)
            "bv",           // bevel value
          ],
          exceptionPatterns: [
            "^[a-z][xyrc]$", // coordinates (px, cy, dx…) and grid positions (dr, nc, tc…)
            "^[a-z][wh]$",   // dimensions (iw, ph, bw…) and crosshair/shadow (ch, sh)
            "^_.$",           // unused destructured vars (_r, _c, _g, _W, _H)
            "^[a-z][0-9]$",  // numbered coords/indices (x1, r2, c0, d1, t0)
            "^[A-G][0-9]$",  // musical note names (G4, C5, E5, G5)
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
        {
          // Inline import-type expressions hide cross-module type deps from
          // the AST refactor tool, knip, madge, and the layers/domains lints —
          // none of them walk TSImportType nodes. Use a top-level
          // `import type { Foo } from "./bar.ts"` declaration instead so the
          // dependency shows up in import graphs and is updated by rename-file.
          selector: "TSImportType",
          message:
            "Inline `import('...').Foo` type expressions are banned. Use a top-level `import type { Foo } from '...'` declaration so layer/domain lints, the refactor tool, and knip can see the dependency.",
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
