import {
  canPlayerFire,
  emitBattleCeaseIfTimerCrossed,
  setBattleCountdown,
  tickBattlePhase,
} from "../game/index.ts";
import {
  ACCUM_BATTLE,
  advancePhaseTimer,
  type TimerAccums,
  type WatcherTimingState,
} from "../runtime/runtime-tick-context.ts";
import { BATTLE_MESSAGE } from "../shared/core/battle-events.ts";
import type {
  Crosshair,
  Impact,
  ThawingTile,
} from "../shared/core/battle-types.ts";
import { BATTLE_TIMER } from "../shared/core/game-constants.ts";
import { isPlacementPhase, Phase } from "../shared/core/game-phase.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import {
  type CannonPhantom,
  cannonPhantomKey,
  type DedupChannel,
  filterAlivePhantoms,
  type PiecePhantom,
  phantomWireMode,
  piecePhantomKey,
} from "../shared/core/phantom-types.ts";
import type {
  PlayerSlotId,
  ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  REMOTE_CROSSHAIR_SPEED,
  setWatcherPhaseTimer,
} from "./online-types.ts";

interface WatcherFrameAnnouncement {
  announcement?: string;
}

interface WatcherBattleFrame {
  crosshairs: Crosshair[];
}

interface WatcherBattleAnimState {
  impacts: Impact[];
  thawing: ThawingTile[];
}

interface WatcherBattleDeps {
  state: GameState;
  frame: WatcherBattleFrame;
  battleAnim: WatcherBattleAnimState;
  dt: number;
  myPlayerId: PlayerSlotId;
  localController: PlayerController | null;
  remoteCrosshairs: Map<number, PixelPos>;
  watcherCrosshairPos: Map<number, PixelPos>;
  logThrottled: (key: string, msg: string) => void;
  interpolateToward: (
    visualPos: PixelPos,
    tx: number,
    ty: number,
    speed: number,
    dt: number,
  ) => void;
  nextReadyCombined: (state: GameState, playerId: ValidPlayerSlot) => unknown;
  maybeSendAimUpdate: (x: number, y: number) => void;
  aimCannons: (
    state: GameState,
    playerId: ValidPlayerSlot,
    x: number,
    y: number,
    dt: number,
  ) => void;
}

interface TickWatcherCannonPhantomsDeps {
  state: GameState;
  dt: number;
  myPlayerId: PlayerSlotId;
  localController: PlayerController | null;
  remoteCannonPhantoms: readonly CannonPhantom[];
  lastSentCannonPhantom: DedupChannel;
  sendOpponentCannonPhantom: (msg: CannonPhantom) => void;
  /** Sink for the runtime's `remotePhantoms.cannonPhantoms` slot.
   *  Receives the alive-filtered remote array so render + touch readers
   *  can source remote previews from the runtime slot; local previews
   *  come from the controller's `currentCannonPhantom`. */
  setRemoteCannonPhantoms: (phantoms: readonly CannonPhantom[]) => void;
}

interface TickWatcherBuildPhantomsDeps {
  state: GameState;
  dt: number;
  localController: PlayerController | null;
  remotePiecePhantoms: readonly PiecePhantom[];
  lastSentPiecePhantom: DedupChannel;
  sendOpponentPiecePhantom: (msg: PiecePhantom) => void;
  /** Sink for the runtime's `remotePhantoms.piecePhantoms` slot.
   *  Receives the alive-filtered remote array so render + touch readers
   *  can source remote previews from the runtime slot; local previews
   *  come from each controller's `currentBuildPhantoms`. */
  setRemotePiecePhantoms: (phantoms: readonly PiecePhantom[]) => void;
}

