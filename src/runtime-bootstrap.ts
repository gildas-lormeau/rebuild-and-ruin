import { createController } from "./controller-factory.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import { GAME_MODE_CLASSIC, GAME_MODE_MODERN } from "./game-constants.ts";
import { createGameFromSeed } from "./game-engine.ts";
import type { GameMap } from "./geometry-types.ts";
import { generateMap } from "./map-generation.ts";
import type { KeyBindings } from "./player-config.ts";
import { precomputeTerrainCache } from "./render-map.ts";
import { GOLD, PANEL_BG } from "./render-theme.ts";
import { MAX_UINT32 } from "./rng.ts";
import { GAME_CONTAINER_ACTIVE } from "./router.ts";
import {
  type GameState,
  isReselectPhase,
  type LobbyState,
  Phase,
  type SelectionState,
} from "./types.ts";

export { createCanvasRenderer } from "./render-canvas.ts";
export { loadAtlas } from "./render-sprites.ts";

interface InitWaitingRoomDeps {
  code: string;
  seed: number;
  lobbyEl: HTMLElement;
  container: HTMLElement;
  roomCodeOverlay: HTMLElement;
  lobby: LobbyState;
  maxPlayers: number;
  now: () => number;
  setLobbyStartTime: (timeMs: number) => void;
  setModeLobby: () => void;
  setLastTime: (timeMs: number) => void;
  requestFrame: () => void;
}

interface EnterTowerSelectionDeps {
  state: GameState;
  isHost: boolean;
  myPlayerId: number;
  remoteHumanSlots: ReadonlySet<number>;
  controllers: PlayerController[];
  selectionStates: Map<number, SelectionState>;
  initTowerSelection: (playerId: number, zone: number) => void;
  syncSelectionOverlay: () => void;
  setOverlaySelection: () => void;
  selectTimer: number;
  accum: { select: number };
  enterCastleReselectPhase: (state: GameState) => void;
  now: () => number;
  setModeSelection: () => void;
  setLastTime: (timeMs: number) => void;
  requestFrame: () => void;
  log: (msg: string) => void;
}

interface InitGameDeps {
  seed: number;
  maxPlayers: number;
  /** Reuse an existing map (e.g. from lobby) to avoid regeneration and keep terrain cache warm. */
  existingMap?: GameMap;
  /** Game settings to apply after state creation. */
  battleLength: number;
  cannonMaxHp: number;
  buildTimer: number;
  cannonPlaceTimer: number;
  firstRoundCannons: number;
  /** Game mode: "classic" or "modern". */
  gameMode: string;
  /** Which slots are human (true = human, false/missing = AI). */
  humanSlots: readonly boolean[];
  /** Per-slot key bindings (only used for human slots). */
  keyBindings: readonly (KeyBindings | undefined)[];
  /** AI difficulty level (0=Easy, 1=Normal, 2=Hard, 3=Very Hard). */
  difficulty?: number;
  log: (msg: string) => void;
  clearFrameData: () => void;
  setState: (nextState: GameState) => void;
  setControllers: (nextControllers: readonly PlayerController[]) => void;
  resetUIState: () => void;
  /** Called after state + controllers are ready. Enters tower selection. */
  enterSelection: () => void;
}

