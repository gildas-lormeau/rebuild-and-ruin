/**
 * Shared player-facing configuration.
 *
 * Keep player names, colors, and bindings in one place so they cannot drift.
 */

import type {
  GameMode,
  PlayerSlotId,
  ValidPlayerSlot,
} from "./game-constants.ts";
import type { RGB } from "./geometry-types.ts";

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

export type SeedMode = typeof SEED_RANDOM | typeof SEED_CUSTOM;

export interface GameSettings {
  difficulty: number;
  rounds: number;
  cannonHp: number;
  haptics: number; // 0=off, 1=phase changes only, 2=all
  sound: number; // 0=off, 1=phase changes only, 2=all
  seed: string;
  seedMode: SeedMode;
  keyBindings: KeyBindings[];
  leftHanded: boolean; // true = d-pad on right, action buttons on left
  gameMode: GameMode;
}

export interface AutoResolveDeps {
  readonly hostAtFrameStart: boolean;
  readonly myPlayerId: PlayerSlotId;
  readonly remoteHumanSlots: ReadonlySet<number>;
  readonly isHumanController: (playerId: ValidPlayerSlot) => boolean;
}

export const KEY_UP = "ArrowUp";
export const KEY_DOWN = "ArrowDown";
export const KEY_LEFT = "ArrowLeft";
export const KEY_RIGHT = "ArrowRight";
export const KEY_ENTER = "Enter";
export const KEY_ESCAPE = "Escape";
export const DIFFICULTY_NORMAL = 1;
export const DIFFICULTY_PARAMS = [
  { buildTimer: 30, cannonPlaceTimer: 20, firstRoundCannons: 4 }, // DIFFICULTY_EASY
  { buildTimer: 25, cannonPlaceTimer: 15, firstRoundCannons: 3 }, // DIFFICULTY_NORMAL
  { buildTimer: 20, cannonPlaceTimer: 12, firstRoundCannons: 2 }, // DIFFICULTY_HARD
  { buildTimer: 15, cannonPlaceTimer: 10, firstRoundCannons: 1 }, // DIFFICULTY_VERY_HARD
];
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
    up: KEY_UP,
    down: KEY_DOWN,
    left: KEY_LEFT,
    right: KEY_RIGHT,
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
export const ACTION_KEYS: readonly (keyof KeyBindings)[] = [
  "up",
  "down",
  "left",
  "right",
  ACTION_CONFIRM,
  "rotate",
];
export const SEED_RANDOM = "random" as const;
export const SEED_CUSTOM = "custom" as const;
/** Maximum character length for user-entered seeds. */
export const MAX_SEED_LENGTH = 9;

/** Get player color with safe modulo wrapping. */
export function getPlayerColor(playerId: ValidPlayerSlot): PlayerColor {
  return PLAYER_COLORS[playerId % PLAYER_COLORS.length]!;
}

/** Apply a key rebinding with conflict resolution (swap conflicting key). */
export function applyKeyRebinding(
  kb: KeyBindings,
  actionKey: string,
  newKey: string,
): void {
  for (const otherAction of ACTION_KEYS) {
    if (otherAction === actionKey) continue;
    if (kb[otherAction as keyof KeyBindings] === newKey) {
      (kb as unknown as Record<string, string>)[otherAction] =
        kb[actionKey as keyof KeyBindings];
      break;
    }
  }
  (kb as unknown as Record<string, string>)[actionKey] = newKey;
}

/** Format a key binding as a short hint string (e.g. "Arrows + N (B rotate)"). */
export function formatKeyHint(kb: KeyBindings): string {
  const arrows =
    kb.up === KEY_UP
      ? "Arrows"
      : kb.up.toUpperCase() +
        kb.left.toUpperCase() +
        kb.down.toUpperCase() +
        kb.right.toUpperCase();
  return `${arrows} + ${kb.confirm.toUpperCase()} (${kb.rotate.toUpperCase()} rotate)`;
}

/** Build a map from confirm key → player slot index for lobby joining. */
export function createLobbyConfirmKeys(
  keyBindings: readonly KeyBindings[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < keyBindings.length; i++) {
    const kb = keyBindings[i]!;
    map.set(kb.confirm, i);
    map.set(kb.confirm.toUpperCase(), i);
  }
  return map;
}

/** True when this player's dialog entry should auto-resolve (no local input needed).
 *  Host checks controller identity; non-host only resolves its own slot. */
export function shouldAutoResolve(
  playerId: ValidPlayerSlot,
  deps: AutoResolveDeps,
): boolean {
  return deps.hostAtFrameStart
    ? !deps.isHumanController(playerId) && !deps.remoteHumanSlots.has(playerId)
    : playerId !== deps.myPlayerId;
}

if (
  PLAYER_COLORS.length !== PLAYER_NAMES.length ||
  PLAYER_KEY_BINDINGS.length !== PLAYER_NAMES.length
) {
  throw new Error(
    "PLAYER_NAMES / PLAYER_COLORS / PLAYER_KEY_BINDINGS must have the same length",
  );
}
