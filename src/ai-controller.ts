/**
 * AiController — AI player behavior: tower selection, piece placement,
 * cannon placement, and battle targeting via pluggable strategy.
 */

import type { AiStrategy, ChainType } from "./ai-strategy.ts";
import {
  Chain,
  DefaultStrategy,
} from "./ai-strategy.ts";
import {
  aimCannons,
  nextReadyCombined,
} from "./battle-system.ts";
import {
  canPlaceCannon,
  placeCannon,
} from "./cannon-system.ts";
import type {
  PixelPos,
  StrategicPixelPos,
  TilePos,
} from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import { placePiece } from "./phase-build.ts";
import type { PieceShape } from "./pieces.ts";
import { rotateCW } from "./pieces.ts";
import {
  BaseController,
  CROSSHAIR_SPEED,
  type OrbitParams,
  type PhantomCannon,
  type PhantomPiece,
} from "./player-controller.ts";
import { packTile } from "./spatial.ts";
import type { GameState, Player } from "./types.ts";
import { CannonMode } from "./types.ts";

/** AI build-phase cursor speed in tiles per second. */
const BUILD_CURSOR_SPEED = 12;
/** AI cannon-phase cursor speed in tiles per second. */
const CANNON_CURSOR_SPEED = 6;

/** Normalized key for a piece shape (origin-independent). */
function pieceKey(p: PieceShape): string {
  const minR = Math.min(...p.offsets.map((o) => o[0]));
  const minC = Math.min(...p.offsets.map((o) => o[1]));
  return [...p.offsets]
    .map(([r, c]) => [r - minR, c - minC] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((o) => `${o[0]},${o[1]}`)
    .join(";");
}

/** Check if two pieces have the same shape (ignoring position). */
function sameShape(a: PieceShape, b: PieceShape): boolean {
  return pieceKey(a) === pieceKey(b);
}

export class AiController extends BaseController {
  /** Pluggable AI strategy (decision-making). */
  private strategy: AiStrategy;

  /** Pending placement result (piece + target position). */
  private pendingPlace: ({ piece: PieceShape } & TilePos) | null =
    null;
  /** Think timer: pause before confirming tower selection. */
  private selectThink = 0;
  /** Queue of tower indices to "browse" before confirming. */
  private selectBrowseQueue: number[] = [];
  /** Dwell time on each browsed tower. */
  private selectBrowseDwell = 0;
  /** Dwell timer: cursor sits on target before placing. */
  private buildDwell = 0;
  /** Think timer: pause after placing before computing next. */
  private buildThink = 0;
  /** Whether we already retried this placement after a grunt blocked it. */
  private buildRetried = false;
  /** True when no placement is possible — stop trying for the rest of the build phase. */
  private buildGaveUp = false;
  /** Pre-computed rotation sequence (each entry is a piece to display, last one = final). */
  private rotationSeq: PieceShape[] = [];
  /** Index into rotationSeq. */
  private rotationIdx = 0;
  /** Timer for each rotation step. */
  private rotationTimer = 0;

  /** Cannon placement queue (pre-computed positions to place one by one). */
  private cannonQueue: {
    row: number;
    col: number;
    mode?: CannonMode.SUPER | CannonMode.BALLOON;
  }[] = [];
  /** Cannon placement dwell timer. */
  private cannonDwell = 0;
  /** Cannon placement think timer. */
  private cannonThink = 0;
  /** Mode-switch dwell: pause at current position while phantom changes type. */
  private modeSwitchDwell = 0;
  /** The cannon mode currently shown in the phantom (tracks mode transitions). */
  private displayedCannonMode: CannonMode.SUPER | CannonMode.BALLOON | undefined;
  /** Max cannon slots for current phase. */
  private cannonMaxSlots = 0;

  /** Current crosshair target (pixels). strategic = wall between obstacles. */
  private crosshairTarget: StrategicPixelPos | null = null;
  /** Dwell timer: crosshair sits on target for this duration before firing. */
  private dwellTimer = 0;
  /** Post-fire "thinking" delay before moving to next target. */
  private thinkTimer = 0;
  /** Chain attack plan: sequence of tiles to rapid-fire at (walls or grunts). */
  private chainTargets: TilePos[] | null = null;
  /** Current index into chainTargets. */
  private chainIdx = 0;
  /** Dwell on each chain target before firing. */
  private chainDwell = 0;
  /** Type of chain attack: 'wall' skips destroyed enemy walls, 'pocket' skips destroyed own walls, 'grunt' always fires. */
  private chainType: ChainType = Chain.WALL;

  override getCrosshairTarget(): PixelPos | null { return this.crosshairTarget; }
  override getOrbitParams(): OrbitParams | null {
    return this.idleInitialized ? { rx: this.idleRx, ry: this.idleRy, speed: this.idleSpeed, phase: this.idlePhase } : null;
  }

  /** Idle circle phase for pre-battle cursor orbit. */
  private idlePhase = 0;
  /** Per-AI orbit shape randomized once per countdown. */
  private idleRx = 6;
  private idleRy = 6;
  private idleSpeed = Math.PI * 4;
  private idleInitialized = false;

  /** When true, castle rects hug the river bank (plug approach).
   *  When false (default), rects shrink at bank corners (tighter ring). */
  get bankHugging(): boolean { return this.strategy.bankHugging; }
  set bankHugging(v: boolean) { this.strategy.bankHugging = v; }

  /** Delay multiplier derived from thinkingSpeed: 1=slow(1.4×), 2=normal(1×), 3=fast(0.65×). */
  private get delayScale(): number {
    return [1.4, 1.0, 0.65][this.strategy.thinkingSpeed - 1]!;
  }

  /** Distance threshold (tiles) below which the cursor uses 1× instead of 2× speed.
   *  cursorSkill 1=8 (rarely boosts), 2=5 (default), 3=3 (boosts early). */
  private get boostThreshold(): number {
    return [8, 5, 3][this.strategy.cursorSkill - 1]!;
  }

  /** Battle boost threshold in pixels.
   *  cursorSkill 1=never boosts (Infinity), 2=always (0, default), 3=always (0). */
  private get battleBoostDist(): number {
    // Level 1: no 2× speed boost (always 1×). Levels 2–3: always 2× (threshold 0).
    return this.strategy.cursorSkill === 1 ? Infinity : 0;
  }

  /** Whether the AI pre-picks next target while firing (cursorSkill >= 2). */
  private get anticipatesTarget(): boolean {
    return this.strategy.cursorSkill >= 2;
  }

  private scaledDelay(base: number, spread: number): number {
    return (base + this.strategy.rng.next() * spread) * this.delayScale;
  }

  private clearChainPlan(): void {
    this.chainTargets = null;
    this.chainIdx = 0;
    this.chainDwell = 0;
    this.crosshairTarget = null;
  }


  constructor(playerId: number, strategy?: AiStrategy) {
    super(playerId);
    this.strategy = strategy ?? new DefaultStrategy();
    this.idlePhase = this.strategy.rng.next() * Math.PI * 2;
  }

  override selectTower(state: GameState, zone: number): boolean {
    const player = state.players[this.playerId]!;
    const chosenTower = this.strategy.selectTower(state.map, zone);

    // Build browse queue: visit 1-3 random zone towers before the chosen one
    const zoneTowers = state.map.towers.filter(t => t.zone === zone);
    const others = zoneTowers.filter(t => t !== chosenTower);
    const browseCount = Math.min(others.length, 1 + Math.floor(this.strategy.rng.next() * 3));
    // Shuffle and take browseCount
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(this.strategy.rng.next() * (i + 1));
      [others[i], others[j]] = [others[j]!, others[i]!];
    }
    this.selectBrowseQueue = others.slice(0, browseCount).map(t => t.index);
    if (chosenTower) this.selectBrowseQueue.push(chosenTower.index);
    this.selectBrowseDwell = this.scaledDelay(0.8, 0.6);

    // Confirm delay after landing on chosen tower
    this.selectThink = this.scaledDelay(1.0, 0.6);

    // Start at first tower in browse queue
    const firstIdx = this.selectBrowseQueue[0];
    const firstTower = firstIdx !== undefined ? state.map.towers[firstIdx] : chosenTower;
    if (firstTower) {
      player.homeTower = firstTower;
      player.ownedTowers = [firstTower];
    }
    return false;
  }

  override selectionTick(dt: number, state?: GameState): boolean {
    this.selectBrowseDwell -= dt;
    if (this.selectBrowseDwell <= 0 && this.selectBrowseQueue.length > 1) {
      // Move to next tower in browse queue
      this.selectBrowseQueue.shift();
      this.selectBrowseDwell = this.scaledDelay(0.8, 0.6);
      // Update player's homeTower so the highlight follows
      if (state) {
        const nextIdx = this.selectBrowseQueue[0];
        const nextTower = nextIdx !== undefined ? state.map.towers[nextIdx] : undefined;
        if (nextTower) {
          state.players[this.playerId]!.homeTower = nextTower;
          state.players[this.playerId]!.ownedTowers = [nextTower];
        }
      }
      return false;
    }
    if (this.selectBrowseQueue.length <= 1) {
      this.selectThink -= dt;
      return this.selectThink <= 0;
    }
    return false;
  }

  override onLifeLost(): void {
    super.onLifeLost();
    this.resetAiState();
    this.strategy.onLifeLost();
  }

  private resetAiState(): void {
    this.selectThink = 0;
    this.pendingPlace = null;
    this.buildDwell = 0;
    this.buildThink = 0;
    this.buildRetried = false;
    this.buildGaveUp = false;
    this.rotationSeq = [];
    this.rotationIdx = 0;
    this.rotationTimer = 0;
    this.cannonQueue = [];
    this.cannonDwell = 0;
    this.cannonThink = 0;
    this.cannonMaxSlots = 0;
    this.crosshairTarget = null;
    this.dwellTimer = 0;
    this.thinkTimer = 0;
    this.chainTargets = null;
    this.chainIdx = 0;
    this.chainDwell = 0;
    this.chainType = Chain.WALL;
    this.idleInitialized = false;
  }

  override reselect(state: GameState, zone: number): boolean {
    return this.selectTower(state, zone);
  }

  override placeCannons(state: GameState, maxSlots: number): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    this.cannonQueue = this.strategy.placeCannons(player, maxSlots, state);
    this.cannonMaxSlots = maxSlots;
    this.cannonDwell = 0;
    this.modeSwitchDwell = 0;
    this.displayedCannonMode = undefined; // start as normal cannon
    this.cannonThink = this.scaledDelay(0.3, 0.4); // initial think delay
  }

  override isCannonPhaseDone(_state: GameState, _maxSlots: number): boolean {
    return this.cannonQueue.length === 0 && this.cannonDwell <= 0;
  }

  startBuild(state: GameState): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    this.initBag(state.round, state.rng);
    this.pendingPlace = null;
    this.buildDwell = 0;
    this.buildThink = 0;
    this.buildRetried = false;
    this.buildGaveUp = false;
    // Center cursor on home tower
    if (player.homeTower) {
      this.buildCursor = {
        row: player.homeTower.row + 1,
        col: player.homeTower.col + 1,
      };
    }
    this.computeNextPlacement(state);
  }

  buildTick(state: GameState, dt: number): PhantomPiece[] {
    if (!this.currentPiece) return [];
    const player = state.players[this.playerId]!;
    if (player.eliminated) return [];

    // Clamp cursor so phantom never extends beyond the grid.
    // Use target piece dimensions when moving toward a placement (the target
    // position was computed for the rotated piece, not the bag orientation).
    const clampPiece = this.pendingPlace?.piece ?? this.currentPiece;
    this.clampBuildCursor(clampPiece);

    const thinkResult = this.buildTickThinkDelay(dt);
    if (thinkResult) return thinkResult;

    const gaveUpResult = this.buildTickGaveUp(dt, player, state);
    if (gaveUpResult) return gaveUpResult;

    const wasNull = !this.pendingPlace;
    if (wasNull) {
      this.computeNextPlacement(state);
    }
    if (!this.pendingPlace) {
      if (state.timer > 2) {
        // No placement found — retry after 1s (grunts may move and free space)
        this.buildThink = 1.0;
      } else {
        // Not enough time left — give up for this phase
        this.buildGaveUp = true;
      }
      return [
        this.makePhantom(
          this.currentPiece!,
          Math.round(this.buildCursor.row),
          Math.round(this.buildCursor.col),
          false,
        ),
      ];
    }
    const pendingPlace = this.pendingPlace;
    if (wasNull) {
      // Build rotation sequence from bag orientation → target orientation
      const bag = this.currentPiece!;
      if (sameShape(bag, pendingPlace.piece)) {
        this.rotationSeq = [];
        this.rotationIdx = 0;
      } else {
        this.rotationSeq = [bag];
        let cur = bag;
        for (let i = 0; i < 3; i++) {
          cur = rotateCW(cur);
          if (sameShape(cur, pendingPlace.piece)) {
            this.rotationSeq.push(pendingPlace.piece);
            break;
          }
          this.rotationSeq.push(cur);
        }
        this.rotationIdx = 0;
        this.rotationTimer = 0.15 + this.strategy.rng.next() * 0.1;
      }
    }
    const target = this.pendingPlace!;

    this.buildTickRotation(dt);

    const dwellResult = this.buildTickDwell(dt, target, state);
    if (dwellResult) return dwellResult;

    // Move cursor toward target (using final rotation)
    const dr = target.row - this.buildCursor.row;
    const dc = target.col - this.buildCursor.col;
    const dist = Math.sqrt(dr * dr + dc * dc);
    const speed = BUILD_CURSOR_SPEED * (dist > this.boostThreshold ? 2 : 1);
    const step = speed * dt;

    if (dist <= step) {
      this.buildCursor.row = target.row;
      this.buildCursor.col = target.col;
      // Only start dwell once rotation is also complete
      if (this.rotationIdx >= this.rotationSeq.length) {
        this.buildDwell = this.scaledDelay(0.2, 0.3);
      }
    } else {
      this.buildCursor.row += (dr / dist) * step;
      this.buildCursor.col += (dc / dist) * step;
    }

    // Show phantom at current cursor position — use current rotation frame.
    // Adjust position by pivot delta so the piece visually rotates around center.
    const movingPiece =
      this.rotationIdx < this.rotationSeq.length
        ? this.rotationSeq[
            Math.min(this.rotationIdx, this.rotationSeq.length - 1)
          ]!
        : target.piece;
    const pivotDr = target.piece.pivot[0] - movingPiece.pivot[0];
    const pivotDc = target.piece.pivot[1] - movingPiece.pivot[1];
    const curRow = Math.max(
      0,
      Math.min(
        Math.round(this.buildCursor.row) + pivotDr,
        GRID_ROWS - movingPiece.height,
      ),
    );
    const curCol = Math.max(
      0,
      Math.min(
        Math.round(this.buildCursor.col) + pivotDc,
        GRID_COLS - movingPiece.width,
      ),
    );
    return [
      this.makePhantom(
        movingPiece,
        curRow,
        curCol,
        curRow === target.row && curCol === target.col,
      ),
    ];
  }

  /** Handle "post-place think delay" state. Returns phantom array if in think state, null otherwise. */
  private buildTickThinkDelay(dt: number): PhantomPiece[] | null {
    if (this.buildThink <= 0) return null;
    this.buildThink -= dt;
    return [
      this.makePhantom(
        this.currentPiece!,
        Math.round(this.buildCursor.row),
        Math.round(this.buildCursor.col),
        false,
      ),
    ];
  }

  /** Handle "gave up" state — move cursor home, periodically retry. Returns phantom array if gave up, null otherwise. */
  private buildTickGaveUp(dt: number, player: Player, state: GameState): PhantomPiece[] | null {
    if (!this.buildGaveUp) return null;
    const homeR = player.homeTower
      ? player.homeTower.row + 1
      : this.buildCursor.row;
    const homeC = player.homeTower
      ? player.homeTower.col + 1
      : this.buildCursor.col;
    const dr = homeR - this.buildCursor.row;
    const dc = homeC - this.buildCursor.col;
    const dist = Math.sqrt(dr * dr + dc * dc);
    if (dist > 0.5) {
      const speed = 12 * dt;
      if (dist <= speed) {
        this.buildCursor.row = homeR;
        this.buildCursor.col = homeC;
      } else {
        this.buildCursor.row += (dr / dist) * speed;
        this.buildCursor.col += (dc / dist) * speed;
      }
    }
    // Periodically re-check — grunts may have moved and freed space
    this.buildThink -= dt;
    if (this.buildThink <= 0) {
      this.computeNextPlacement(state);
      if (this.pendingPlace) {
        // Found a spot — resume normal placement flow
        this.buildGaveUp = false;
      } else {
        this.buildThink = 1.0;
      }
    }
    return [
      this.makePhantom(
        this.currentPiece!,
        Math.round(this.buildCursor.row),
        Math.round(this.buildCursor.col),
        false,
      ),
    ];
  }

  /** Advance rotation animation (runs concurrently with movement). */
  private buildTickRotation(dt: number): void {
    if (this.rotationIdx < this.rotationSeq.length) {
      this.rotationTimer -= dt;
      if (this.rotationTimer <= 0) {
        this.rotationIdx++;
        if (this.rotationIdx < this.rotationSeq.length) {
          this.rotationTimer = 0.12 + this.strategy.rng.next() * 0.08;
        }
      }
    }
  }

  /** Handle "dwell on target then place" state. Returns phantom array if dwelling, null otherwise. */
  private buildTickDwell(dt: number, target: { piece: PieceShape } & TilePos, state: GameState): PhantomPiece[] | null {
    if (this.buildDwell <= 0) return null;
    this.buildDwell -= dt;
    if (this.buildDwell <= 0) {
      const placed = placePiece(
        state,
        this.playerId,
        target.piece,
        target.row,
        target.col,
      );
      if (placed) {
        this.advanceBag();
        this.pendingPlace = null;
        this.buildRetried = false;
        this.buildThink = this.scaledDelay(0.3, 0.4);
        return [];
      }
      // Placement blocked (e.g. grunt moved onto target)
      if (!this.buildRetried) {
        // Wait 1s then retry the same spot
        this.buildRetried = true;
        this.buildDwell = 1.0;
      } else {
        // Already retried — recompute for a different location
        this.buildRetried = false;
        this.pendingPlace = null;
        this.buildThink = 0.1;
      }
      return [];
    }
    // Show phantom at target while dwelling
    return [this.makePhantom(target.piece, target.row, target.col, true)];
  }

  endBuild(state: GameState): void {
    this.bag = null;
    this.currentPiece = null;
    this.pendingPlace = null;
    this.buildDwell = 0;
    this.buildThink = 0;
    this.strategy.assessBuildEnd(state, this.playerId);
  }

  /** Tick cannon placement animation. Returns phantom cannon data for rendering. */
  cannonTick(state: GameState, dt: number): PhantomCannon | null {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return null;

    // Post-place think delay
    if (this.cannonThink > 0) {
      this.cannonThink -= dt;
      return null;
    }

    if (this.cannonQueue.length === 0) return null;
    const target = this.cannonQueue[0]!;
    const targetMode = target.mode ?? CannonMode.NORMAL;
    const isSuper = targetMode === CannonMode.SUPER;
    const isBalloon = targetMode === CannonMode.BALLOON;

    // Mode switch: pause at current position while phantom changes type
    if (target.mode !== this.displayedCannonMode && this.modeSwitchDwell <= 0 && this.cannonDwell <= 0) {
      this.modeSwitchDwell = (0.25 + this.strategy.rng.next() * 0.2) * this.delayScale;
      this.displayedCannonMode = target.mode;
    }
    if (this.modeSwitchDwell > 0) {
      this.modeSwitchDwell -= dt;
      const curRow = Math.round(this.cannonCursor.row);
      const curCol = Math.round(this.cannonCursor.col);
      return {
        row: curRow,
        col: curCol,
        valid: false,
        isSuper,
        isBalloon,
        playerId: this.playerId,
        facing: player.defaultFacing,
      };
    }


    // Dwell on target then place
    if (this.cannonDwell > 0) {
      this.cannonDwell -= dt;
      if (this.cannonDwell <= 0) {
        // Place the cannon
        if (canPlaceCannon(player, target.row, target.col, targetMode, state)) {
          placeCannon(
            player,
            target.row,
            target.col,
            this.cannonMaxSlots,
            targetMode,
            state,
          );
        }
        this.cannonQueue.shift();
        this.cannonThink = this.scaledDelay(0.3, 0.4);
        return null;
      }
      // Show phantom at target while dwelling
      return {
        row: target.row,
        col: target.col,
        valid: true,
        isSuper,
        isBalloon,
        playerId: this.playerId,
        facing: player.defaultFacing,
      };
    }

    // Move cursor toward target
    const dr = target.row - this.cannonCursor.row;
    const dc = target.col - this.cannonCursor.col;
    const dist = Math.sqrt(dr * dr + dc * dc);
    const speed = CANNON_CURSOR_SPEED * (dist > this.boostThreshold ? 2 : 1);
    const step = speed * dt;

    if (dist <= step) {
      this.cannonCursor.row = target.row;
      this.cannonCursor.col = target.col;
      this.cannonDwell = this.scaledDelay(0.2, 0.3);
    } else {
      this.cannonCursor.row += (dr / dist) * step;
      this.cannonCursor.col += (dc / dist) * step;
    }

    // Show phantom at current cursor position (moving)
    const curRow = Math.round(this.cannonCursor.row);
    const curCol = Math.round(this.cannonCursor.col);
    const atTarget = curRow === target.row && curCol === target.col;
    return {
      row: curRow,
      col: curCol,
      valid: atTarget && canPlaceCannon(player, curRow, curCol, targetMode, state),
      isSuper,
      isBalloon,
      playerId: this.playerId,
      facing: player.defaultFacing,
    };
  }

  battleTick(state: GameState, dt: number): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    if (!nextReadyCombined(state, this.playerId)) return;

    const aimAt = this.crosshairTarget ?? this.crosshair;
    aimCannons(state, this.playerId, aimAt.x, aimAt.y, dt);
    if (state.battleCountdown > 0 || state.timer <= 0) {
      // If chain attack is planned, move toward first target during countdown
      if (
        this.chainTargets &&
        this.chainIdx < this.chainTargets.length &&
        state.battleCountdown > 0
      ) {
        const first = this.chainTargets[this.chainIdx]!;
        this.crosshairTarget = {
          x: (first.col + 0.5) * TILE_SIZE,
          y: (first.row + 0.5) * TILE_SIZE,
        };
      }
      this.moveCrosshair(state, dt);
      return;
    }

    if (this.battleTickChainAttack(state, dt)) return;
    this.battleTickStandardFire(state, dt);
  }

  /** Handle chain attack mode — rapid fire along pre-planned targets. Returns true if it handled this tick. */
  private battleTickChainAttack(state: GameState, dt: number): boolean {
    if (!this.chainTargets || this.chainIdx >= this.chainTargets.length) return false;

    // Dwell phase: brief pause on target before firing
    if (this.chainDwell > 0) {
      this.chainDwell -= dt;
      if (this.chainDwell <= 0) {
        const target = this.chainTargets[this.chainIdx]!;
        // Chain attacks use whatever cannon is ready next (including captured)
        const result = this.fireNext(state, target.row, target.col);
        if (result) {
          this.chainIdx++;
          if (this.chainIdx >= this.chainTargets.length) {
            this.clearChainPlan();
          }
        } else {
          // No cannon ready — wait a bit longer
          this.chainDwell = 0.05;
        }
      }
      return true;
    }
    const target = this.chainTargets[this.chainIdx]!;
    // For wall/pocket attacks, skip already-destroyed wall tiles
    if (this.chainType === Chain.WALL || this.chainType === Chain.POCKET) {
      const targetKey = packTile(target.row, target.col);
      let wallExists = false;
      if (this.chainType === Chain.POCKET) {
        // Pocket: check own walls
        wallExists = state.players[this.playerId]!.walls.has(targetKey);
      } else {
        // Wall demo: check enemy walls
        for (const other of state.players) {
          if (other.id !== this.playerId && other.walls.has(targetKey)) {
            wallExists = true;
            break;
          }
        }
      }
      if (!wallExists) {
        this.chainIdx++;
        if (this.chainIdx >= this.chainTargets.length) {
          this.clearChainPlan();
        }
        return true;
      }
    }
    // Move crosshair toward target
    const tx = (target.col + 0.5) * TILE_SIZE;
    const ty = (target.row + 0.5) * TILE_SIZE;
    if (this.stepCrosshairToward(tx, ty, dt)) {
      this.chainDwell = (0.2 + this.strategy.rng.next() * 0.1) * this.delayScale;
    }
    return true;
  }

  /** Handle standard target-picking, dwelling, and movement toward target. */
  private battleTickStandardFire(state: GameState, dt: number): void {
    // Post-fire thinking delay
    if (this.thinkTimer > 0) {
      this.thinkTimer -= dt;
      return;
    }

    // Pick a target if we don't have one
    if (!this.crosshairTarget) {
      this.crosshairTarget = this.strategy.pickTarget(
        state,
        this.playerId,
        this.crosshair,
      );
    }

    // Dwell on target then fire — only fire when a cannon is ready
    if (this.dwellTimer > 0 && this.crosshairTarget) {
      this.dwellTimer -= dt;
      if (this.dwellTimer <= 0) {
        const ready = nextReadyCombined(
          state,
          this.playerId,
          this.lastFiredIdx,
        );
        if (!ready) {
          // No cannon ready yet — keep dwelling until one reloads
          this.dwellTimer = 0.05;
          return;
        }
        this.fire(state);
        this.strategy.trackShot(state, this.playerId, this.crosshair);
        // Random thinking delay before picking next target
        this.thinkTimer = this.scaledDelay(0.1, 0.2);
        // Skilled AIs pre-pick next target while "thinking" (cursor starts moving)
        if (this.anticipatesTarget) {
          this.crosshairTarget = this.strategy.pickTarget(
            state,
            this.playerId,
            this.crosshair,
          );
        } else {
          this.crosshairTarget = null;
        }
      }
      return;
    }

    // Move crosshair toward target (x2 speed when far, x1 when close)
    if (this.crosshairTarget) {
      if (this.stepCrosshairToward(this.crosshairTarget.x, this.crosshairTarget.y, dt)) {
        this.dwellTimer = this.scaledDelay(0.15, 0.1);
      }
    }
  }

  resetBattle(state?: GameState): void {
    this.crosshairTarget = null;
    this.dwellTimer = 0;
    this.thinkTimer = 0;
    this.lastFiredIdx = -1;
    this.idleInitialized = false;

    // Reset crosshair to home tower so there's visible travel at battle start
    if (state) {
      const player = state.players[this.playerId];
      if (player?.homeTower) {
        this.centerOn(player.homeTower.row, player.homeTower.col);
      }
    }

    // Delegate battle planning to strategy
    this.chainTargets = null;
    this.chainIdx = 0;
    this.chainDwell = 0;
    this.chainType = Chain.WALL;
    if (state) {
      const plan = this.strategy.planBattle(state, this.playerId);
      this.chainTargets = plan.chainTargets;
      this.chainType = plan.chainType;
    }
  }

  flushCannons(state: GameState, maxSlots: number): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    for (const target of this.cannonQueue) {
      const mode = target.mode ?? CannonMode.NORMAL;
      if (canPlaceCannon(player, target.row, target.col, mode, state)) {
        placeCannon(player, target.row, target.col, maxSlots, mode, state);
      }
    }
    this.cannonQueue = [];
  }

  onBattleEnd(): void {}

  override reset(): void {
    super.reset();
    this.onLifeLost();
  }

  onCannonPhaseStart(): void {}

  /**
   * Move crosshair one step toward (tx, ty) at battle speed.
   * Returns true if it reached the target this frame.
   */
  private stepCrosshairToward(
    tx: PixelPos["x"],
    ty: PixelPos["y"],
    dt: number,
  ): boolean {
    const dx = tx - this.crosshair.x;
    const dy = ty - this.crosshair.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const speed = CROSSHAIR_SPEED * (dist > this.battleBoostDist ? 2 : 1);
    const step = speed * dt;
    if (dist <= step) {
      this.crosshair.x = tx;
      this.crosshair.y = ty;
      return true;
    }
    this.crosshair.x += (dx / dist) * step;
    this.crosshair.y += (dy / dist) * step;
    return false;
  }

  /** Move crosshair toward target without firing (used during countdown and after timer). */
  private moveCrosshair(state: GameState, dt: number): void {
    const player = state.players[this.playerId]!;
    if (player.eliminated) return;
    if (!this.crosshairTarget) {
      this.crosshairTarget = this.strategy.pickTarget(
        state,
        this.playerId,
        this.crosshair,
      );
    }
    if (this.crosshairTarget) {
      if (state.battleCountdown > 0) {
        // During countdown, move to target then orbit around it
        const dist = Math.hypot(
          this.crosshairTarget.x - this.crosshair.x,
          this.crosshairTarget.y - this.crosshair.y,
        );
        if (dist > 12) {
          this.stepCrosshairToward(this.crosshairTarget.x, this.crosshairTarget.y, dt);
        } else {
          if (!this.idleInitialized) {
            const strategic = !!this.crosshairTarget.strategic;
            const boost = strategic ? 1.2 : 1;
            const rng = this.strategy.rng;
            this.idleRx = (5 + rng.next() * 3) * boost;
            this.idleRy = (5 + rng.next() * 3) * boost;
            // Strategic targets: faster orbit (excited) but not as extreme as original with wider radius
            const baseSpeed = strategic
              ? Math.PI * (5.5 + rng.next() * 1.5)
              : Math.PI * (4.5 + rng.next() * 1.5);
            this.idleSpeed = baseSpeed * (rng.bool() ? 1 : -1);
            this.idleInitialized = true;
          }
          this.idlePhase += this.idleSpeed * dt;
          this.crosshair.x =
            this.crosshairTarget.x + Math.cos(this.idlePhase) * this.idleRx;
          this.crosshair.y =
            this.crosshairTarget.y + Math.sin(this.idlePhase) * this.idleRy;
        }
      } else {
        this.stepCrosshairToward(this.crosshairTarget.x, this.crosshairTarget.y, dt);
      }
    }
  }

  private makePhantom(
    shape: PieceShape,
    row: number,
    col: number,
    valid: boolean,
  ): PhantomPiece {
    return { offsets: shape.offsets, row, col, valid, playerId: this.playerId };
  }

  private computeNextPlacement(state: GameState): void {
    if (!this.currentPiece) return;
    const result = this.strategy.pickPlacement(
      state,
      this.playerId,
      this.currentPiece,
      {
        row: Math.round(this.buildCursor.row),
        col: Math.round(this.buildCursor.col),
      },
    );
    if (result) {
      this.pendingPlace = {
        piece: result.piece,
        row: result.row,
        col: result.col,
      };
    } else {
      this.pendingPlace = null;
    }
  }
}
