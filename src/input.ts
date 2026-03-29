/**
 * Shared input types.
 *
 * Pure type definitions consumed by mouse, keyboard, and touch input handlers.
 * No runtime code — avoids circular dependencies between handler modules.
 */

import type {
  InputReceiver,
  PlayerController,
} from "./controller-interfaces.ts";
import type { WorldPos } from "./geometry-types.ts";
import type { ModeValues } from "./input-dispatch.ts";
import type { KeyBindings, SeedMode } from "./player-config.ts";
import type { RendererInterface } from "./render-types.ts";
import type {
  ControlsState,
  GameOverFocus,
  GameState,
  LifeLostDialogState,
  ResolvedChoice,
  SelectionState,
} from "./types.ts";

export interface RegisterOnlineInputDeps {
  renderer: RendererInterface;
  getState: () => GameState | undefined;
  getMode: () => number;
  setMode: (mode: number) => void;
  modeValues: ModeValues;
  isLobbyActive: () => boolean;
  lobbyKeyJoin?: (key: string) => boolean;
  lobbyClick: (x: number, y: number) => boolean;
  showLobby: () => void;
  rematch: () => void;
  getGameOverFocused: () => GameOverFocus;
  setGameOverFocused: (f: GameOverFocus) => void;
  gameOverClick: (x: number, y: number) => void;
  showOptions: () => void;
  closeOptions: () => void;
  showControls: () => void;
  closeControls: () => void;
  getOptionsCursor: () => number;
  setOptionsCursor: (cursor: number) => void;
  getOptionsCount: () => number;
  getRealOptionIdx: () => number;
  getOptionsReturnMode: () => number | null;
  setOptionsReturnMode: (mode: number | null) => void;
  changeOption: (dir: number) => void;
  getControlsState: () => ControlsState;
  getLifeLostDialog: () => LifeLostDialogState | null;
  lifeLostDialogClick: (x: number, y: number) => void;
  getControllers: () => PlayerController[];
  isHuman: (ctrl: PlayerController) => ctrl is PlayerController & InputReceiver;
  withFirstHuman: (
    action: (human: PlayerController & InputReceiver) => void,
  ) => void;
  pixelToTile: (x: number, y: number) => { row: number; col: number };
  screenToWorld: (x: number, y: number) => WorldPos;
  onPinchStart?: (midX: number, midY: number) => void;
  onPinchUpdate?: (midX: number, midY: number, scale: number) => void;
  onPinchEnd?: () => void;
  maybeSendAimUpdate: (x: number, y: number) => void;
  tryPlaceCannonAndSend: (
    ctrl: PlayerController & InputReceiver,
    gameState: GameState,
    max: number,
  ) => boolean;
  tryPlacePieceAndSend: (
    ctrl: PlayerController & InputReceiver,
    gameState: GameState,
  ) => boolean;
  fireAndSend: (ctrl: PlayerController, gameState: GameState) => void;
  onPieceRotated?: () => void;
  getSelectionStates: () => Map<number, SelectionState>;
  highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
  confirmSelectionForPlayer: (pid: number, isReselect?: boolean) => boolean;
  /** True after the "Select your home castle" announcement has finished. */
  isSelectionReady?: () => boolean;
  isOnline?: boolean;
  togglePause: () => boolean;
  getQuitPending: () => boolean;
  setQuitPending: (value: boolean) => void;
  setQuitTimer: (seconds: number) => void;
  setQuitMessage: (text: string) => void;
  sendLifeLostChoice: (choice: ResolvedChoice, playerId: number) => void;
  /** Mark direct-touch-active state (shows floating buttons near phantom). */
  setDirectTouchActive?: (active: boolean) => void;
  /** True when floating buttons are active — suppresses canvas tap-to-place. */
  isDirectTouchActive?: () => boolean;
  settings: {
    keyBindings: KeyBindings[];
    seedMode: SeedMode;
    seed: string;
  };
}
