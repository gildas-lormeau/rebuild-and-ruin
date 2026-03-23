import { countdownAnnouncement } from "./battle-system.ts";
import { type CannonPhantom, cannonPhantomKey, type HumanPiecePhantom, type PiecePhantom, piecePhantomKey } from "./online-types.ts";
import type { Crosshair, OrbitParams, PlayerController } from "./player-controller.ts";
import type { GameState, Impact } from "./types.ts";
import { BATTLE_TIMER, Phase } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Multiplier for remote crosshair interpolation speed (faster than local). */
const REMOTE_CROSSHAIR_MULT = 2;
/** Orbital idle wobble frequency on X axis. */
const ORBIT_FREQ_X = 0.23;
/** Orbital idle wobble frequency on Y axis. */
const ORBIT_FREQ_Y = 0.19;

// ---------------------------------------------------------------------------
// Watcher timing state + timer tick
// ---------------------------------------------------------------------------

export interface WatcherTimingState {
  phaseStartTime: number;
  phaseDuration: number;
  countdownStartTime: number;
  countdownDuration: number;
}

interface WatcherFrameAnnouncement {
  announcement?: string;
}

export function tickWatcherTimers(
  state: GameState,
  frame: WatcherFrameAnnouncement,
  timing: WatcherTimingState,
  now: () => number,
): void {
  if (state.phase === Phase.CANNON_PLACE || state.phase === Phase.WALL_BUILD) {
    const elapsed = Math.max(0, (now() - timing.phaseStartTime) / 1000);
    state.timer = Math.max(0, timing.phaseDuration - elapsed);
    return;
  }

  if (state.phase !== Phase.BATTLE) return;

  if (timing.countdownDuration > 0) {
    const elapsed = Math.max(0, (now() - timing.countdownStartTime) / 1000);
    state.battleCountdown = Math.max(0, timing.countdownDuration - elapsed);

    frame.announcement = countdownAnnouncement(state.battleCountdown);
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


// ---------------------------------------------------------------------------
// Watcher battle phase tick
// ---------------------------------------------------------------------------

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
  remoteCrosshairs: Map<number, { x: number; y: number }>;
  watcherCrosshairPos: Map<number, { x: number; y: number }>;
  watcherIdlePhases: Map<number, number>;
  watcherOrbitParams: Map<number, OrbitParams>;
  crosshairSpeed: number;
  tileSize: number;
  logThrottled: (key: string, msg: string) => void;
  interpolateToward: (
    vis: { x: number; y: number },
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
    tileSize,
    logThrottled,
    interpolateToward,
    nextReadyCombined,
    maybeSendAimUpdate,
    aimCannons,
  } = deps;

  const remaining: typeof state.cannonballs = [];
  for (const ball of state.cannonballs) {
    const dx = ball.targetX - ball.x;
    const dy = ball.targetY - ball.y;
    const dist = Math.hypot(dx, dy);
    const move = ball.speed * dt;
    if (dist <= move) {
      battleAnim.impacts.push({
        row: Math.floor(ball.targetY / tileSize),
        col: Math.floor(ball.targetX / tileSize),
        age: 0,
      });
    } else {
      ball.x += (dx / dist) * move;
      ball.y += (dy / dist) * move;
      remaining.push(ball);
    }
  }
  state.cannonballs = remaining;

  frame.crosshairs = [];
  logThrottled(
    "watcher-ch-map",
    `tickWatcher battle: remoteCrosshairs keys=[${[...remoteCrosshairs.keys()]}] cannons=[${state.players.map((p, i) => `P${i}:${p.cannons.length}`).join(",")}]`,
  );

  for (const [pid, target] of remoteCrosshairs) {
    const player = state.players[pid];
    if (!player || player.eliminated) continue;

    const hasAliveCannon = player.cannons.some((c) => c.hp > 0 && !c.balloon);
    if (!hasAliveCannon && !state.cannonballs.some((b) => b.playerId === pid)) {
      continue;
    }

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
        interpolateToward(vis, target.x, target.y, crosshairSpeed * REMOTE_CROSSHAIR_MULT, dt);
      }
    } else {
      interpolateToward(vis, target.x, target.y, crosshairSpeed * REMOTE_CROSSHAIR_MULT, dt);
    }

    frame.crosshairs.push({
      x: vis.x,
      y: vis.y,
      playerId: pid,
      cannonReady: state.battleCountdown <= 0,
    });
    aimCannons(state, pid, vis.x, vis.y, dt);
  }

  if (!myHuman) return;

  myHuman.battleTick(state, dt);
  const ch = myHuman.getCrosshair();
  if (!ch) return;

  const readyCannon = nextReadyCombined(state, myPlayerId);
  const anyReloading =
    !readyCannon &&
    state.cannonballs.some(
      (b) => b.playerId === myPlayerId || b.scoringPlayerId === myPlayerId,
    );

  if (readyCannon || anyReloading) {
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

// ---------------------------------------------------------------------------
// Watcher phantom phases (cannon + build)
// ---------------------------------------------------------------------------

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
  remoteCannonPhantoms: CannonPhantom[];
  lastSentCannonPhantom: Map<number, string>;
  sendOpponentCannonPhantom: (msg: {
    playerId: number;
    row: number;
    col: number;
    mode: "normal" | "super" | "balloon";
    valid: boolean;
    facing: number;
  }) => void;
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
    aiCannonPhantoms: remoteCannonPhantoms.filter(
      (p) => !state.players[p.playerId]?.eliminated,
    ),
  };

  if (!myHuman) return;

  const phantom = myHuman.cannonTick(state, dt);
  if (!phantom) return;

  frame.phantoms.aiCannonPhantoms!.push(phantom);
  const key = cannonPhantomKey(phantom);
  if (lastSentCannonPhantom.get(myPlayerId) === key) return;

  lastSentCannonPhantom.set(myPlayerId, key);
  sendOpponentCannonPhantom({
    playerId: myPlayerId,
    row: phantom.row,
    col: phantom.col,
    mode: phantom.isSuper ? "super" : phantom.isBalloon ? "balloon" : "normal",
    valid: phantom.valid,
    facing: phantom.facing ?? 0,
  });
}

interface TickWatcherBuildPhantomsDeps {
  state: GameState;
  frame: WatcherPhantomFrame;
  dt: number;
  myHuman: PlayerController | null;
  remotePiecePhantoms: PiecePhantom[];
  lastSentPiecePhantom: Map<number, string>;
  sendOpponentPiecePhantom: (msg: {
    playerId: number;
    row: number;
    col: number;
    offsets: [number, number][];
    valid: boolean;
  }) => void;
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
    aiPhantoms: remotePiecePhantoms.filter(
      (p) => !state.players[p.playerId]?.eliminated,
    ),
    humanPhantoms: [],
  };

  if (!myHuman) return;

  const phantoms = myHuman.buildTick(state, dt);
  for (const p of phantoms) {
    frame.phantoms.humanPhantoms!.push({
      offsets: p.offsets,
      row: p.row,
      col: p.col,
      valid: p.valid,
      playerId: p.playerId,
    });

    const key = piecePhantomKey(p);
    if (lastSentPiecePhantom.get(p.playerId) === key) continue;

    lastSentPiecePhantom.set(p.playerId, key);
    sendOpponentPiecePhantom({
      playerId: p.playerId,
      row: p.row,
      col: p.col,
      offsets: p.offsets,
      valid: p.valid,
    });
  }
}
