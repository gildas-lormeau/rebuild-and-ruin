/** Consumer registry for `OnlinePhaseTicks` hooks.
 *
 *  Each hook maps to the files that wire it. The `satisfies
 *  Record<keyof OnlinePhaseTicks, ...>` clause forces exhaustiveness:
 *  adding a new hook to the interface without an entry here is a compile
 *  error. `scripts/lint-registries.ts` then verifies every listed path
 *  exists on disk, so a renamed wiring file surfaces at pre-commit.
 *
 *  Roles are free-form documentation strings by convention:
 *    - "wire:prod"        → `src/online/online-runtime-game.ts`
 *    - "wire:test-host"   → host-side builder in `test/network-setup.ts`
 *    - "wire:test-watcher"→ watcher-side builder in `test/network-setup.ts`
 *    - "wire:test-stub"   → no-op stub in `test/runtime-headless.ts`
 *
 *  A hook doesn't need every role — only production (`wire:prod`) is
 *  effectively required (every hook is wired there today). Test fixtures
 *  opt in only when their scenario needs the behavior. */

import type { OnlinePhaseTicks } from "./runtime-types.ts";

export const ONLINE_PHASE_TICKS_CONSUMERS = {
  broadcastCannonStart: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  broadcastBattleStart: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  broadcastBuildStart: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  broadcastBuildEnd: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  broadcastLocalCrosshair: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  shouldSendCannonPhantom: {
    "wire:prod": "src/online/online-runtime-game.ts",
  },
  shouldSendPiecePhantom: {
    "wire:prod": "src/online/online-runtime-game.ts",
  },
  extendCrosshairs: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-watcher": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
  tickMigrationAnnouncement: {
    "wire:prod": "src/online/online-runtime-game.ts",
    "wire:test-host": "test/network-setup.ts",
    "wire:test-watcher": "test/network-setup.ts",
    "wire:test-stub": "test/runtime-headless.ts",
  },
} as const satisfies Record<
  keyof OnlinePhaseTicks,
  Readonly<Record<string, string>>
>;
