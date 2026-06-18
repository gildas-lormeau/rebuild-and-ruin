/**
 * UI contracts — overlay/screen factories, hit-test types, touch component
 * handle interfaces, and input-handler registration signatures. The
 * cross-cutting types that runtime/, render/, and input/ all need to agree
 * on. Per-component deps live in shared/ui/input-deps.ts; banner callback
 * types live in banner-state.ts.
 */

import type {
  BalloonFlight,
  CannonDestroy,
  Crosshair,
  DestroyedWall,
  GruntKill,
  HouseDestroy,
  Impact,
  ShieldFlash,
  ThawingTile,
} from "../shared/core/battle-types.ts";
import type {
  LifeLostDialogState,
  UpgradePickDialogState,
} from "../shared/core/dialog-state.ts";
import type { BannerKind } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { GameMap } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import type { GameState, LobbyState } from "../shared/core/types.ts";
import type { SceneCapture } from "../shared/ui/banner-content.ts";
import type {
  DpadDeps,
  FloatingActionsDeps,
  FloatingActionsHandle,
  PointerMoveDeps,
  QuitButtonDeps,
  RegisterOnlineInputDeps,
  ZoomButtonDeps,
} from "../shared/ui/input-deps.ts";
import type {
  ControlsState,
  OptionsContext,
} from "../shared/ui/interaction-types.ts";
import type {
  BannerUi,
  GameOverOverlay,
  RenderOverlay,
} from "../shared/ui/overlay-types.ts";
import type { GameSettings } from "../shared/ui/player-config.ts";
import type { RGB } from "../shared/ui/theme.ts";
import type { Mode } from "../shared/ui/ui-mode.ts";
import type { RevealOverlayBattleFields } from "./modifier-effects/registry.ts";

export interface UIContext {
  getState: () => GameState | undefined;
  settings: GameSettings;
  getMode: () => Mode;
  /** Raw field write — assigns runtimeState.mode. Callers (showOptions, closeOptions, etc.)
   *  are responsible for any state-machine side effects around the transition. */
  setMode: (mode: Mode) => void;
  getPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  optionsCursor: { value: number };
  controlsState: ControlsState;
  getOptionsContext: () => OptionsContext;
  setOptionsContext: (context: OptionsContext) => void;
  lobby: LobbyState;
  getFrame: () => { announcement?: string };
  getLobbyRemaining: () => number;
  isOnline: boolean;
  /** True when all player-supplied Rampart sound files are in IndexedDB, so the
   *  "Sound" row in the options screen can render status at a glance. */
  getSoundReady: () => boolean;
}

export type CreateOptionsOverlayFn = (ctx: UIContext) => {
  map: GameMap;
  overlay: RenderOverlay;
};

export type CreateControlsOverlayFn = (ctx: UIContext) => {
  map: GameMap;
  overlay: RenderOverlay;
};

export type CreateLobbyOverlayFn = (ctx: UIContext) => {
  map: GameMap;
  overlay: RenderOverlay;
};

export type VisibleOptionsFn = (ctx: UIContext) => number[];

export type OptionsScreenHitTestFn = (
  x: number,
  y: number,
  W: number,
  H: number,
  optionCount: number,
) => OptionsHit;

export type ControlsScreenHitTestFn = (
  x: number,
  y: number,
  W: number,
  H: number,
  colCount: number,
  rowCount: number,
) => ControlsHit;

/** Hit-test result for a tap/click on the options screen. */
export type OptionsHit =
  | { type: "close" }
  | { type: "row"; index: number }
  | { type: "arrow"; index: number; dir: -1 | 1 }
  | null;

/** Hit-test result for a tap/click on the controls screen. */
export type ControlsHit =
  | { type: "close" }
  | { type: "cell"; playerIdx: ValidPlayerId; actionIdx: number }
  | null;

export type CreateBannerUiFn = (
  active: boolean,
  kind: BannerKind,
  text: string,
  progress: number,
  subtitle?: string,
  paletteKey?: string,
  prevScene?: SceneCapture,
  newScene?: SceneCapture,
) => BannerUi | undefined;

export type ComputeLobbyLayoutFn = (
  W: number,
  H: number,
  count: number,
) => { gap: number; rectW: number; rectH: number; rectY: number };

