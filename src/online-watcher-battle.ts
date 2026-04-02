import {
  advanceCannonball,
  canPlayerFire,
  getCountdownAnnouncement,
} from "./battle-system.ts";
import type { OrbitParams, PlayerController } from "./controller-interfaces.ts";
import { BATTLE_TIMER } from "./game-constants.ts";
import type { Crosshair, PixelPos } from "./geometry-types.ts";
import {
  REMOTE_CROSSHAIR_SPEED,
  setWatcherPhaseTimer,
  type WatcherTimingState,
} from "./online-types.ts";
import {
  type CannonPhantom,
  cannonPhantomKey,
  type DedupChannel,
  filterAlivePhantoms,
  type PiecePhantom,
  phantomWireMode,
  piecePhantomKey,
} from "./phantom-types.ts";
import {
  type CannonMode,
  type GameState,
  type Impact,
  isPlacementPhase,
  isPlayerAlive,
  Phase,
} from "./types.ts";

interface WatcherFrameAnnouncement {
  announcement?: string;
}

interface WatcherBattleFrame {
  crosshairs: Crosshair[];
}

interface WatcherBattleAnimState {
  impacts: Impact[];
}

interface WatcherBattleDeps {
  state: GameState;
  frame: WatcherBattleFrame;
  battleAnim: WatcherBattleAnimState;
  dt: number;
  onlinePlayerId: number;
  localController: PlayerController | null;
  remoteCrosshairs: Map<number, PixelPos>;
  watcherCrosshairPos: Map<number, PixelPos>;
  watcherOrbitPhases: Map<number, number>;
  watcherOrbitParams: Map<number, OrbitParams>;
  logThrottled: (key: string, msg: string) => void;
  interpolateToward: (
    visualPos: PixelPos,
    tx: number,
    ty: number,
    speed: number,
    dt: number,
  ) => void;
  nextReadyCombined: (state: GameState, playerId: number) => unknown;
  maybeSendAimUpdate: (x: number, y: number) => void;
  aimCannons: (
    state: GameState,
    playerId: number,
    x: number,
    y: number,
    dt: number,
  ) => void;
}

interface WatcherPhantomFrame {
  phantoms: {
    cannonPhantoms?: CannonPhantom[];
    piecePhantoms?: PiecePhantom[];
    defaultFacings?: ReadonlyMap<number, number>;
  };
}

interface TickWatcherCannonPhantomsDeps {
  state: GameState;
  frame: WatcherPhantomFrame;
  dt: number;
  onlinePlayerId: number;
  localController: PlayerController | null;
  remoteCannonPhantoms: readonly CannonPhantom[];
  lastSentCannonPhantom: DedupChannel;
  sendOpponentCannonPhantom: (msg: {
    playerId: number;
    row: number;
    col: number;
    mode: CannonMode;
    valid: boolean;
  }) => void;
}

interface TickWatcherBuildPhantomsDeps {
  state: GameState;
  frame: WatcherPhantomFrame;
  dt: number;
  localController: PlayerController | null;
  remotePiecePhantoms: readonly PiecePhantom[];
  lastSentPiecePhantom: DedupChannel;
  sendOpponentPiecePhantom: (msg: {
    playerId: number;
    row: number;
    col: number;
    offsets: [number, number][];
    valid: boolean;
  }) => void;
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
    state.battleCountdown = Math.max(0, timing.countdownDuration - elapsed);

    frame.announcement = getCountdownAnnouncement(state.battleCountdown);
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
  state.timer = Math.max(0, timing.phaseDuration - elapsed);
}