export function initWaitingRoom(deps: InitWaitingRoomDeps): void {
  const {
    code,
    seed,
    lobbyEl,
    container,
    roomCodeOverlay,
    lobby,
    maxPlayers,
    now,
    setLobbyStartTime,
    setModeLobby,
    setLastTime,
    requestFrame,
  } = deps;

  lobbyEl.hidden = true;
  container.classList.add(GAME_CONTAINER_ACTIVE);

  roomCodeOverlay.style.display = "block";
  roomCodeOverlay.innerHTML = "";
  const joinUrl = `${location.origin}${location.pathname}?server=${location.host}&join=${code}`;
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(joinUrl)}`;
  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, {
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    background: PANEL_BG(0.9),
    padding: "12px 24px",
    borderRadius: "6px",
    border: `2px solid ${GOLD}`,
    color: GOLD,
    fontSize: "24px",
    letterSpacing: "6px",
    fontWeight: "bold",
    zIndex: "10",
    textAlign: "center",
  });
  wrapper.textContent = code;
  const qr = document.createElement("img");
  qr.src = qrSrc;
  qr.alt = "QR";
  Object.assign(qr.style, {
    display: "block",
    margin: "8px auto 0",
    width: "120px",
    height: "120px",
    imageRendering: "pixelated",
    borderRadius: "4px",
  });
  qr.addEventListener("error", () => {
    qr.style.display = "none";
  });
  wrapper.appendChild(qr);
  roomCodeOverlay.appendChild(wrapper);

  lobby.seed = seed;
  console.log("[online] seed:", seed);
  lobby.map = generateMap(seed);
  precomputeTerrainCache(lobby.map);
  lobby.joined = new Array(maxPlayers).fill(false);
  lobby.active = true;
  const time = now();
  setLobbyStartTime(time);
  setModeLobby();
  setLastTime(time);
  requestFrame();
}

export function enterTowerSelection(deps: EnterTowerSelectionDeps): void {
  const {
    state,
    isHost,
    myPlayerId,
    remoteHumanSlots,
    controllers,
    selectionStates,
    initTowerSelection,
    syncSelectionOverlay,
    setOverlaySelection,
    selectTimer,
    accum,
    enterCastleReselectPhase,
    now,
    setModeSelection,
    setLastTime,
    requestFrame,
    log,
  } = deps;

  log(
    `enterTowerSelection (phase=${Phase[state.phase]}, round=${state.round})`,
  );

  if (!isHost && myPlayerId < 0) {
    selectionStates.clear();
    for (let i = 0; i < state.players.length; i++) {
      initTowerSelection(i, state.playerZones[i]!);
    }
    setOverlaySelection();
    syncSelectionOverlay();
    accum.select = 0;
    state.timer = selectTimer;
    setModeSelection();
    setLastTime(now());
    requestFrame();
    return;
  }

  if (!isHost && myPlayerId >= 0) {
    const needsCastleReselect = state.phase !== Phase.CASTLE_SELECT;
    if (needsCastleReselect && !isReselectPhase(state.phase)) {
      enterCastleReselectPhase(state);
    }
    selectionStates.clear();
    for (let i = 0; i < state.players.length; i++) {
      const zone = state.playerZones[i]!;
      if (i === myPlayerId) {
        controllers[i]!.selectTower(state, zone);
      }
      initTowerSelection(i, zone);
    }
    setOverlaySelection();
    syncSelectionOverlay();
    accum.select = 0;
    state.timer = selectTimer;
    setModeSelection();
    setLastTime(now());
    requestFrame();
    return;
  }

  const zones = state.playerZones;

  selectionStates.clear();
  for (let i = 0; i < state.players.length; i++) {
    if (remoteHumanSlots.has(i)) continue;
    controllers[i]!.selectTower(state, zones[i]!);
    initTowerSelection(i, zones[i]!);
  }
  for (const pid of remoteHumanSlots) {
    initTowerSelection(pid, zones[pid]!);
  }

  setOverlaySelection();
  syncSelectionOverlay();
  accum.select = 0;
  state.timer = selectTimer;
  setModeSelection();
  setLastTime(now());
  requestFrame();
}

/** Create an AI-only controller (no key bindings). Used during host promotion
 *  to rebuild controllers for vacant slots. */
export function createAiController(
  id: number,
  seed: number,
  difficulty?: number,
): PlayerController {
  return createController(id, true, undefined, seed, difficulty);
}

/** Shared game init — used by both local startGame and online initFromServer.
 *  Generates map from seed, creates state, creates controllers, enters selection. */
export function bootstrapGame(deps: InitGameDeps): void {
  deps.resetUIState();
  deps.clearFrameData();

  const { state, playerCount } = createGameFromSeed(
    deps.seed,
    deps.maxPlayers,
    deps.existingMap,
  );
  state.battleLength = deps.battleLength > 0 ? deps.battleLength : Infinity;
  state.cannonMaxHp = deps.cannonMaxHp;
  state.buildTimer = deps.buildTimer;
  state.cannonPlaceTimer = deps.cannonPlaceTimer;
  state.firstRoundCannons = deps.firstRoundCannons;
  state.gameMode =
    deps.gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC;

  deps.log(
    `initGame: ${playerCount} players, seed=${deps.seed}, battleLength=${state.battleLength}`,
  );

  const nextControllers: PlayerController[] = [];
  for (let i = 0; i < playerCount; i++) {
    const isAi = !deps.humanSlots[i];
    const strategySeed = isAi ? state.rng.int(0, MAX_UINT32) : undefined;
    nextControllers.push(
      createController(
        i,
        isAi,
        deps.keyBindings[i],
        strategySeed,
        isAi ? deps.difficulty : undefined,
      ),
    );
  }

  deps.setState(state);
  deps.setControllers(nextControllers);
  deps.enterSelection();
}
