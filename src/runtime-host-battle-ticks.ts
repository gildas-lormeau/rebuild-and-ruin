/**
 * Host-side tick functions for the battle phase.
 *
 * Contains the pure tick logic (tickHostBattleCountdown, tickHostBattlePhase,
 * startHostBattleLifecycle, tickHostBalloonAnim, beginHostBattle) consumed by
 * runtime-phase-ticks.ts. Networking deps are optional so the same functions
 * serve both local and online play.
 */

import type { GameMessage } from "../server/protocol.ts";
import { getCountdownAnnouncement } from "./battle-system.ts";
import { snapshotAllWalls } from "./board-occupancy.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import type { TilePos } from "./geometry-types.ts";
import { createCannonFiredMsg } from "./online-send-actions.ts";
import type { WatcherTimingState } from "./online-types.ts";
import { BANNER_BATTLE, type BannerShow } from "./phase-banner.ts";
import {
  BATTLE_START_STEPS,
  executeTransition,
  showBattlePhaseBanner,
} from "./phase-transition-shared.ts";
import {
  advancePhaseTimer,
  getRemoteSlots,
  type HostNetContext,
  isHostInContext,
  localActiveControllers,
} from "./tick-context.ts";
import type {
  BalloonFlight,
  BattleAnimState,
  GameState,
  Impact,
} from "./types.ts";

interface TickHostBattleCountdownDeps {
  dt: number;
  state: GameState;
  frame: { announcement?: string };
  controllers: PlayerController[];
  syncCrosshairs: (canFireNow: boolean, dt: number) => void;
  render: () => void;
  net?: Pick<HostNetContext, "remoteHumanSlots">;
}

/** Networking context for the battle phase.
 *  Optional (`net?`) — when omitted, no fire events are broadcast and
 *  all controllers are treated as local. */
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
  collectTowerEvents: (state: GameState, dt: number) => Array<GameMessage>;
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

/** Networking context for starting battle.
 *  Optional — when omitted, balloon flights are not broadcast. */
interface BattleStartNet {
  isHost: boolean;
  sendBattleStart: (flights: readonly BalloonFlight[]) => void;
}

interface StartHostBattleLifecycleDeps {
  state: GameState;
  battleAnim: BattleAnimState;
  banner: {
    newTerritory?: Set<number>[];
    newWalls?: Set<number>[];
  };
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
  for (const ctrl of localActiveControllers(
    controllers,
    remoteHumanSlots,
    state,
  )) {
    ctrl.battleTick(state, dt);
  }

  frame.announcement = getCountdownAnnouncement(state.battleCountdown);

  const canFireNow = false; // countdown — weapons not yet active
  syncCrosshairs(canFireNow, dt);
  render();
}

/** Tick the battle phase. Returns true when battle ends.
 *
 *  Event collection order (load-bearing — do not reorder):
 *    1. Tick controllers → fire events (new cannonballs from battleTick)
 *    2. collectTowerEvents → tower kill/damage events
 *    3. tickCannonballsWithEvents → impact events (walls, cannons, houses, grunts)
 *    4. Broadcast all events to network
 *  Events in each category are collected by comparing array lengths before/after.
 *
 *  Remote vs local dispatch:
 *    Per-frame: ticks LOCAL controllers only (remote crosshairs arrive via network).
 *    Fire events from local controllers are broadcast to remotes.
 *    All controllers (local + remote) contribute to grunt/tower event collection. */
