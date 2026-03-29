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
  type CannonPhantom,
  cannonPhantomKey,
  filterAlivePhantoms,
  type HumanPiecePhantom,
  type PiecePhantom,
  phantomChanged,
  phantomWireMode,
  piecePhantomKey,
  type WatcherTimingState,
} from "./online-types.ts";
import {
  type CannonMode,
  type GameState,
  type Impact,
  isPlacementPhase,
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

/** Multiplier for remote crosshair interpolation speed (faster than local). */
const REMOTE_CROSSHAIR_MULT = 2;
/** Orbital idle wobble frequency on X axis. */
const ORBIT_FREQ_X = 0.23;
/** Orbital idle wobble frequency on Y axis. */
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
      timing.phaseStartTime =
        timing.countdownStartTime + timing.countdownDuration * 1000;
      timing.phaseDuration = BATTLE_TIMER;
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
    if (!player || player.eliminated) continue;

    if (!canPlayerFire(state, pid)) continue;

    let vis = watcherCrosshairPos.get(pid);
    if (!vis) {
      vis = { x: target.x, y: target.y };
      watcherCrosshairPos.set(pid, vis);
    }

    if (state.battleCountdown > 0) {
      const op = watcherOrbitParams.get(pid);
      if (op) {
        let phase = watcherIdlePhases.get(pid) ?? op.phase;
        const rx = op.rx + Math.sin(phase * ORBIT_FREQ_X);
        const ry = op.ry + Math.sin(phase * ORBIT_FREQ_Y);
        phase += op.speed * dt;
        watcherIdlePhases.set(pid, phase);
        interpolateToward(
          vis,
          target.x + Math.cos(phase) * rx,
          target.y + Math.sin(phase) * ry,
          crosshairSpeed * REMOTE_CROSSHAIR_MULT,
          dt,
        );
      } else {
        interpolateToward(
          vis,
          target.x,
          target.y,
          crosshairSpeed * REMOTE_CROSSHAIR_MULT,
          dt,
        );
      }
    } else {
      interpolateToward(
        vis,
        target.x,
        target.y,
        crosshairSpeed * REMOTE_CROSSHAIR_MULT,
        dt,
      );
    }

    frame.crosshairs.push({
      x: vis.x,
      y: vis.y,
      playerId: pid,
      cannonReady:
        state.battleCountdown <= 0 && !!nextReadyCombined(state, pid),
    });
    aimCannons(state, pid, vis.x, vis.y, dt);
  }

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
    !phantomChanged(
      lastSentCannonPhantom,
      myPlayerId,
      cannonPhantomKey(phantom),
    )
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
      !phantomChanged(
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
