/**
 * Host-side tick functions for the battle phase.
 *
 * Contains the pure tick logic (tickHostBattleCountdown, tickHostBattlePhase,
 * startHostBattleLifecycle, tickHostBalloonAnim, beginHostBattle) consumed by
 * runtime-phase-ticks.ts. Networking deps are optional so the same functions
 * serve both local and online play.
 */

import type {
  BattleEvent,
  CannonFiredMessage,
  GameMessage,
  ImpactEvent,
} from "../../server/protocol.ts";
import type {
  BalloonFlight,
  BattleAnimState,
  Impact,
} from "../shared/battle-types.ts";
import { snapshotAllWalls } from "../shared/board-occupancy.ts";
import { type ModifierDiff } from "../shared/game-constants.ts";
import type { TilePos } from "../shared/geometry-types.ts";
import { modifierDef } from "../shared/modifier-defs.ts";
import type {
  BattleController,
  ControllerIdentity,
} from "../shared/system-interfaces.ts";
import {
  advancePhaseTimer,
  getRemoteSlots,
  type HostNetContext,
  isHostInContext,
  isRemoteHuman,
  localControllers,
  type WatcherTimingState,
} from "../shared/tick-context.ts";
import type { GameState } from "../shared/types.ts";
import type { BannerState } from "../shared/ui-contracts.ts";
import {
  createCannonFiredMsg,
  getCountdownAnnouncement,
} from "./battle-system.ts";
import { BANNER_BATTLE, type BannerShow } from "./phase-banner.ts";
import { enterBuildSkippingBattle } from "./phase-setup.ts";
import {
  BATTLE_START_STEPS,
  executeTransition,
  showBattlePhaseBanner,
  showModifierRevealBanner,
} from "./phase-transition-steps.ts";

type BattleCapable = ControllerIdentity & BattleController;

interface TickHostBattleCountdownDeps {
  dt: number;
  state: GameState;
  frame: { announcement?: string };
  controllers: BattleCapable[];
  syncCrosshairs: (weaponsActive: boolean, dt: number) => void;
  render: () => void;
  /** Network context. Pass LOCAL_NET for local play, full context for online. */
  net: Pick<HostNetContext, "remoteHumanSlots">;
}

/** Networking context for the battle phase.
 *  Optional (`net?`) — when omitted, no fire events are broadcast and
 *  all controllers are treated as local. */
interface BattlePhaseNet extends HostNetContext {
  sendBattleEvent: (msg: GameMessage) => void;
}

interface TickHostBattlePhaseDeps {
  dt: number;
  state: GameState;
  battleTimer: number;
  accum: { battle: number };
  controllers: BattleCapable[];
  battleAnim: { impacts: Impact[] };
  render: () => void;
  syncCrosshairs: (weaponsActive: boolean, dt: number) => void;
  collectTowerEvents: (state: GameState, dt: number) => Array<BattleEvent>;
  tickCannonballsWithEvents: (
    state: GameState,
    dt: number,
  ) => {
    impacts: TilePos[];
    events: Array<ImpactEvent>;
  };
  onBattlePhaseEnded: () => void;
  onBattleEvents?: (events: ReadonlyArray<BattleEvent>) => void;
  /** Network context. Pass LOCAL_NET (spread with sendBattleEvent no-op) for local play. */
  net: BattlePhaseNet;
}

/** Networking context for starting battle. */
interface BattleStartNet {
  isHost: boolean;
  sendBattleStart: (
    flights: readonly BalloonFlight[],
    modifierDiff: ModifierDiff | null,
  ) => void;
}

interface StartHostBattleLifecycleDeps {
  state: GameState;
  battleAnim: BattleAnimState;
  banner: Pick<BannerState, "newTerritory" | "newWalls" | "modifierDiff">;
  resolveBalloons: (state: GameState) => BalloonFlight[];
  snapshotTerritory: () => Set<number>[];
  showBanner: BannerShow;
  nextPhase: (state: GameState) => ModifierDiff | null;
  setModeBalloonAnim: () => void;
  beginBattle: () => void;
  /** Network context. Pass LOCAL_BATTLE_START_NET for local play. */
  net: BattleStartNet;
  /** When true, battle is skipped: game state is updated (enterBuildSkippingBattle)
   *  and onCeasefire is called instead of proceeding to battle. */
  ceasefireActive?: boolean;
  /** Called after game state is updated for ceasefire skip.
   *  Runtime uses this for checkpointing and entering the build phase. */
  onCeasefire?: () => void;
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
}

interface BeginHostBattleDeps {
  state: GameState;
  controllers: BattleCapable[];
  accum: { battle: number };
  battleCountdown: number;
  setModeGame: () => void;
  /** Network context. Pass LOCAL_NET (spread with watcherTiming/now stubs) for local play. */
  net: BattleBeginNet;
}

/** Local-play stub for BattleStartNet. No-op broadcast, always host. */
export const LOCAL_BATTLE_START_NET: BattleStartNet = {
  isHost: true,
  sendBattleStart: () => {
    /* no network in local play */
  },
};