export function tickHostBattlePhase(deps: TickHostBattlePhaseDeps): boolean {
  const {
    dt,
    state,
    battleTimer,
    accum,
    controllers,
    battleAnim,
    render,
    syncCrosshairs,
    collectTowerEvents,
    tickCannonballsWithEvents,
    onBattlePhaseEnded,
    onBattleEvents,
  } = deps;
  const remoteHumanSlots = getRemoteSlots(deps.net);
  const isHost = isHostInContext(deps.net);
  const sendMessage = deps.net?.sendMessage;

  advancePhaseTimer(accum, "battle", state, dt, battleTimer);

  // Steps 1–3: collect events in load-bearing order
  const fireEvents = tickControllersAndCollectFires(
    state,
    dt,
    controllers,
    remoteHumanSlots,
    isHost,
    sendMessage,
  );
  const towerEvents = collectTowerEvents(state, dt);
  if (isHost && sendMessage) {
    for (const evt of towerEvents) sendMessage(evt);
  }
  const impactEvents = tickCannonballsAndRecordImpacts(
    state,
    dt,
    battleAnim,
    tickCannonballsWithEvents,
    sendMessage,
  );

  // Step 4: notify sound/haptics
  if (onBattleEvents) {
    const allEvents = [...fireEvents, ...towerEvents, ...impactEvents];
    if (allEvents.length > 0) onBattleEvents(allEvents);
  }

  syncCrosshairs(/* canFireNow */ true, dt);
  render();

  if (state.timer > 0 || state.cannonballs.length > 0) return false;

  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    ctrl.endBattle();
  }
  onBattlePhaseEnded();
  return true;
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
  } = deps;
  const isHost = isHostInContext(deps.net);
  const sendBattleStart = deps.net?.sendBattleStart;

  const flights = resolveBalloons(state);

  executeTransition(BATTLE_START_STEPS, {
    showBanner: () =>
      showBattlePhaseBanner(showBanner, BANNER_BATTLE, () => {
        if (flights.length > 0) {
          battleAnim.flights = flights.map((flight) => ({
            flight,
            progress: 0,
          }));
          setModeBalloonAnim();
        } else {
          beginBattle();
        }
      }),
    applyCheckpoint: () => {
      nextPhase(state);
      battleAnim.impacts = [];
      if (isHost && sendBattleStart) sendBattleStart(flights);
    },
    snapshotForBanner: () => {
      const postTerritory = snapshotTerritory();
      const postWalls = snapshotAllWalls(state);
      battleAnim.territory = postTerritory;
      battleAnim.walls = postWalls;
      deps.banner.newTerritory = postTerritory;
      deps.banner.newWalls = postWalls;
    },
  });
}

export function tickHostBalloonAnim(deps: TickHostBalloonAnimDeps): void {
  const { dt, balloonFlightDuration, battleAnim, render, beginBattle } = deps;
  let allDone = true;
  for (const b of battleAnim.flights) {
    // Clamp to 1.0 — progress is normalized [0,1] and must not overshoot
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
  const isHost = isHostInContext(deps.net);

  for (const ctrl of localActiveControllers(
    controllers,
    remoteHumanSlots,
    state,
  )) {
    ctrl.initBattleState(state);
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

/** Tick local controllers and collect fire events from newly created cannonballs. */
function tickControllersAndCollectFires(
  state: GameState,
  dt: number,
  controllers: readonly PlayerController[],
  remoteHumanSlots: ReadonlySet<number>,
  isHost: boolean,
  sendMessage: ((msg: GameMessage) => void) | undefined,
): GameMessage[] {
  const ballsBefore = state.cannonballs.length;
  for (const ctrl of localActiveControllers(
    controllers,
    remoteHumanSlots,
    state,
  )) {
    ctrl.battleTick(state, dt);
  }
  const fireEvents: GameMessage[] = [];
  for (let i = ballsBefore; i < state.cannonballs.length; i++) {
    const msg = createCannonFiredMsg(state.cannonballs[i]!);
    fireEvents.push(msg);
    if (isHost && sendMessage) sendMessage(msg);
  }
  return fireEvents;
}

/** Advance cannonballs, record visual impacts, broadcast impact events. */
function tickCannonballsAndRecordImpacts(
  state: GameState,
  dt: number,
  battleAnim: { impacts: Impact[] },
  tickCannonballsWithEvents: TickHostBattlePhaseDeps["tickCannonballsWithEvents"],
  sendMessage: ((msg: GameMessage) => void) | undefined,
): GameMessage[] {
  const { impacts: newImpacts, events: impactEvents } =
    tickCannonballsWithEvents(state, dt);
  for (const imp of newImpacts) {
    battleAnim.impacts.push({ ...imp, age: 0 });
  }
  if (sendMessage) {
    for (const evt of impactEvents) sendMessage(evt);
  }
  return impactEvents;
}
