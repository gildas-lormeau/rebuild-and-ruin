import type { PlayerController } from "./controller-interfaces.ts";
import { createGameFromSeed } from "./game-engine.ts";
import { GAME_CONTAINER_ACTIVE, type LobbyState } from "./game-ui-types.ts";
import { generateMap } from "./map-generation.ts";
import { GOLD, PANEL_BG } from "./render-theme.ts";
import type { SelectionState } from "./selection.ts";
import { type GameState, isReselectPhase, Phase } from "./types.ts";

interface InitWaitingRoomDeps {
  code: string;
  seed: number;
  lobbyEl: HTMLElement;
  canvas: HTMLCanvasElement;
  roomCodeOverlay: HTMLElement;
  lobby: LobbyState;
  maxPlayers: number;
  now: () => number;
  setLobbyStartTime: (timeMs: number) => void;
  setModeLobby: () => void;
  setLastTime: (timeMs: number) => void;
  requestFrame: () => void;
}

interface InitTowerSelectionDeps {
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
  /** Game settings to apply after state creation. */
  battleLength: number;
  cannonMaxHp: number;
  buildTimer: number;
  cannonPlaceTimer: number;
  log: (msg: string) => void;
  resetFrame: () => void;
  setState: (nextState: GameState) => void;
  setControllers: (nextControllers: readonly PlayerController[]) => void;
  resetUIState: () => void;
  /** Create a controller for slot `i`. Receives the state for RNG access. */
  createControllerForSlot: (i: number, state: GameState) => PlayerController;
  /** Called after state + controllers are ready. Enters tower selection. */
  enterSelection: () => void;
}

export function initWaitingRoom(deps: InitWaitingRoomDeps): void {
  const {
    code,
    seed,
    lobbyEl,
    canvas,
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
  canvas.parentElement!.classList.add(GAME_CONTAINER_ACTIVE);

  roomCodeOverlay.style.display = "block";
  roomCodeOverlay.innerHTML = "";
  const joinUrl = `${location.origin}${location.pathname}?server=${location.host}&join=${code}`;
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(joinUrl)}`;
  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, {
    position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)",
    background: PANEL_BG(0.9), padding: "12px 24px", borderRadius: "6px",
    border: `2px solid ${GOLD}`, color: GOLD, fontSize: "24px", letterSpacing: "6px",
    fontWeight: "bold", zIndex: "10", textAlign: "center",
  });
  wrapper.textContent = code;
  const qr = document.createElement("img");
  qr.src = qrSrc;
  qr.alt = "QR";
  Object.assign(qr.style, {
    display: "block", margin: "8px auto 0", width: "120px", height: "120px",
    imageRendering: "pixelated", borderRadius: "4px",
  });
  qr.addEventListener("error", () => { qr.style.display = "none"; });
  wrapper.appendChild(qr);
  roomCodeOverlay.appendChild(wrapper);

  lobby.seed = seed;
  lobby.map = generateMap(seed);
  lobby.joined = new Array(maxPlayers).fill(false);
  lobby.active = true;
  const time = now();
  setLobbyStartTime(time);
  setModeLobby();
  setLastTime(time);
  requestFrame();
}

export function initTowerSelection(
  deps: InitTowerSelectionDeps,
): void {
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

/** Shared game init — used by both local startGame and online initFromServer.
 *  Generates map from seed, creates state, creates controllers, enters selection. */
export function bootstrapGame(deps: InitGameDeps): void {
  deps.resetUIState();
  deps.resetFrame();

  const { state, playerCount } = createGameFromSeed(deps.seed, deps.maxPlayers);
  state.battleLength = deps.battleLength > 0 ? deps.battleLength : Infinity;
  state.cannonMaxHp = deps.cannonMaxHp;
  state.buildTimer = deps.buildTimer;
  state.cannonPlaceTimer = deps.cannonPlaceTimer;

  deps.log(`initGame: ${playerCount} players, seed=${deps.seed}, battleLength=${state.battleLength}`);

  const nextControllers: PlayerController[] = [];
  for (let i = 0; i < playerCount; i++) {
    nextControllers.push(deps.createControllerForSlot(i, state));
  }

  deps.setState(state);
  deps.setControllers(nextControllers);
  deps.enterSelection();
}