export function tickHostBattleCountdown(
  deps: TickHostBattleCountdownDeps,
): void {
  const { dt, state, frame, controllers, syncCrosshairs, render } = deps;
  const remoteHumanSlots = getRemoteSlots(deps.net);

  state.battleCountdown = Math.max(0, state.battleCountdown - dt);
  for (const ctrl of localControllers(controllers, remoteHumanSlots)) {
    ctrl.battleTick(state, dt);
  }

  frame.announcement = getCountdownAnnouncement(state.battleCountdown);

  const weaponsActive = false; // countdown — weapons not yet active
  syncCrosshairs(weaponsActive, dt);
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
  const sendBattleEvent = deps.net?.sendBattleEvent;

  advancePhaseTimer(accum, "battle", state, dt, battleTimer);

  // Steps 1–3: collect events in LOAD-BEARING order (do not reorder).
  // Step 1 (fires) must run before step 3 (impacts) because new cannonballs
  // from battleTick are added to state.cannonballs, which step 3 then advances.
  // Step 2 (towers) must run before step 3 so tower kills are detected before
  // impact events check tower state. Reordering silently corrupts event data.
  const fireEvents = tickControllersAndCollectFires(
    state,
    dt,
    controllers,
    remoteHumanSlots,
    isHostInContext(deps.net),
    sendBattleEvent,
  );
  const towerEvents = collectTowerEvents(state, dt);
  if (isHostInContext(deps.net) && sendBattleEvent) {
    for (const evt of towerEvents) sendBattleEvent(evt);
  }
  const impactEvents = tickCannonballsAndRecordImpacts(
    state,
    dt,
    battleAnim,
    tickCannonballsWithEvents,
    sendBattleEvent,
  );

  // Step 4: notify sound/haptics
  if (onBattleEvents) {
    const allEvents = [...fireEvents, ...towerEvents, ...impactEvents];
    if (allEvents.length > 0) onBattleEvents(allEvents);
  }

  syncCrosshairs(/* weaponsActive */ true, dt);
  render();

  if (state.timer > 0 || state.cannonballs.length > 0) return false;

  // NOTE: Intentionally includes eliminated players — they need battle state
  // cleanup (clear fire targets, etc.) for potential castle reselection.
  for (const ctrl of controllers) {
    if (isRemoteHuman(ctrl.playerId, remoteHumanSlots)) continue;
    ctrl.endBattle();
  }
  onBattlePhaseEnded();
  return true;
}

export function startHostBattleLifecycle(
  deps: StartHostBattleLifecycleDeps,
): void {
  // Ceasefire: skip battle entirely and proceed to build phase
  if (deps.ceasefireActive) {
    enterBuildSkippingBattle(deps.state);
    deps.onCeasefire?.();
    return;
  }

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
  const sendBattleStart = deps.net?.sendBattleStart;

  let flights: BalloonFlight[] = [];
  const activeModifier = state.modern?.activeModifier ?? null;

  const proceedToBattle = () => {
    if (flights.length > 0) {
      battleAnim.flights = flights.map((flight) => ({
        flight,
        progress: 0,
      }));
      setModeBalloonAnim();
    } else {
      beginBattle();
    }
  };

  executeTransition(BATTLE_START_STEPS, {
    showBanner: () => {
      if (activeModifier) {
        // Modifier reveal banner first — diff data is set during applyCheckpoint
        // (runs while this banner animates) and picked up by the renderer.
        showModifierRevealBanner(
          showBanner,
          modifierDef(activeModifier).label,
          () => {
            showBattlePhaseBanner(showBanner, BANNER_BATTLE, proceedToBattle);
          },
        );
      } else {
        showBattlePhaseBanner(showBanner, BANNER_BATTLE, proceedToBattle);
      }
    },
    applyCheckpoint: () => {
      const diff = nextPhase(state);
      if (diff) deps.banner.modifierDiff = diff;
      // Resolve balloons AFTER nextPhase so modifiers (crumbling walls, etc.)
      // are applied before the enclosure check picks targets.
      flights = resolveBalloons(state);
      battleAnim.impacts = [];
      if (isHostInContext(deps.net) && sendBattleStart)
        sendBattleStart(flights, diff);
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

  for (const ctrl of localControllers(controllers, remoteHumanSlots)) {
    ctrl.initBattleState(state);
  }

  state.battleCountdown = battleCountdown;
  accum.battle = 0;
  if (!isHostInContext(deps.net) && deps.net) {
    const { watcherTiming } = deps.net;
    watcherTiming.countdownStartTime = performance.now();
    watcherTiming.countdownDuration = battleCountdown;
  }

  setModeGame();
}

/** Tick local controllers and collect fire events from newly created cannonballs. */
function tickControllersAndCollectFires(
  state: GameState,
  dt: number,
  controllers: readonly BattleCapable[],
  remoteHumanSlots: ReadonlySet<number>,
  isHost: boolean,
  sendBattleEvent: ((msg: GameMessage) => void) | undefined,
): CannonFiredMessage[] {
  const ballsBefore = state.cannonballs.length;
  for (const ctrl of localControllers(controllers, remoteHumanSlots)) {
    ctrl.battleTick(state, dt);
  }
  const fireEvents: CannonFiredMessage[] = [];
  for (let i = ballsBefore; i < state.cannonballs.length; i++) {
    const msg = createCannonFiredMsg(state.cannonballs[i]!);
    fireEvents.push(msg);
    if (isHost && sendBattleEvent) sendBattleEvent(msg);
  }
  return fireEvents;
}

/** Advance cannonballs, record visual impacts, broadcast impact events. */
function tickCannonballsAndRecordImpacts(
  state: GameState,
  dt: number,
  battleAnim: { impacts: Impact[] },
  tickCannonballsWithEvents: TickHostBattlePhaseDeps["tickCannonballsWithEvents"],
  sendBattleEvent: ((msg: GameMessage) => void) | undefined,
): ImpactEvent[] {
  const { impacts: newImpacts, events: impactEvents } =
    tickCannonballsWithEvents(state, dt);
  for (const imp of newImpacts) {
    battleAnim.impacts.push({ ...imp, age: 0 });
  }
  if (sendBattleEvent) {
    for (const evt of impactEvents) sendBattleEvent(evt);
  }
  return impactEvents;
}
