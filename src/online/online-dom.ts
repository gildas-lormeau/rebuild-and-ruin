/**
 * Centralized DOM element acquisition for the online runtime.
 *
 * Every getElementById call for the online client lives here so that:
 * - DOM access is a single, explicit boundary (not scattered across modules)
 * - Duplicate lookups are eliminated (create-error, join-error were in two files)
 * - Other online modules receive typed element references, not raw DOM queries
 *
 * No project imports — this file is a pure DOM boundary.
 */

// ── Game elements ──────────────────────────────────────────────────

export const canvas = document.getElementById("canvas") as HTMLCanvasElement;
export const worldCanvas = document.getElementById(
  "world-canvas",
) as HTMLCanvasElement;
export const roomCodeOverlay = document.getElementById("room-code-overlay")!;
export const pageOnline = document.getElementById("page-online")!;
// ── Lobby elements ─────────────────────────────────────────────────
export const btnCreateConfirm = document.getElementById("btn-create-confirm")!;
export const btnJoinConfirm = document.getElementById("btn-join-confirm")!;
export const createRounds = document.getElementById(
  "create-rounds",
) as HTMLSelectElement;
export const createHp = document.getElementById(
  "create-hp",
) as HTMLSelectElement;
export const createWait = document.getElementById(
  "create-wait",
) as HTMLSelectElement;
export const createGameMode = document.getElementById(
  "create-game-mode",
) as HTMLSelectElement;
export const createSeed = document.getElementById(
  "create-seed",
) as HTMLInputElement;
export const joinCodeInput = document.getElementById(
  "join-code",
) as HTMLInputElement;
// ── Shared (used by both lobby and deps) ───────────────────────────
export const createError = document.getElementById("create-error")!;
export const joinError = document.getElementById("join-error")!;