export function tickWatcherTimers(
  state: GameState,
  frame: WatcherFrameAnnouncement,
  timing: WatcherTimingState,
  now: () => number,
  accum: TimerAccums,
  dt: number,
): void {
  // MODIFIER_REVEAL is also a phase-timer-driven phase on the watcher
  // side (same wall-clock synthesis pattern as placement phases) —
  // `enter-modifier-reveal.postDisplay.watcher` anchors the timer via
  // `setPhaseTimerAtBannerEnd`, and `tickWatcher` detects expiry and
  // dispatches `enter-battle` locally.
  if (isPlacementPhase(state.phase) || state.phase === Phase.MODIFIER_REVEAL) {
    const elapsed = Math.max(0, (now() - timing.phaseStartTime) / 1000);
    state.timer = Math.max(0, timing.phaseDuration - elapsed);
    return;
  }

  if (state.phase !== Phase.BATTLE) return;

  if (timing.countdownDuration > 0) {
    const elapsed = Math.max(0, (now() - timing.countdownStartTime) / 1000);
    frame.announcement = setBattleCountdown(
      state,
      timing.countdownDuration - elapsed,
    );
    if (!frame.announcement) {
      setWatcherPhaseTimer(
        timing,
        timing.countdownStartTime + timing.countdownDuration * 1000,
        BATTLE_TIMER,
      );
      timing.countdownDuration = 0;
    }
    return;
  }

  // After countdown: dt-based decrement (matches host). Wall-clock
  // synthesis was used here originally for jitter resilience but it
  // drifts from the host's sim-tick accumulation (~17ms wall vs 1/60s
  // sim per tick), and that drift shifts combo streak windows. Both
  // peers reset ACCUM_BATTLE to 0 in `beginBattle`, so advancing it by
  // dt keeps state.timer in lockstep with host.
  const prevTimer = state.timer;
  advancePhaseTimer(accum, ACCUM_BATTLE, state, dt, BATTLE_TIMER);
  emitBattleCeaseIfTimerCrossed(state, prevTimer);
}

export function tickWatcherBattlePhase(deps: WatcherBattleDeps): void {
  const {
    state,
    frame,
    battleAnim,
    dt,
    myPlayerId,
    localController,
    remoteCrosshairs,
    watcherCrosshairPos,
    logThrottled,
    interpolateToward,
    nextReadyCombined,
    maybeSendAimUpdate,
    aimCannons,
  } = deps;

  // Run the same engine combat tick as the host: gruntAttackTowers (tower
  // kills + grunt-broken WALL_DESTROYED via wallEvents) followed by
  // tickCannonballs (cannonball impacts + applyImpactEvent + bus emits).
  // Both halves are deterministic given synced state + dt, so the watcher
  // derives every TOWER_KILLED / WALL_DESTROYED / CANNON_DAMAGED / etc.
  // identically to the host. RNG calls inside computeImpact (house→grunt
  // spawn, conscription, ricochet) advance state.rng symmetrically — both
  // sides started this BATTLE with byte-identical state.rng (synced via
  // BattleStartData.rngState).
  //
  // Skip during the READY/AIM/FIRE countdown — host gates tickBattlePhase
  // on `battleCountdown === 0` (runtime-phase-ticks.ts), so without this
  // guard the watcher runs ~360 extra grunt-attack ticks during the 6s
  // countdown before host even starts. That diverges grunt-broken walls.
  const result =
    state.battleCountdown > 0
      ? { impactEvents: [], newImpacts: [] }
      : tickBattlePhase(state, dt);
  for (const impact of result.newImpacts) {
    battleAnim.impacts.push({ ...impact, age: 0 });
  }
  for (const evt of result.impactEvents) {
    if (evt.type === BATTLE_MESSAGE.ICE_THAWED) {
      battleAnim.thawing.push({ row: evt.row, col: evt.col, age: 0 });
    }
  }

  frame.crosshairs = [];
  logThrottled(
    "watcher-ch-map",
    `tickWatcher battle: remoteCrosshairs keys=[${[...remoteCrosshairs.keys()]}] cannons=[${state.players.map((player, i) => `P${i}:${player.cannons.length}`).join(",")}]`,
  );

  for (const [rawPid, target] of remoteCrosshairs) {
    const pid = rawPid as ValidPlayerSlot;
    const player = state.players[pid];
    if (isPlayerEliminated(player)) continue;
    if (!canPlayerFire(state, pid)) continue;

    let visualPos = watcherCrosshairPos.get(pid);
    if (!visualPos) {
      visualPos = { x: target.x, y: target.y };
      watcherCrosshairPos.set(pid, visualPos);
    }

    interpolateToward(
      visualPos,
      target.x,
      target.y,
      REMOTE_CROSSHAIR_SPEED,
      dt,
    );

    frame.crosshairs.push({
      x: visualPos.x,
      y: visualPos.y,
      playerId: pid,
      cannonReady:
        state.battleCountdown <= 0 && !!nextReadyCombined(state, pid),
    });
    aimCannons(state, pid, visualPos.x, visualPos.y, dt);
  }

  tickLocalBattle(
    state,
    frame,
    dt,
    myPlayerId,
    localController,
    nextReadyCombined,
    maybeSendAimUpdate,
    aimCannons,
  );
}

