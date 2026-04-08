/**
 * Host-side tick functions for the battle phase.
 *
 * Contains the pure tick logic (advanceBattleCountdown, tickHostBattlePhase,
 * startHostBattleLifecycle, initBattleControllers) consumed by
 * runtime-phase-ticks.ts.
 *
 * Network-agnostic: callers pre-filter controllers and provide optional
 * callbacks for event broadcasting. The game domain has zero knowledge of
 * host/watcher topology or remote human slots.
 */

import type {
  BattleEvent,
  CannonFiredMessage,
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
import { advancePhaseTimer } from "../shared/tick-context.ts";
import type { GameState } from "../shared/types.ts";
import type { BannerState } from "../shared/ui-contracts.ts";
import {
  createCannonFiredMsg,
  getCountdownAnnouncement,
} from "./battle-system.ts";
import { BANNER_BATTLE, type BannerShow } from "./phase-banner.ts";
import {
  enterBattleFromCannon,
  enterBuildSkippingBattle,
} from "./phase-setup.ts";
import {
  BATTLE_START_STEPS,
  executeTransition,
  showBattlePhaseBanner,
  showModifierRevealBanner,
} from "./phase-transition-steps.ts";

type BattleCapable = ControllerIdentity & BattleController;

interface TickHostBattlePhaseDeps {
  dt: number;
  state: GameState;
  battleTimer: number;
  accum: { battle: number };
  /** Pre-filtered to local controllers only (PASS 1: per-frame tick). */
  localControllers: BattleCapable[];
  /** Pre-filtered to controllers that need end-of-battle cleanup
   *  (local controllers only — remote humans are skipped). */
  controllersToFinalize: BattleCapable[];
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
  /** Optional: broadcast a battle event to network peers.
   *  Called per-event as they are generated (fire, tower, impact).
   *  Omit for local play. */
  broadcastEvent?: (evt: BattleEvent) => void;
}

interface StartHostBattleLifecycleDeps {
  state: GameState;
  battleAnim: BattleAnimState;
  banner: Pick<BannerState, "newTerritory" | "newWalls" | "modifierDiff">;
  resolveBalloons: (state: GameState) => BalloonFlight[];
  snapshotTerritory: () => Set<number>[];
  showBanner: BannerShow;
  setModeBalloonAnim: () => void;
  beginBattle: () => void;
  /** Optional: broadcast battle start to network peers. Omit for local play. */
  sendBattleStart?: (
    flights: readonly BalloonFlight[],
    modifierDiff: ModifierDiff | null,
  ) => void;
  /** When true, battle is skipped: game state is updated (enterBuildSkippingBattle)
   *  and onCeasefire is called instead of proceeding to battle. */
  ceasefireActive?: boolean;
  /** Called after game state is updated for ceasefire skip.
   *  Runtime uses this for checkpointing and entering the build phase. */
  onCeasefire?: () => void;
}

/** Decrement the battle countdown timer and return announcement text.
 *  Pure game logic — no rendering or crosshair sync. */
export function advanceBattleCountdown(
  state: GameState,
  dt: number,
): string | undefined {
  state.battleCountdown = Math.max(0, state.battleCountdown - dt);
  return getCountdownAnnouncement(state.battleCountdown);
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
 *  Controller dispatch:
 *    Per-frame: ticks `localControllers` only (caller pre-filters).
 *    `controllersToFinalize` receive endBattle() at phase end.
 *    Tower/cannonball events are collected from game state (not controllers). */
export function tickHostBattlePhase(deps: TickHostBattlePhaseDeps): boolean {
  const {
    dt,
    state,
    battleTimer,
    accum,
    localControllers,
    controllersToFinalize,
    battleAnim,
    render,
    syncCrosshairs,
    collectTowerEvents,
    tickCannonballsWithEvents,
    onBattlePhaseEnded,
    onBattleEvents,
    broadcastEvent,
  } = deps;

  advancePhaseTimer(accum, "battle", state, dt, battleTimer);

  // Steps 1–3: collect events in LOAD-BEARING order (do not reorder).
  // Step 1 (fires) must run before step 3 (impacts) because new cannonballs
  // from battleTick are added to state.cannonballs, which step 3 then advances.
  // Step 2 (towers) must run before step 3 so tower kills are detected before
  // impact events check tower state. Reordering silently corrupts event data.
  const fireEvents = tickControllersAndCollectFires(
    state,
    dt,
    localControllers,
    broadcastEvent,
  );
  const towerEvents = collectTowerEvents(state, dt);
  if (broadcastEvent) {
    for (const evt of towerEvents) broadcastEvent(evt);
  }
  const impactEvents = tickCannonballsAndRecordImpacts(
    state,
    dt,
    battleAnim,
    tickCannonballsWithEvents,
    broadcastEvent,
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
  for (const ctrl of controllersToFinalize) {
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
    setModeBalloonAnim,
    beginBattle,
  } = deps;
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
      const diff = enterBattleFromCannon(state);
      if (diff) deps.banner.modifierDiff = diff;
      // Resolve balloons AFTER enterBattleFromCannon so modifiers
      // (crumbling walls, etc.) are applied before the enclosure check picks targets.
      flights = resolveBalloons(state);
      battleAnim.impacts = [];
      deps.sendBattleStart?.(flights, diff);
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

/** Initialize battle state on all provided controllers.
 *  Pure game logic — no UI mode switches or timer setup. */
export function initBattleControllers(
  controllers: readonly BattleCapable[],
  state: GameState,
): void {
  for (const ctrl of controllers) {
    ctrl.initBattleState(state);
  }
}

/** Tick local controllers and collect fire events from newly created cannonballs. */
function tickControllersAndCollectFires(
  state: GameState,
  dt: number,
  controllers: readonly BattleCapable[],
  broadcastEvent: ((evt: BattleEvent) => void) | undefined,
): CannonFiredMessage[] {
  const ballsBefore = state.cannonballs.length;
  for (const ctrl of controllers) {
    ctrl.battleTick(state, dt);
  }
  const fireEvents: CannonFiredMessage[] = [];
  for (let i = ballsBefore; i < state.cannonballs.length; i++) {
    const msg = createCannonFiredMsg(state.cannonballs[i]!);
    fireEvents.push(msg);
    broadcastEvent?.(msg);
  }
  return fireEvents;
}

/** Advance cannonballs, record visual impacts, broadcast impact events. */
function tickCannonballsAndRecordImpacts(
  state: GameState,
  dt: number,
  battleAnim: { impacts: Impact[] },
  tickCannonballsWithEvents: TickHostBattlePhaseDeps["tickCannonballsWithEvents"],
  broadcastEvent: ((evt: BattleEvent) => void) | undefined,
): ImpactEvent[] {
  const { impacts: newImpacts, events: impactEvents } =
    tickCannonballsWithEvents(state, dt);
  for (const imp of newImpacts) {
    battleAnim.impacts.push({ ...imp, age: 0 });
  }
  if (broadcastEvent) {
    for (const evt of impactEvents) broadcastEvent(evt);
  }
  return impactEvents;
}
