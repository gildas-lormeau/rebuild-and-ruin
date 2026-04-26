import {
  aimCannons,
  canPlayerFire,
  nextReadyCombined,
  tickBattlePhase,
} from "../game/index.ts";
import { recordBattleVisualEvents } from "../runtime/runtime-battle-anim.ts";
import { tickRemoteCrosshair } from "../runtime/runtime-crosshair-anim.ts";
import type {
  Crosshair,
  Impact,
  ThawingTile,
} from "../shared/core/battle-types.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import {
  type CannonPhantom,
  cannonPhantomKey,
  type DedupChannel,
  type PiecePhantom,
  phantomWireMode,
  piecePhantomKey,
} from "../shared/core/phantom-types.ts";
import type {
  PlayerSlotId,
  ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";

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
  maybeSendAimUpdate: (x: number, y: number) => void;
}

interface TickWatcherCannonPhantomsDeps {
  state: GameState;
  dt: number;
  myPlayerId: PlayerSlotId;
  localController: PlayerController | null;
  lastSentCannonPhantom: DedupChannel;
  sendOpponentCannonPhantom: (msg: CannonPhantom) => void;
}

interface TickWatcherBuildPhantomsDeps {
  state: GameState;
  dt: number;
  localController: PlayerController | null;
  lastSentPiecePhantom: DedupChannel;
  sendOpponentPiecePhantom: (msg: PiecePhantom) => void;
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
    maybeSendAimUpdate,
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
  recordBattleVisualEvents(result, battleAnim);

  frame.crosshairs = [];
  logThrottled(
    "watcher-ch-map",
    `tickWatcher battle: remoteCrosshairs keys=[${[...remoteCrosshairs.keys()]}] cannons=[${state.players.map((player, i) => `P${i}:${player.cannons.length}`).join(",")}]`,
  );

  for (const [rawPid, target] of remoteCrosshairs) {
    const pid = rawPid as ValidPlayerSlot;
    const visualPos = tickRemoteCrosshair(
      pid,
      target,
      state,
      dt,
      watcherCrosshairPos,
    );
    if (!visualPos) continue;
    frame.crosshairs.push({
      x: visualPos.x,
      y: visualPos.y,
      playerId: pid,
      cannonReady:
        state.battleCountdown <= 0 && !!nextReadyCombined(state, pid),
    });
  }

  tickLocalBattle(
    state,
    frame,
    dt,
    myPlayerId,
    localController,
    maybeSendAimUpdate,
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
    lastSentCannonPhantom,
    sendOpponentCannonPhantom,
  } = deps;

  // Remote phantoms live on each remote-controlled slot's controller
  // (`currentCannonPhantom`), written by the inbound network handler.
  // Render reads them via `buildCannonPhantomsUnion`. Eliminated-player
  // filtering also happens at the read site.

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
    lastSentPiecePhantom,
    sendOpponentPiecePhantom,
  } = deps;

  // Remote phantoms live on each remote-controlled slot's controller
  // (`currentBuildPhantoms`), written by the inbound network handler.
  // Render reads them via `buildPiecePhantomsUnion`. Eliminated-player
  // filtering also happens at the read site.

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
  maybeSendAimUpdate: (x: number, y: number) => void,
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
  aimCannons(state, pid, ch.x, ch.y);
}