export function tickWatcherBattlePhase(deps: WatcherBattleDeps): void {
  const {
    state,
    frame,
    battleAnim,
    dt,
    onlinePlayerId,
    localController,
    remoteCrosshairs,
    watcherCrosshairPos,
    watcherOrbitPhases,
    watcherOrbitParams,
    logThrottled,
    interpolateToward,
    nextReadyCombined,
    maybeSendAimUpdate,
    aimCannons,
  } = deps;

  const remaining: typeof state.cannonballs = [];
  for (const ball of state.cannonballs) {
    const hit = advanceCannonball(ball, dt);
    if (hit) {
      battleAnim.impacts.push({ ...hit, age: 0 });
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

  for (const [pid, target] of remoteCrosshairs) {
    const player = state.players[pid];
    if (!isPlayerAlive(player)) continue;
    if (!canPlayerFire(state, pid)) continue;

    let visualPos = watcherCrosshairPos.get(pid);
    if (!visualPos) {
      visualPos = { x: target.x, y: target.y };
      watcherCrosshairPos.set(pid, visualPos);
    }

    const orbitParams =
      state.battleCountdown > 0 ? watcherOrbitParams.get(pid) : undefined;
    const newPhase = updateOrbitCrosshair(
      visualPos,
      target,
      orbitParams,
      watcherOrbitPhases.get(pid) ?? orbitParams?.phase ?? 0,
      dt,
      REMOTE_CROSSHAIR_SPEED,
      interpolateToward,
    );
    if (orbitParams) watcherOrbitPhases.set(pid, newPhase);

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
    onlinePlayerId,
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
    frame,
    dt,
    onlinePlayerId,
    localController,
    remoteCannonPhantoms,
    lastSentCannonPhantom,
    sendOpponentCannonPhantom,
  } = deps;

  const defaultFacings = new Map<number, number>();
  for (const player of state.players) {
    defaultFacings.set(player.id, player.defaultFacing);
  }
  frame.phantoms = {
    cannonPhantoms: filterAlivePhantoms(remoteCannonPhantoms, state.players),
    defaultFacings,
  };

  if (!localController) return;

  const phantom = localController.cannonTick(state, dt);
  if (!phantom) return;

  frame.phantoms.cannonPhantoms!.push(phantom);
  if (!lastSentCannonPhantom.changed(onlinePlayerId, cannonPhantomKey(phantom)))
    return;
  sendOpponentCannonPhantom({
    playerId: onlinePlayerId,
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
    frame,
    dt,
    localController,
    remotePiecePhantoms,
    lastSentPiecePhantom,
    sendOpponentPiecePhantom,
  } = deps;

  frame.phantoms = {
    piecePhantoms: filterAlivePhantoms(remotePiecePhantoms, state.players),
  };

  if (!localController) return;

  const phantoms = localController.buildTick(state, dt);
  for (const phantom of phantoms) {
    frame.phantoms.piecePhantoms!.push({
      offsets: phantom.offsets,
      row: phantom.row,
      col: phantom.col,
      valid: phantom.valid,
      playerId: phantom.playerId,
    });

    if (
      !lastSentPiecePhantom.changed(phantom.playerId, piecePhantomKey(phantom))
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

/** Interpolate a crosshair toward its target, applying orbital wobble when orbit params are present. */
function updateOrbitCrosshair(
  visualPos: PixelPos,
  target: PixelPos,
  orbitParams: OrbitParams | undefined,
  phase: number,
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
    const rx = orbitParams.rx + Math.sin(phase * ORBIT_FREQ_X);
    const ry = orbitParams.ry + Math.sin(phase * ORBIT_FREQ_Y);
    const next = phase + orbitParams.speed * dt;
    interpolateToward(
      visualPos,
      target.x + Math.cos(next) * rx,
      target.y + Math.sin(next) * ry,
      speed,
      dt,
    );
    return next;
  }
  interpolateToward(visualPos, target.x, target.y, speed, dt);
  return phase;
}

/** Tick the local player's battle crosshair and send aim updates. */
function tickLocalBattle(
  state: GameState,
  frame: WatcherBattleFrame,
  dt: number,
  onlinePlayerId: number,
  localController: PlayerController | null,
  nextReadyCombined: (state: GameState, playerId: number) => unknown,
  maybeSendAimUpdate: (x: number, y: number) => void,
  aimCannons: (
    state: GameState,
    playerId: number,
    x: number,
    y: number,
    dt: number,
  ) => void,
): void {
  if (!localController) return;

  localController.battleTick(state, dt);
  const ch = localController.getCrosshair();

  if (canPlayerFire(state, onlinePlayerId)) {
    const readyCannon = nextReadyCombined(state, onlinePlayerId);
    frame.crosshairs.push({
      x: ch.x,
      y: ch.y,
      playerId: onlinePlayerId,
      cannonReady: state.battleCountdown <= 0 && !!readyCannon,
    });
  }

  maybeSendAimUpdate(ch.x, ch.y);
  aimCannons(state, onlinePlayerId, ch.x, ch.y, dt);
}