export type LobbyClickHitTestFn = (params: {
  canvasX: number;
  canvasY: number;
  canvasW: number;
  canvasH: number;
  tileSize: number;
  slotCount: number;
  computeLayout: (
    W: number,
    H: number,
    count: number,
  ) => { gap: number; rectW: number; rectH: number; rectY: number };
}) => LobbyHit | null;

/** Result of a lobby click hit-test. */
export type LobbyHit =
  | { type: "gear" }
  | { type: "slot"; slotId: ValidPlayerId };

export type CreateOnlineOverlayFn = (
  params: OnlineOverlayParams,
) => RenderOverlay;

/** Parameter object for createOnlineOverlay — extracted so consumers can import the type. */
export interface OnlineOverlayParams {
  previousSelection: RenderOverlay["selection"];
  view: RenderView;
  battleAnim: {
    territory: Set<TileKey>[];
    walls: Set<TileKey>[];
    flights: ReadonlyArray<{ flight: BalloonFlight; progress: number }>;
    impacts: Impact[];
    thawing: ThawingTile[];
    destroyedWalls: DestroyedWall[];
    cannonDestroys: CannonDestroy[];
    gruntKills: GruntKill[];
    houseDestroys: HouseDestroy[];
    shieldFlashes: ShieldFlash[];
  };
  frame: {
    crosshairs: Crosshair[];
    phantoms: RenderOverlay["phantoms"];
    announcement?: string;
    gameOver?: GameOverOverlay;
  };
  bannerUi?: BannerUi;
  lifeLostDialog: LifeLostDialogState | null;
  upgradePickDialog: UpgradePickDialogState | null;
  inBattle: boolean;
  /** True only during the balloon-flight overlay (Mode.BALLOON_ANIM). Gates
   *  the balloon render so flights don't show statically through the
   *  pre-battle tilt — they appear when the tilt settles and BALLOON_ANIM
   *  engages. The flights themselves are stashed earlier (cannon-place-done),
   *  so `flights.length` alone would render them too soon. */
  inBalloonAnim: boolean;
  povPlayerId: ValidPlayerId;
  hasPointerPlayer: boolean;
  upgradePickInteractiveSlots: ReadonlySet<ValidPlayerId>;
  playerNames: ReadonlyArray<string>;
  playerColors: ReadonlyArray<{ wall: RGB }>;
  getLifeLostPanelPos: (playerId: ValidPlayerId) => {
    px: number;
    py: number;
  };
  /** 2D-overlay scalars driven by the active modifier-reveal pulse — the
   *  per-modifier fields of `RevealOverlayBattleFields` (see its `Pick`
   *  in `modifier-effects/registry.ts` for the full list). Built by
   *  `deriveRevealOverlayFields` in `modifier-effects/registry.ts` from
   *  the single resolved `revealTimeMs` — bespoke per-modifier
   *  `revealTimeFor` plumbing does not live here. Spread into
   *  `overlay.battle`. */
  revealOverlayFields: RevealOverlayBattleFields;
}

export type DispatchPointerMoveFn = (
  x: number,
  y: number,
  state: GameState,
  deps: PointerMoveDeps,
) => void;

// Function type export — consumed as type-only import by runtime/
export type RegisterKeyboardHandlersFn = (
  deps: RegisterOnlineInputDeps,
) => void;

// Function type export — consumed as type-only import by runtime/
export type RegisterMouseHandlersFn = (deps: RegisterOnlineInputDeps) => void;

// Function type export — consumed as type-only import by runtime/
export type RegisterTouchHandlersFn = (deps: RegisterOnlineInputDeps) => void;

export type CreateDpadFn = (
  deps: DpadDeps,
  container: HTMLElement,
) => {
  update: (phase: Phase | null, disableRotate?: boolean) => void;
  setLeftHanded: (lh: boolean) => void;
  setConfirmValid: (valid: boolean) => void;
};

export type CreateZoneCycleButtonFn = (
  deps: ZoomButtonDeps,
  container: HTMLElement,
) => { update: (active: boolean) => void };

export type CreateFloatingActionsFn = (
  deps: FloatingActionsDeps,
  element: HTMLElement,
) => FloatingActionsHandle;

export type CreateQuitButtonFn = (
  deps: QuitButtonDeps,
  container: HTMLElement,
) => { update: (phase: Phase | null) => void };