export function tickWatcherCannonPhantomsPhase(
  deps: TickWatcherCannonPhantomsDeps,
): void {
  const {
    state,
    dt,
    myPlayerId,
    localController,
    remoteCannonPhantoms,
    lastSentCannonPhantom,
    sendOpponentCannonPhantom,
  } = deps;

  const aliveRemote = filterAlivePhantoms(remoteCannonPhantoms, state.players);
  // Remote phantoms flow through the runtime slot; render + touch read
  // from there so the watcher never writes to `frame.phantoms`. The local
  // controller's phantom is owned by `ctrl.currentCannonPhantom`.
  deps.setRemoteCannonPhantoms(aliveRemote);

  if (!localController) return;

  const phantom = localController.cannonTick(state, dt);
  if (!phantom) return;

  if (
    !lastSentCannonPhantom.shouldSend(
      myPlayerId as ValidPlayerSlot,
      cannonPhantomKey(phantom),
    )
  )
    return;
  sendOpponentCannonPhantom({
    playerId: myPlayerId as ValidPlayerSlot,
    row: phantom.row,
    col: phantom.col,
    mode: phantomWireMode(phantom),
    valid: phantom.valid,
  });
}

export function tickWatcherBuildPhantomsPhase(
  deps: TickWatcherBuildPhantomsDeps,
): void {
  const {
    state,
    dt,
    localController,
    remotePiecePhantoms,
    lastSentPiecePhantom,
    sendOpponentPiecePhantom,
    setRemotePiecePhantoms,
  } = deps;

  const aliveRemote = filterAlivePhantoms(remotePiecePhantoms, state.players);
  // Remote phantoms flow through the runtime slot; render + touch read
  // from there so the watcher never writes to `frame.phantoms`. The local
  // controller's phantoms are owned by `ctrl.currentBuildPhantoms`.
  setRemotePiecePhantoms(aliveRemote);

  if (!localController) return;

  const phantoms = localController.buildTick(state, dt);
  for (const phantom of phantoms) {
    if (
      !lastSentPiecePhantom.shouldSend(
        phantom.playerId,
        piecePhantomKey(phantom),
      )
    )
      continue;
    sendOpponentPiecePhantom({
      playerId: phantom.playerId,
      row: phantom.row,
      col: phantom.col,
      offsets: phantom.offsets,
      valid: phantom.valid,
    });
  }
}

/** Tick the local player's battle crosshair and send aim updates. */
function tickLocalBattle(
  state: GameState,
  frame: WatcherBattleFrame,
  dt: number,
  myPlayerId: PlayerSlotId,
  localController: PlayerController | null,
  nextReadyCombined: (state: GameState, playerId: ValidPlayerSlot) => unknown,
  maybeSendAimUpdate: (x: number, y: number) => void,
  aimCannons: (
    state: GameState,
    playerId: ValidPlayerSlot,
    x: number,
    y: number,
    dt: number,
  ) => void,
): void {
  if (!localController) return;

  localController.battleTick(state, dt);
  const ch = localController.getCrosshair();

  const pid = myPlayerId as ValidPlayerSlot;
  if (canPlayerFire(state, pid)) {
    const readyCannon = nextReadyCombined(state, pid);
    frame.crosshairs.push({
      x: ch.x,
      y: ch.y,
      playerId: pid,
      cannonReady: state.battleCountdown <= 0 && !!readyCannon,
    });
  }

  maybeSendAimUpdate(ch.x, ch.y);
  aimCannons(state, pid, ch.x, ch.y, dt);
}
