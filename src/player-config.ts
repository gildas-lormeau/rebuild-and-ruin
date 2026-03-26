/**
 * Shared player-facing configuration.
 *
 * Keep player names, colors, and bindings in one place so they cannot drift.
 */

import type { RGB } from "./geometry-types.ts";

export type { RGB };

export interface KeyBindings {
  up: string;
  down: string;
  left: string;
  right: string;
  confirm: string; // place / fire / select
  rotate: string; // rotate piece / cycle cannon mode / accelerate crosshair
}

interface PlayerColor {
  wall: RGB;
  interiorLight: RGB;
  interiorDark: RGB;
}

export const PLAYER_NAMES = ["Red", "Blue", "Gold"] as const;
// Player castle colors: wall and interior (checkerboard light/dark)
export const PLAYER_COLORS: readonly PlayerColor[] = [
  {
    wall: [150, 110, 110],
    interiorLight: [170, 30, 30],
    interiorDark: [50, 10, 10],
  }, // Red (stone-tinted)
  {
    wall: [100, 105, 140],
    interiorLight: [30, 50, 170],
    interiorDark: [10, 15, 50],
  }, // Blue (stone-tinted)
  {
    wall: [170, 145, 90],
    interiorLight: [190, 130, 20],
    interiorDark: [55, 40, 10],
  }, // Orange/Gold (stone-tinted)
];
export const PLAYER_KEY_BINDINGS: readonly KeyBindings[] = [
  {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    confirm: "n",
    rotate: "b",
  },
  {
    up: "w",
    down: "s",
    left: "a",
    right: "d",
    confirm: "f",
    rotate: "e",
  },
  {
    up: "i",
    down: "k",
    left: "j",
    right: "l",
    confirm: "h",
    rotate: "u",
  },
];
export const MAX_PLAYERS = PLAYER_NAMES.length;
/** Ordered action keys for the controls screen (matches KeyBindings fields). */
export const ACTION_CONFIRM = "confirm" as const;
export const ACTION_KEYS: readonly (keyof KeyBindings)[] = ["up", "down", "left", "right", ACTION_CONFIRM, "rotate"];

/** Get player color with safe modulo wrapping. */
export function getPlayerColor(playerId: number): PlayerColor {
  return PLAYER_COLORS[playerId % PLAYER_COLORS.length]!;
}

if (
  PLAYER_COLORS.length !== PLAYER_NAMES.length ||
  PLAYER_KEY_BINDINGS.length !== PLAYER_NAMES.length
) {
  throw new Error("PLAYER_NAMES / PLAYER_COLORS / PLAYER_KEY_BINDINGS must have the same length");
}
