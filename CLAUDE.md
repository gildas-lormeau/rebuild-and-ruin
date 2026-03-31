# Rebuild & Ruin

Rampart multiplayer remake for the web, tournament-style. Vite + TypeScript, no framework.
Online multiplayer via Deno Deploy + WebSocket (checkpoint-based sync, host migration, watcher ticks).

## Commands

- Build: `npm run build` (runs `tsc --noEmit && vite build` — always use this, never `npx vite build` alone)
- Format: `npm run format` (biome on src/ and server/); `npm run format:check` for CI; 2-space indent
- Lint: `npm run lint:all` — format:check, biome, knip, madge, jscpd (min-lines 15), lint:literals (baseline-aware)
- Layer linter: `npx tsx scripts/generate-import-layers.ts --check --server`; use `/import-hygiene` skill for full audit
- Export index: `npm run export-search -- <term>` before writing new code; `npm run export-index` to regenerate
- Literals baseline: `.literals-baseline.json`; `--update-baseline` to refresh; `--all --files <globs>` for scoped reviews
- Pre-commit hook (.git/hooks/pre-commit, plain git): reorder, tsc, biome format, biome check, eslint, knip, madge, jscpd, layers, export-index, hot-exports, readonly-params
- Server: `deno task server` (port 8001); type-check with `deno check server/server.ts` (NOT tsc)
- Test: `bun test/headless.test.ts`, `bun test/determinism.test.ts`, `bun test/scenario.test.ts`, `bun test/online-*.test.ts`
- Debug: use `/debug-e2e` skill — spawns a sub-agent that adds logs, runs tests, reports root cause. Never guess at bugs.
- Refactor: `npm run refactor` — AST CLI (rename-symbol, move-export, rename-prop, rename-in-file)
- Skills live in `skills/` (not ~/.claude/skills/)

## Architecture

### Module layers (14 groups, `.import-layers.json`)
L0 leaf utils → L1 geometry → L2 core types & state → L3 shared interfaces & theme → L4 game logic → L5 AI strategy → L6 controllers → L7 input → L8 render → L9 game UI → L10 online infrastructure → L11 online logic → L12 runtime → L13 entry points (client & server). Imports must flow downward.

### Phase flow
CASTLE_SELECT → WALL_BUILD → CANNON_PLACE → BATTLE → loop (+ CASTLE_RESELECT when a player loses lives)

### Game rules (non-obvious, guide correctness)
- Territory: flood-fill from edges, interior = not-outside, not-wall
- Tower revival: delayed — enclosed dead tower marked pending at end of build, revived only if still enclosed at end of *next* build (towerPendingRevive set)
- Dead cannons persist as debris (block space), cleared only on zone reset
- Burning pits: grass tiles blocked for 3 battle rounds
- Wall sweep: batch collect-then-delete, one layer per call, twice per battle
- `claimTerritory()` for normal use, `claimTerritoryEndOfBuild()` adds scoring + tower revival; final grunt sweep fixes race condition
- Grunt movement: no retargeting after tower kill, pace back-and-forth when blocked by walls, stay put once adjacent to target tower
- Grunt distance: computed to nearest tile of 2x2 tower (not top-left corner)
- Zones fully isolated by rivers; no cross-zone interaction for grunts, walls, pieces (only cannonballs cross)

### Conventions
- File order: imports → types → constants → exported functions → private functions (enforced by pre-commit)
- Always check `.import-layers.json` before placing new code in a file
- Use `npx biome check --write <files>` for import sorting, never reorder manually
- Prefer spatial helpers (`isWater`, `isGrass`, `waterKeys`) over importing Tile enum directly
- Check existing helpers (`npm run export-search`) before inlining logic; create new helpers when a pattern appears 2+ times
