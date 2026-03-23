import { countdownAnnouncement, type BalloonFlight } from "./battle-system.ts";
import type { GameMessage } from "../server/protocol.ts";
import type { TilePos } from "./geometry-types.ts";
import type { PlayerController } from "./player-controller.ts";
import type { GameState, Impact } from "./types.ts";
import type { WatcherTimingState } from "./online-watcher-battle.ts";

/** Shared empty set — avoids allocating a throwaway Set on every frame. */
const EMPTY_SET: ReadonlySet<number> = new Set<number>();

// ---------------------------------------------------------------------------
// Host battle tick (countdown + main phase)
// ---------------------------------------------------------------------------

interface TickHostBattleCountdownDeps {
  // Core game deps (required)
  dt: number;
  state: GameState;
  frame: { announcement?: string };
  controllers: PlayerController[];
  collectCrosshairs: (canFireNow: boolean, dt: number) => void;
  render: () => void;

  // Networking hooks (optional, default to empty)
  remoteHumanSlots?: Set<number>;
}

export function tickHostBattleCountdown(
  deps: TickHostBattleCountdownDeps,
): void {
  const {
    dt,
    state,
    frame,
    controllers,
    collectCrosshairs,
    render,
    // Networking hooks with sensible defaults
    remoteHumanSlots = EMPTY_SET as Set<number>,
  } = deps;

  state.battleCountdown = Math.max(0, state.battleCountdown - dt);
  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    if (state.players[ctrl.playerId]?.eliminated) continue;
    ctrl.battleTick(state, dt);
  }

  frame.announcement = countdownAnnouncement(state.battleCountdown);

  collectCrosshairs(false, dt);
  render();
}

interface TickHostBattlePhaseDeps {
  // Core game deps (required)
  dt: number;
  state: GameState;
  battleTimer: number;
  accum: { battle: number };
  controllers: PlayerController[];
  battleAnim: { impacts: Impact[] };
  render: () => void;
  collectCrosshairs: (canFireNow: boolean, dt: number) => void;
  collectTowerEvents: (
    state: GameState,
    dt: number,
  ) => Array<GameMessage>;
  updateCannonballsWithEvents: (
    state: GameState,
    dt: number,
  ) => {
    impacts: TilePos[];
    events: Array<GameMessage>;
  };
  onBattlePhaseEnded: () => void;

  // Haptics (optional)
  onBattleEvents?: (events: Array<GameMessage>) => void;

  // Networking hooks (optional, default to no-op / empty)
  remoteHumanSlots?: Set<number>;
  isHost?: boolean;
  sendMessage?: (msg: GameMessage) => void;
}

export function tickHostBattlePhase(deps: TickHostBattlePhaseDeps): boolean {
  const {
    dt,
    state,
    battleTimer,
    accum,
    controllers,
    battleAnim,
    render,
    collectCrosshairs,
    collectTowerEvents,
    updateCannonballsWithEvents,
    onBattlePhaseEnded,
    // Haptics
    onBattleEvents,
    // Networking hooks with sensible defaults
    remoteHumanSlots = EMPTY_SET as Set<number>,
    isHost = true,
    sendMessage = () => {},
  } = deps;

  accum.battle += dt;
  state.timer = Math.max(0, battleTimer - accum.battle);

  const ballsBefore = state.cannonballs.length;
  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    if (state.players[ctrl.playerId]?.eliminated) continue;
    ctrl.battleTick(state, dt);
  }

  if (isHost) {
    for (let i = ballsBefore; i < state.cannonballs.length; i++) {
      const ball = state.cannonballs[i]!;
      sendMessage({
        type: "cannon_fired",
        playerId: ball.playerId,
        cannonIdx: ball.cannonIdx,
        startX: ball.startX,
        startY: ball.startY,
        targetX: ball.targetX,
        targetY: ball.targetY,
        speed: ball.speed,
        incendiary: ball.incendiary || undefined,
      });
    }
  }

  const towerEvents = collectTowerEvents(state, dt);
  if (isHost) {
    for (const evt of towerEvents) sendMessage(evt);
  }

  const { impacts: newImpacts, events: impactEvents } =
    updateCannonballsWithEvents(state, dt);
  for (const imp of newImpacts) {
    battleAnim.impacts.push({ ...imp, age: 0 });
  }
  for (const evt of impactEvents) sendMessage(evt);

  // Haptic feedback for battle events
  if (onBattleEvents) {
    const allEvents = [...towerEvents, ...impactEvents];
    if (allEvents.length > 0) onBattleEvents(allEvents);
  }

  collectCrosshairs(true, dt);
  render();

  if (state.timer > 0 || state.cannonballs.length > 0) return false;

  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    ctrl.onBattleEnd();
  }
  onBattlePhaseEnded();
  return true;
}

