import {
  advanceCannonball,
  canPlayerFire,
  getCountdownAnnouncement,
} from "./battle-system.ts";
import type {
  Crosshair,
  OrbitParams,
  PlayerController,
} from "./controller-interfaces.ts";
import { BATTLE_TIMER } from "./game-constants.ts";
import type { PixelPos } from "./geometry-types.ts";
import {
  REMOTE_CROSSHAIR_MULT,
  startWatcherPhaseTimer,
  type WatcherTimingState,
} from "./online-types.ts";
import {
  type CannonPhantom,
  cannonPhantomKey,
  dedupChanged,
  filterAlivePhantoms,
  type HumanPiecePhantom,
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
  myPlayerId: number;
  myHuman: PlayerController | null;
  remoteCrosshairs: Map<number, PixelPos>;
  watcherCrosshairPos: Map<number, PixelPos>;
  watcherIdlePhases: Map<number, number>;
  watcherOrbitParams: Map<number, OrbitParams>;
  crosshairSpeed: number;
  logThrottled: (key: string, msg: string) => void;
  interpolateToward: (
    vis: PixelPos,
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
    aiCannonPhantoms?: CannonPhantom[];
    aiPhantoms?: PiecePhantom[];
    humanPhantoms?: HumanPiecePhantom[];
  };
}

interface TickWatcherCannonPhantomsDeps {
  state: GameState;
  frame: WatcherPhantomFrame;
  dt: number;
  myPlayerId: number;
  myHuman: PlayerController | null;
  remoteCannonPhantoms: readonly CannonPhantom[];
  lastSentCannonPhantom: Map<number, string>;
  sendOpponentCannonPhantom: (msg: {
    playerId: number;
    row: number;
    col: number;
    mode: CannonMode;
    valid: boolean;
    facing: number;
  }) => void;
}

interface TickWatcherBuildPhantomsDeps {
  state: GameState;
  frame: WatcherPhantomFrame;
  dt: number;
  myHuman: PlayerController | null;
  remotePiecePhantoms: readonly PiecePhantom[];
  lastSentPiecePhantom: Map<number, string>;
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
      startWatcherPhaseTimer(
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
    myPlayerId,
    myHuman,
    remoteCrosshairs,
    watcherCrosshairPos,
    watcherIdlePhases,
    watcherOrbitParams,
    crosshairSpeed,
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

    let vis = watcherCrosshairPos.get(pid);
    if (!vis) {
      vis = { x: target.x, y: target.y };
      watcherCrosshairPos.set(pid, vis);
    }

    const op =
      state.battleCountdown > 0 ? watcherOrbitParams.get(pid) : undefined;
    const newPhase = updateOrbitCrosshair(
      vis,
      target,
      op,
      watcherIdlePhases.get(pid) ?? op?.phase ?? 0,
      dt,
      crosshairSpeed * REMOTE_CROSSHAIR_MULT,
      interpolateToward,
    );
    if (op) watcherIdlePhases.set(pid, newPhase);

    frame.crosshairs.push({
      x: vis.x,
      y: vis.y,
      playerId: pid,
      cannonReady:
        state.battleCountdown <= 0 && !!nextReadyCombined(state, pid),
    });
    aimCannons(state, pid, vis.x, vis.y, dt);
  }

  tickLocalHumanBattle(
    state,
    frame,
    dt,
    myPlayerId,
    myHuman,
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
    myPlayerId,
    myHuman,
    remoteCannonPhantoms,
    lastSentCannonPhantom,
    sendOpponentCannonPhantom,
  } = deps;

  frame.phantoms = {
    aiCannonPhantoms: filterAlivePhantoms(remoteCannonPhantoms, state.players),
  };

  if (!myHuman) return;

  const phantom = myHuman.cannonTick(state, dt);
  if (!phantom) return;

  frame.phantoms.aiCannonPhantoms!.push(phantom);
  if (
    !dedupChanged(lastSentCannonPhantom, myPlayerId, cannonPhantomKey(phantom))
  )
    return;
  sendOpponentCannonPhantom({
    playerId: myPlayerId,
    row: phantom.row,
    col: phantom.col,
    mode: phantomWireMode(phantom),
    valid: phantom.valid,
    facing: phantom.facing ?? 0,
  });
}

export function tickWatcherBuildPhantomsPhase(
  deps: TickWatcherBuildPhantomsDeps,
): void {
  const {
    state,
    frame,
    dt,
    myHuman,
    remotePiecePhantoms,
    lastSentPiecePhantom,
    sendOpponentPiecePhantom,
  } = deps;

  frame.phantoms = {
    aiPhantoms: filterAlivePhantoms(remotePiecePhantoms, state.players),
    humanPhantoms: [],
  };

  if (!myHuman) return;

  const phantoms = myHuman.buildTick(state, dt);
  for (const phantom of phantoms) {
    frame.phantoms.humanPhantoms!.push({
      offsets: phantom.offsets,
      row: phantom.row,
      col: phantom.col,
      valid: phantom.valid,
      playerId: phantom.playerId,
    });

    if (
      !dedupChanged(
        lastSentPiecePhantom,
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

/** Interpolate a crosshair toward its target, applying orbital wobble when orbit params are present. */
function updateOrbitCrosshair(
  vis: PixelPos,
  target: PixelPos,
  op: OrbitParams | undefined,
  phase: number,
  dt: number,
  speed: number,
  interpolateToward: (
    vis: PixelPos,
    tx: number,
    ty: number,
    speed: number,
    dt: number,
  ) => void,
): number {
  if (op) {
    const rx = op.rx + Math.sin(phase * ORBIT_FREQ_X);
    const ry = op.ry + Math.sin(phase * ORBIT_FREQ_Y);
    const next = phase + op.speed * dt;
    interpolateToward(
      vis,
      target.x + Math.cos(next) * rx,
      target.y + Math.sin(next) * ry,
      speed,
      dt,
    );
    return next;
  }
  interpolateToward(vis, target.x, target.y, speed, dt);
  return phase;
}

/** Tick the local human player's battle crosshair and send aim updates. */
function tickLocalHumanBattle(
  state: GameState,
  frame: WatcherBattleFrame,
  dt: number,
  myPlayerId: number,
  myHuman: PlayerController | null,
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
  if (!myHuman) return;

  myHuman.battleTick(state, dt);
  const ch = myHuman.getCrosshair();

  if (canPlayerFire(state, myPlayerId)) {
    const readyCannon = nextReadyCombined(state, myPlayerId);
    frame.crosshairs.push({
      x: ch.x,
      y: ch.y,
      playerId: myPlayerId,
      cannonReady: state.battleCountdown <= 0 && !!readyCannon,
    });
  }

  maybeSendAimUpdate(ch.x, ch.y);
  aimCannons(state, myPlayerId, ch.x, ch.y, dt);
}
