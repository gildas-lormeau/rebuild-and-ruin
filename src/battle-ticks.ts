import type { GameMessage } from "../server/protocol.ts";
import { countdownAnnouncement } from "./battle-system.ts";
import { snapshotAllWalls } from "./board-occupancy.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import type { TilePos } from "./geometry-types.ts";
import { buildCannonFiredMsg } from "./online-send-actions.ts";
import type { WatcherTimingState } from "./online-types.ts";
import { BANNER_BATTLE, BANNER_BATTLE_SUB, type BannerShow } from "./phase-banner.ts";
import { getRemoteSlots, type HostNetContext, localActiveControllers } from "./tick-context.ts";
import type { BalloonFlight, BattleAnimState, GameState, Impact } from "./types.ts";

interface TickHostBattleCountdownDeps {
  dt: number;
  state: GameState;
  frame: { announcement?: string };
  controllers: PlayerController[];
  syncCrosshairs: (canFireNow: boolean, dt: number) => void;
  render: () => void;
  net?: Pick<HostNetContext, "remoteHumanSlots">;
}

/** Networking context for the battle phase. */
interface BattlePhaseNet extends HostNetContext {
  sendMessage: (msg: GameMessage) => void;
}

interface TickHostBattlePhaseDeps {
  dt: number;
  state: GameState;
  battleTimer: number;
  accum: { battle: number };
  controllers: PlayerController[];
  battleAnim: { impacts: Impact[] };
  render: () => void;
  syncCrosshairs: (canFireNow: boolean, dt: number) => void;
  collectTowerEvents: (
    state: GameState,
    dt: number,
  ) => Array<GameMessage>;
  tickCannonballsWithEvents: (
    state: GameState,
    dt: number,
  ) => {
    impacts: TilePos[];
    events: Array<GameMessage>;
  };
  onBattlePhaseEnded: () => void;
  onBattleEvents?: (events: ReadonlyArray<GameMessage>) => void;
  net?: BattlePhaseNet;
}

/** Networking context for starting battle. */
interface BattleStartNet {
  isHost: boolean;
  sendBattleStart: (flights: readonly BalloonFlight[]) => void;
}

interface StartHostBattleLifecycleDeps {
  state: GameState;
  battleAnim: BattleAnimState;
  resolveBalloons: (state: GameState) => BalloonFlight[];
  snapshotTerritory: () => Set<number>[];
  showBanner: BannerShow;
  nextPhase: (state: GameState) => void;
  setModeBalloonAnim: () => void;
  beginBattle: () => void;
  net?: BattleStartNet;
}

interface TickHostBalloonAnimDeps {
  dt: number;
  balloonFlightDuration: number;
  battleAnim: BattleAnimState;
  render: () => void;
  beginBattle: () => void;
}

/** Networking context for beginning battle. */
interface BattleBeginNet extends HostNetContext {
  watcherTiming: WatcherTimingState;
  now: () => number;
}

interface BeginHostBattleDeps {
  state: GameState;
  controllers: PlayerController[];
  accum: { battle: number };
  battleCountdown: number;
  setModeGame: () => void;
  net?: BattleBeginNet;
}

export function tickHostBattleCountdown(
  deps: TickHostBattleCountdownDeps,
): void {
  const { dt, state, frame, controllers, syncCrosshairs, render } = deps;
  const remoteHumanSlots = getRemoteSlots(deps.net);

  state.battleCountdown = Math.max(0, state.battleCountdown - dt);
  for (const ctrl of localActiveControllers(controllers, remoteHumanSlots, state)) {
    ctrl.battleTick(state, dt);
  }

  frame.announcement = countdownAnnouncement(state.battleCountdown);

  syncCrosshairs(false, dt);
  render();
}

