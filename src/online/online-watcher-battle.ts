import {
  advanceCannonball,
  canPlayerFire,
  emitBattleCeaseIfTimerCrossed,
  setBattleCountdown,
} from "../game/index.ts";
import type { WatcherTimingState } from "../runtime/runtime-tick-context.ts";
import type {
  Cannonball,
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
import { packTile } from "../shared/core/spatial.ts";
import type {
  OrbitParams,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
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
  watcherOrbitAngles: Map<number, number>;
  watcherOrbitParams: Map<number, OrbitParams>;
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

/** Orbital idle wobble frequency on X axis (rad/s — coprime with Y to avoid repetition). */
const ORBIT_FREQ_X = 0.23;
/** Orbital idle wobble frequency on Y axis (rad/s — coprime with X to avoid repetition). */
const ORBIT_FREQ_Y = 0.19;

export function tickWatcherTimers(
  state: GameState,
  frame: WatcherFrameAnnouncement,
  timing: WatcherTimingState,
  now: () => number,
): void {
  if (isPlacementPhase(state.phase)) {
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

  const elapsed = Math.max(0, (now() - timing.phaseStartTime) / 1000);
  const prevTimer = state.timer;
  state.timer = Math.max(0, timing.phaseDuration - elapsed);
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
    watcherOrbitAngles,
    watcherOrbitParams,
    logThrottled,
    interpolateToward,
    nextReadyCombined,
    maybeSendAimUpdate,
    aimCannons,
  } = deps;

  const remaining: Cannonball[] = [];
  for (const ball of state.cannonballs) {
    const hit = advanceCannonball(ball, dt);
    if (hit) {
      battleAnim.impacts.push({ ...hit, age: 0 });
      // Record thaw animation if this hit landed on frozen water
      const frozenSet = state.modern?.frozenTiles;
      if (frozenSet?.has(packTile(hit.row, hit.col))) {
        battleAnim.thawing.push({ row: hit.row, col: hit.col, age: 0 });
      }
    } else {
      remaining.push(ball);
    }
  }
  state.cannonballs = remaining;

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

    const orbitParams =
      state.battleCountdown > 0 ? watcherOrbitParams.get(pid) : undefined;
    const newAngle = updateOrbitCrosshair(
      visualPos,
      target,
      orbitParams,
      watcherOrbitAngles.get(pid) ?? orbitParams?.phaseAngle ?? 0,
      dt,
      REMOTE_CROSSHAIR_SPEED,
      interpolateToward,
    );
    if (orbitParams) watcherOrbitAngles.set(pid, newAngle);

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

/** Interpolate a crosshair toward its target, applying orbital wobble when orbit params are present.
 *  @param angle — orbital phase angle in radians (NOT a game Phase enum). */
function updateOrbitCrosshair(
  visualPos: PixelPos,
  target: PixelPos,
  orbitParams: OrbitParams | undefined,
  angle: number,
  dt: number,
  speed: number,
  interpolateToward: (
    visualPos: PixelPos,
    tx: number,
    ty: number,
    speed: number,
    dt: number,
  ) => void,
): number {
  if (orbitParams) {
    const rx = orbitParams.rx + Math.sin(angle * ORBIT_FREQ_X);
    const ry = orbitParams.ry + Math.sin(angle * ORBIT_FREQ_Y);
    const nextAngle = angle + orbitParams.speed * dt;
    interpolateToward(
      visualPos,
      target.x + Math.cos(nextAngle) * rx,
      target.y + Math.sin(nextAngle) * ry,
      speed,
      dt,
    );
    return nextAngle;
  }
  interpolateToward(visualPos, target.x, target.y, speed, dt);
  return angle;
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