// ---------------------------------------------------------------------------
// Host battle lifecycle (start, balloon anim, begin)
// ---------------------------------------------------------------------------

interface BattleAnimState {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: { flight: BalloonFlight; progress: number }[];
  impacts: Impact[];
}

export type BannerShow = (
  text: string,
  onDone: () => void,
  reveal?: boolean,
  newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
  subtitle?: string,
) => void;

interface StartHostBattleLifecycleDeps {
  // Core game deps (required)
  state: GameState;
  battleAnim: BattleAnimState;
  resolveBalloons: (state: GameState) => BalloonFlight[];
  snapshotTerritory: () => Set<number>[];
  showBanner: BannerShow;
  nextPhase: (state: GameState) => void;
  setModeBalloonAnim: () => void;
  beginBattle: () => void;

  // Networking hooks (optional, default to no-op)
  isHost?: boolean;
  sendBattleStart?: (flights: BalloonFlight[]) => void;
}

export function startHostBattleLifecycle(
  deps: StartHostBattleLifecycleDeps,
): void {
  const {
    state,
    battleAnim,
    resolveBalloons,
    snapshotTerritory,
    showBanner,
    nextPhase,
    setModeBalloonAnim,
    beginBattle,
    // Networking hooks with sensible defaults
    isHost = true,
    sendBattleStart = () => {},
  } = deps;

  const flights = resolveBalloons(state);
  const preTerritory = snapshotTerritory();
  const preWalls = state.players.map((p) => new Set(p.walls));

  showBanner(
    "Prepare for Battle",
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
    "Shoot at enemy walls",
  );

  nextPhase(state);
  battleAnim.impacts = [];
  if (isHost) sendBattleStart(flights);

  battleAnim.territory = snapshotTerritory();
  battleAnim.walls = state.players.map((p) => new Set(p.walls));
}

interface TickHostBalloonAnimDeps {
  dt: number;
  balloonFlightDuration: number;
  battleAnim: BattleAnimState;
  render: () => void;
  beginBattle: () => void;
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

interface BeginHostBattleDeps {
  // Core game deps (required)
  state: GameState;
  controllers: PlayerController[];
  accum: { battle: number };
  battleCountdown: number;
  setModeGame: () => void;

  // Networking hooks (optional, default to no-op / empty)
  remoteHumanSlots?: Set<number>;
  isHost?: boolean;
  watcherTiming?: WatcherTimingState;
  now?: () => number;
}

export function beginHostBattle(deps: BeginHostBattleDeps): void {
  const {
    state,
    controllers,
    accum,
    battleCountdown,
    setModeGame,
    // Networking hooks with sensible defaults
    remoteHumanSlots = EMPTY_SET as Set<number>,
    isHost = true,
    watcherTiming = { phaseStartTime: 0, phaseDuration: 0, countdownStartTime: 0, countdownDuration: 0 },
    now = () => 0,
  } = deps;

  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    if (state.players[ctrl.playerId]?.eliminated) continue;
    ctrl.resetBattle(state);
  }

  state.battleCountdown = battleCountdown;
  accum.battle = 0;
  if (!isHost) {
    watcherTiming.countdownStartTime = now();
    watcherTiming.countdownDuration = battleCountdown;
  }

  setModeGame();
}