export function tickHostBattlePhase(deps: TickHostBattlePhaseDeps): boolean {
  const {
    dt, state, battleTimer, accum, controllers, battleAnim,
    render, syncCrosshairs, collectTowerEvents, tickCannonballsWithEvents,
    onBattlePhaseEnded, onBattleEvents,
  } = deps;
  const remoteHumanSlots = getRemoteSlots(deps.net);
  const isHost = deps.net?.isHost ?? true;
  const sendMessage = deps.net?.sendMessage;

  accum.battle += dt;
  state.timer = Math.max(0, battleTimer - accum.battle);

  const ballsBefore = state.cannonballs.length;
  for (const ctrl of localActiveControllers(controllers, remoteHumanSlots, state)) {
    ctrl.battleTick(state, dt);
  }

  if (isHost && sendMessage) {
    for (let i = ballsBefore; i < state.cannonballs.length; i++) {
      sendMessage(buildCannonFiredMsg(state.cannonballs[i]!));
    }
  }

  const towerEvents = collectTowerEvents(state, dt);
  if (isHost && sendMessage) {
    for (const evt of towerEvents) sendMessage(evt);
  }

  const { impacts: newImpacts, events: impactEvents } =
    tickCannonballsWithEvents(state, dt);
  for (const imp of newImpacts) {
    battleAnim.impacts.push({ ...imp, age: 0 });
  }
  if (sendMessage) {
    for (const evt of impactEvents) sendMessage(evt);
  }

  // Haptic feedback for battle events
  if (onBattleEvents) {
    const allEvents = [...towerEvents, ...impactEvents];
    if (allEvents.length > 0) onBattleEvents(allEvents);
  }

  syncCrosshairs(true, dt);
  render();

  if (state.timer > 0 || state.cannonballs.length > 0) return false;

  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    ctrl.onBattleEnd();
  }
  onBattlePhaseEnded();
  return true;
}

export function startHostBattleLifecycle(
  deps: StartHostBattleLifecycleDeps,
): void {
  const {
    state, battleAnim, resolveBalloons, snapshotTerritory,
    showBanner, nextPhase, setModeBalloonAnim, beginBattle,
  } = deps;
  const isHost = deps.net?.isHost ?? true;
  const sendBattleStart = deps.net?.sendBattleStart;

  const flights = resolveBalloons(state);
  const preTerritory = snapshotTerritory();
  const preWalls = snapshotAllWalls(state);

  showBanner(
    BANNER_BATTLE,
    () => {
      if (flights.length > 0) {
        battleAnim.flights = flights.map((f) => ({ flight: f, progress: 0 }));
        setModeBalloonAnim();
      } else {
        beginBattle();
      }
    },
    true,
    { territory: preTerritory, walls: preWalls },
    BANNER_BATTLE_SUB,
  );

  nextPhase(state);
  battleAnim.impacts = [];
  if (isHost && sendBattleStart) sendBattleStart(flights);

  battleAnim.territory = snapshotTerritory();
  battleAnim.walls = snapshotAllWalls(state);
}

export function tickHostBalloonAnim(deps: TickHostBalloonAnimDeps): void {
  const { dt, balloonFlightDuration, battleAnim, render, beginBattle } = deps;
  let allDone = true;
  for (const b of battleAnim.flights) {
    b.progress = Math.min(1, b.progress + dt / balloonFlightDuration);
    if (b.progress < 1) allDone = false;
  }

  render();

  if (allDone) {
    battleAnim.flights = [];
    beginBattle();
  }
}

export function beginHostBattle(deps: BeginHostBattleDeps): void {
  const { state, controllers, accum, battleCountdown, setModeGame } = deps;
  const remoteHumanSlots = getRemoteSlots(deps.net);
  const isHost = deps.net?.isHost ?? true;

  for (const ctrl of localActiveControllers(controllers, remoteHumanSlots, state)) {
    ctrl.resetBattle(state);
  }

  state.battleCountdown = battleCountdown;
  accum.battle = 0;
  if (!isHost && deps.net) {
    const { watcherTiming, now } = deps.net;
    watcherTiming.countdownStartTime = now();
    watcherTiming.countdownDuration = battleCountdown;
  }

  setModeGame();
}
