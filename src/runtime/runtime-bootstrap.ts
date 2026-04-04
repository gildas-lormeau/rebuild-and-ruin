import { createGameFromSeed } from "../game/game-engine.ts";
import { generateMap } from "../game/map-generation.ts";
import { createController } from "../player/controller-factory.ts";
import type { PlayerController } from "../shared/controller-interfaces.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
} from "../shared/game-constants.ts";
import { isReselectPhase, Phase } from "../shared/game-phase.ts";
import type { GameMap } from "../shared/geometry-types.ts";
import type { KeyBindings } from "../shared/player-config.ts";
import {
  isActivePlayer,
  type PlayerSlotId,
  type ValidPlayerSlot,
} from "../shared/player-slot.ts";
import { MAX_UINT32 } from "../shared/rng.ts";
import { GAME_CONTAINER_ACTIVE } from "../shared/router.ts";
import { GOLD, PANEL_BG } from "../shared/theme.ts";
import { isRemoteHuman } from "../shared/tick-context.ts";
import {
  type GameState,
  type LobbyState,
  type SelectionState,
  setGameMode,
} from "../shared/types.ts";

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
  myPlayerId: PlayerSlotId;
  remoteHumanSlots: ReadonlySet<number>;
  controllers: PlayerController[];
  selectionStates: Map<number, SelectionState>;
  initTowerSelection: (playerId: ValidPlayerSlot, zone: number) => void;
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
  maxRounds: number;
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

  const isWatcher = !isHost && !isActivePlayer(myPlayerId);

  // Non-host active player joining mid-game needs reselect phase
  if (!isHost && isActivePlayer(myPlayerId)) {
    const needsCastleReselect = state.phase !== Phase.CASTLE_SELECT;
    if (needsCastleReselect && !isReselectPhase(state.phase)) {
      enterCastleReselectPhase(state);
    }
  }

  // Determine which players need selectInitialTower:
  //   Watcher: nobody — just observing
  //   Non-host player: only myPlayerId — remote players handled by host
  //   Host: all non-remote-humans — host drives AI + local player
  const shouldSelect = (pid: ValidPlayerSlot): boolean => {
    if (isWatcher) return false;
    if (!isHost) return pid === myPlayerId;
    return !isRemoteHuman(pid, remoteHumanSlots);
  };

  selectionStates.clear();
  for (let i = 0; i < state.players.length; i++) {
    const pid = i as ValidPlayerSlot;
    const zone = state.playerZones[i]!;
    if (shouldSelect(pid)) {
      controllers[i]!.selectInitialTower(state, zone);
    }
    initTowerSelection(pid, zone);
  }

  setOverlaySelection();
  syncSelectionOverlay();
  accum.select = 0;
  state.timer = selectTimer;
  setModeSelection();
  setLastTime(now());
  requestFrame();
}

/** Create an AI-only controller (no key bindings). Used during initial game
 *  setup and host promotion to rebuild controllers for vacant slots. */
export function createAiController(
  id: ValidPlayerSlot,
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
  state.maxRounds = deps.maxRounds > 0 ? deps.maxRounds : Infinity;
  state.cannonMaxHp = deps.cannonMaxHp;
  state.buildTimer = deps.buildTimer;
  state.cannonPlaceTimer = deps.cannonPlaceTimer;
  state.firstRoundCannons = deps.firstRoundCannons;
  setGameMode(
    state,
    deps.gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
  );

  deps.log(
    `initGame: ${playerCount} players, seed=${deps.seed}, maxRounds=${state.maxRounds}`,
  );

  const nextControllers: PlayerController[] = [];
  for (let i = 0; i < playerCount; i++) {
    const isAi = !deps.humanSlots[i];
    const strategySeed = isAi ? state.rng.int(0, MAX_UINT32) : undefined;
    nextControllers.push(
      createController(
        i as ValidPlayerSlot,
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
