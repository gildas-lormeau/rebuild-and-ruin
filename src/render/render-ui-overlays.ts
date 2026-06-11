import type { LobbyHit, OnlineOverlayParams } from "../runtime/ui-contracts.ts";
import type { BalloonFlight, Cannonball } from "../shared/core/battle-types.ts";
import {
  LIFE_LOST_MAX_TIMER,
  MODIFIER_ID,
  UPGRADE_PICK_MAX_TIMER,
} from "../shared/core/game-constants.ts";
import type { BannerKind } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { TowerIdx } from "../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_PORTRAIT_LAUNCHED,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  SCALE,
  TILE_SIZE,
  type TileKey,
} from "../shared/core/grid.ts";
import { modifierDef, type SupplyShip } from "../shared/core/modifier-defs.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { cannonTier } from "../shared/core/player-types.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import { castleCenterPx, computeFloodedTiles } from "../shared/core/spatial.ts";
import { type ComboEvent, type SelectionState } from "../shared/core/types.ts";
import { UPGRADE_POOL } from "../shared/core/upgrade-defs.ts";
import { IS_TOUCH_DEVICE } from "../shared/platform/platform.ts";
import type { SceneCapture } from "../shared/ui/banner-content.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameOverFocus,
  LifeLostChoice,
  type LifeLostDialogState,
  type ResolvedChoice,
  type UpgradePickDialogState,
} from "../shared/ui/interaction-types.ts";
import {
  type BannerUi,
  type CastleData,
  type GameOverOverlay,
  type LifeLostDialogOverlay,
  type OverlayBalloon,
  type OverlayCannonball,
  type OverlaySupplyShip,
  type RenderOverlay,
  type UIOverlay,
  type UpgradePickOverlay,
} from "../shared/ui/overlay-types.ts";
import { getPlayerColor, PLAYER_NAMES } from "../shared/ui/player-config.ts";
import {
  BANNER_HEIGHT_RATIO,
  LIFE_LOST_BTN_H as BTN_H,
  LIFE_LOST_BTN_W as BTN_W,
  LOBBY_RECT_H_RATIO,
  LOBBY_RECT_H_RATIO_TOUCH,
  LOBBY_RECT_Y_RATIO,
  LOBBY_RECT_Y_RATIO_TOUCH,
  LIFE_LOST_PANEL_H as PANEL_H,
  LIFE_LOST_PANEL_W as PANEL_W,
  type RGB,
} from "../shared/ui/theme.ts";

interface GameOverLayout {
  panelW: number;
  panelH: number;
  px: number;
  py: number;
  btnW: number;
  btnY: number;
  rematchX: number;
  menuX: number;
}

const GAMEOVER_PANEL_W_RATIO = 0.325;
const SETTINGS_GEAR_X = MAP_PX_W - 32;
const SETTINGS_GEAR_Y = 4;
const SETTINGS_GEAR_SIZE = 28;
const UPGRADE_CARDS_PER_ROW = 3;
const COMBO_LABELS: Record<ComboEvent["kind"], string> = {
  wall: "Wall Streak",
  cannon: "Cannon Kill",
  grunt: "Grunt Sniper",
};
const PHASE_STATUS_LABELS: Record<Phase, string> = {
  [Phase.CASTLE_SELECT]: "Castle",
  [Phase.WALL_BUILD]: "Build",
  [Phase.CANNON_PLACE]: "Cannons",
  [Phase.MODIFIER_REVEAL]: "Reveal",
  [Phase.BATTLE]: "Battle",
  [Phase.UPGRADE_PICK]: "Upgrade",
};
/** Lobby panel geometry picked once from IS_TOUCH_DEVICE — touch needs a
 *  bigger gap and a taller/higher panel for usable hit-targets. */
const LOBBY_LAYOUT = IS_TOUCH_DEVICE
  ? {
      gap: 8,
      rectHRatio: LOBBY_RECT_H_RATIO_TOUCH,
      rectYRatio: LOBBY_RECT_Y_RATIO_TOUCH,
    }
  : { gap: 12, rectHRatio: LOBBY_RECT_H_RATIO, rectYRatio: LOBBY_RECT_Y_RATIO };
export const UPGRADE_NAME_H = 18;
export const UPGRADE_ROW_GAP = 8;
export const GAMEOVER_ROW_H = 14;
export const GAMEOVER_HEADER_H = 36;
export const GAMEOVER_BTN_H = 20;
/** Card layout constants — canonical source; render-ui.ts imports these.
 *  Width grows in landscape (room to spare on the wider canvas), height
 *  grows in portrait (vertical space is generous, lets 2-line labels
 *  breathe). Both orientations are sized for a 2-line label + descrip-
 *  tion worst case; the label only actually wraps when it has to. */
export const UPGRADE_CARD_W = GRID_PORTRAIT_LAUNCHED ? 120 : 150;
export const UPGRADE_CARD_H = GRID_PORTRAIT_LAUNCHED ? 140 : 100;
export const UPGRADE_CARD_GAP = 10;
export const UPGRADE_ROW_W =
  UPGRADE_CARDS_PER_ROW * UPGRADE_CARD_W +
  (UPGRADE_CARDS_PER_ROW - 1) * UPGRADE_CARD_GAP;

export function createBannerUi(
  active: boolean,
  kind: BannerKind,
  text: string,
  progress: number,
  subtitle?: string,
  paletteKey?: string,
  prevScene?: SceneCapture,
  newScene?: SceneCapture,
): BannerUi | undefined {
  if (!active) return undefined;
  const h = MAP_PX_H;
  const bannerH = h * BANNER_HEIGHT_RATIO;
  const startY = -bannerH / 2;
  const endY = h + bannerH / 2;
  const y = startY + progress * (endY - startY);
  // Pre-round the strip bounds so every consumer reads the exact same
  // integer edges (rounding drift across sites would cause 1-pixel
  // seams between the strip and the clipped region next to it).
  const bannerHInt = Math.round(h * BANNER_HEIGHT_RATIO);
  const top = Math.round(y - bannerHInt / 2);
  return {
    kind,
    text,
    subtitle,
    top,
    bottom: top + bannerHInt,
    paletteKey,
    prevScene,
    newScene,
    progress,
    swept: progress >= 1,
  };
}

/** Writes selection highlights into overlay.selection (mutates in-place).
 *  @param visiblePlayers — set of player IDs whose highlights should be shown.
 *  If omitted, all unconfirmed players are shown. */
export function updateSelectionOverlay(
  overlay: RenderOverlay,
  selectionStates: Map<ValidPlayerId, SelectionState>,
  visiblePlayers?: ReadonlySet<ValidPlayerId>,
): void {
  if (!overlay.selection) {
    overlay.selection = { highlighted: null, selected: null };
  }
  overlay.selection.highlights = [];
  for (const [pid, selectionState] of selectionStates) {
    if (selectionState.confirmed) continue;
    if (visiblePlayers && !visiblePlayers.has(pid)) continue;
    overlay.selection.highlights.push({
      towerIdx: selectionState.highlighted,
      playerId: pid,
      confirmed: false,
    });
  }
}

export function handleLifeLostDialogClick(params: {
  view: RenderView;
  lifeLostDialog: LifeLostDialogState;
  /** World-pixel X coordinate (caller passes camera.screenToWorld output, so
   *  the hit-test stays correct when the camera is zoomed to a viewport —
   *  e.g. while a local player is choosing CONTINUE/ABANDON). */
  gameX: number;
  /** World-pixel Y coordinate. See gameX. */
  gameY: number;
}): { playerId: ValidPlayerId; choice: ResolvedChoice } | null {
  const { view, lifeLostDialog, gameX, gameY } = params;

  for (const entry of lifeLostDialog.entries) {
    if (entry.choice !== LifeLostChoice.PENDING) continue;

    const { px, py } = lifeLostPanelPos(view, entry.playerId);
    const { btnY, contX, abX } = lifeLostButtonLayout(px, py);

    if (
      gameX >= contX &&
      gameX <= contX + BTN_W &&
      gameY >= btnY &&
      gameY <= btnY + BTN_H
    ) {
      return { playerId: entry.playerId, choice: LifeLostChoice.CONTINUE };
    }

    if (
      gameX >= abX &&
      gameX <= abX + BTN_W &&
      gameY >= btnY &&
      gameY <= btnY + BTN_H
    ) {
      return { playerId: entry.playerId, choice: LifeLostChoice.ABANDON };
    }
  }

  return null;
}

export function lifeLostButtonLayout(
  px: number,
  py: number,
): {
  btnY: number;
  contX: number;
  abX: number;
} {
  return {
    btnY: py + PANEL_H - BTN_H - 10,
    contX: px + PANEL_W / 2 - BTN_W - 5,
    abX: px + PANEL_W / 2 + 5,
  };
}

/** Pure spatial hit-test for upgrade pick cards.
 *  Returns the playerId and card index of the clicked card, or null. */
export function handleUpgradePickClick(params: {
  dialog: UpgradePickDialogState;
  /** Canvas-pixel X coordinate (divided by SCALE internally for game-space hit testing). */
  screenX: number;
  /** Canvas-pixel Y coordinate (divided by SCALE internally for game-space hit testing). */
  screenY: number;
}): { playerId: ValidPlayerId; cardIdx: number } | null {
  const { dialog, screenX, screenY } = params;
  const gameX = screenX / SCALE;
  const gameY = screenY / SCALE;
  const entryH = upgradePickEntryH();
  const startY = upgradePickStartY(MAP_PX_H, dialog.entries.length);
  const rowX = (MAP_PX_W - UPGRADE_ROW_W) / 2;

  for (let entryIdx = 0; entryIdx < dialog.entries.length; entryIdx++) {
    const entry = dialog.entries[entryIdx]!;
    if (entry.choice !== null) continue;
    const cardsY = startY + entryIdx * entryH + UPGRADE_NAME_H;

    for (let cardIdx = 0; cardIdx < UPGRADE_CARDS_PER_ROW; cardIdx++) {
      const cx = rowX + cardIdx * (UPGRADE_CARD_W + UPGRADE_CARD_GAP);
      if (
        gameX >= cx &&
        gameX <= cx + UPGRADE_CARD_W &&
        gameY >= cardsY &&
        gameY <= cardsY + UPGRADE_CARD_H
      ) {
        return { playerId: entry.playerId, cardIdx };
      }
    }
  }
  return null;
}

/** Position the life-lost dialog panel at the same anchor the camera uses
 *  for that zone's auto-zoom (wall + home-tower bounding-box center, via
 *  `castleCenterPx`). Sharing the anchor keeps the panel screen-centered
 *  under the zoomed viewport. Falls back to the map center when the
 *  player has no zone (eliminated, no homeTower, no walls). Clamped 2px
 *  inside the tile-space edges so it never crosses the map boundary. */
export function lifeLostPanelPos(
  view: RenderView,
  playerId: ValidPlayerId,
): { px: number; py: number } {
  const zone = view.playerZones[playerId];
  const center =
    zone === undefined
      ? { x: MAP_PX_W / 2, y: MAP_PX_H / 2 }
      : castleCenterPx(view.players, view.playerZones, view.map.zones, zone);
  return {
    px: Math.max(
      2,
      Math.min(MAP_PX_W - PANEL_W - 2, Math.round(center.x - PANEL_W / 2)),
    ),
    py: Math.max(
      2,
      Math.min(MAP_PX_H - PANEL_H - 2, Math.round(center.y - PANEL_H / 2)),
    ),
  };
}

export function createOnlineOverlay(
  params: OnlineOverlayParams,
): RenderOverlay {
  const {
    previousSelection,
    view,
    battleAnim,
    frame,
    bannerUi,
    inBattle,
    inBalloonAnim,
    lifeLostDialog,
    upgradePickDialog,
    povPlayerId,
    hasPointerPlayer,
    upgradePickInteractiveSlots,
    playerNames,
    playerColors,
    getLifeLostPanelPos,
    revealOverlayFields,
  } = params;
  const {
    fogRevealOpacity,
    dustStormSwayAmplitude,
    dustStormSwayPhaseRad,
    rubbleClearingFade,
    frostbiteRevealProgress,
    sapperRevealIntensity,
    gruntSurgeRevealIntensity,
  } = revealOverlayFields;

  const enclosedTowers = buildEnclosedTowersByIndex(view);
  const homeTowerIndices = buildHomeTowerIndices(view);
  const masterBuilderLockout = view.modern?.masterBuilderLockout ?? 0;
  const whenBattle = <T>(value: T): T | undefined =>
    inBattle ? value : undefined;

  return {
    phase: view.phase,
    selection: previousSelection,
    castles: buildCastleOverlay(view),
    entities: {
      grunts: view.grunts,
      towerAlive: view.towerAlive,
      burningPits: view.burningPits,
      bonusSquares: view.bonusSquares,
      enclosedTowers: enclosedTowers.size > 0 ? enclosedTowers : undefined,
      homeTowerIndices:
        homeTowerIndices.size > 0 ? homeTowerIndices : undefined,
      frozenTiles: view.modern?.frozenTiles ?? undefined,
      thawingTiles:
        battleAnim.thawing.length > 0 ? battleAnim.thawing : undefined,
      floodedTiles:
        view.modern?.activeModifier === MODIFIER_ID.HIGH_TIDE
          ? computeFloodedTiles(view.map)
          : undefined,
      exposedRiverbedTiles: view.modern?.exposedRiverbedTiles ?? undefined,
    },
    battle: {
      battleTerritory: whenBattle(battleAnim.territory),
      battleWalls: whenBattle(battleAnim.walls),
      cannonballs: buildBattleCannonballsPayload(inBattle, view.cannonballs),
      impacts: whenBattle(battleAnim.impacts),
      destroyedWalls: whenBattle(battleAnim.destroyedWalls),
      cannonDestroys: whenBattle(battleAnim.cannonDestroys),
      gruntKills: whenBattle(battleAnim.gruntKills),
      houseDestroys: whenBattle(battleAnim.houseDestroys),
      shieldFlashes: whenBattle(battleAnim.shieldFlashes),
      crosshairs: whenBattle(frame.crosshairs),
      balloons: inBalloonAnim
        ? buildBattleBalloonsPayload(battleAnim.flights)
        : undefined,
      // Fog covers the reveal banner and the battle itself, then lifts the
      // moment battle ends — dwelling through the post-battle banner /
      // upgrade pick would hide state the player needs to see.
      fogOfWar:
        (inBattle || view.phase === Phase.MODIFIER_REVEAL) &&
        view.modern?.activeModifier === MODIFIER_ID.FOG_OF_WAR,
      fogRevealOpacity,
      // Dust storm covers reveal banner + battle, then lifts when battle
      // ends (same gating shape as fog — dwelling through post-battle
      // banner / upgrade pick would obscure state the player needs to
      // see).
      dustStorm:
        (inBattle || view.phase === Phase.MODIFIER_REVEAL) &&
        view.modern?.activeModifier === MODIFIER_ID.DUST_STORM,
      dustStormSwayAmplitude,
      dustStormSwayPhaseRad,
      rubbleClearingFade,
      // Held rubble entries gate on the fade ramp directly — they fade
      // out and stay gone (no bridge needed; gameplay state already
      // dropped them). Contrast with `heldDestroyedWalls` below, which
      // bridges to BATTLE entry so the cross-fading debris persists.
      heldRubblePits:
        rubbleClearingFade !== undefined
          ? view.modern?.rubbleClearingHeld?.pits
          : undefined,
      heldDeadCannons:
        rubbleClearingFade !== undefined
          ? view.modern?.rubbleClearingHeld?.deadCannons
          : undefined,
      frostbiteRevealProgress,
      // Frostbite tint follows the modifier's full lifetime: surviving
      // frosted grunts must keep reading as ice through the post-battle
      // banner and the next build/cannon phases. Clears when the next
      // prepareBattleState reassigns activeModifier.
      frostbite: view.modern?.activeModifier === MODIFIER_ID.FROSTBITE,
      sapperRevealIntensity,
      sapperTargetedWalls:
        sapperRevealIntensity !== undefined
          ? collectSapperTargetedWalls(view)
          : undefined,
      gruntSurgeRevealIntensity,
      gruntSurgeSpawnTiles:
        gruntSurgeRevealIntensity !== undefined
          ? view.modern?.activeModifierChangedTiles
          : undefined,
      supplyShips: buildBattleSupplyShipsPayload(view.modern?.supplyShips),
    },
    phantoms: frame.phantoms,
    ui: {
      timer:
        !inBattle &&
        view.phase !== Phase.MODIFIER_REVEAL &&
        bannerUi === undefined &&
        view.timer > 0
          ? view.timer
          : undefined,
      banner: bannerUi,
      announcement: frame.announcement,
      gameOver: frame.gameOver,
      lifeLostDialog: buildLifeLostDialogUi(
        lifeLostDialog,
        playerNames,
        playerColors,
        LIFE_LOST_MAX_TIMER,
        getLifeLostPanelPos,
      ),
      comboFloats: hasPointerPlayer
        ? formatComboFloats(view.modern?.comboTracker?.events, povPlayerId)
        : undefined,
      upgradePick: buildUpgradePickUi(
        upgradePickDialog,
        upgradePickInteractiveSlots,
        playerNames,
        playerColors,
        bannerUi,
      ),
      masterBuilderLockout:
        masterBuilderLockout > 0 ? masterBuilderLockout : undefined,
      statusBar: buildStatusBar(view, povPlayerId, playerColors),
    },
  };
}

/** Build the game-over overlay from the winner, per-player snapshots, and stats. */
export function buildGameOverOverlay(
  winnerId: ValidPlayerId,
  players: readonly {
    id: ValidPlayerId;
    score: number;
    eliminated: boolean;
  }[],
  showRematch: boolean,
): GameOverOverlay {
  return {
    winner: PLAYER_NAMES[winnerId] ?? `Player ${winnerId + 1}`,
    scores: players.map((player) => ({
      name: PLAYER_NAMES[player.id] ?? `P${player.id + 1}`,
      score: player.score,
      color: getPlayerColor(player.id).wall,
      eliminated: player.eliminated,
    })),
    focused: showRematch ? FOCUS_REMATCH : FOCUS_MENU,
    showRematch,
  };
}

/** Hit-test the game-over Rematch / Menu buttons.
 *  Accepts canvas-pixel coords (divided by SCALE internally for game-space hit testing). */
export function gameOverButtonHitTest(
  canvasX: number,
  canvasY: number,
  gameOver: GameOverOverlay,
): GameOverFocus | null {
  const tileX = canvasX / SCALE;
  const tileY = canvasY / SCALE;
  const { btnW, btnY, rematchX, menuX } = gameOverLayout(
    MAP_PX_W,
    MAP_PX_H,
    gameOver.scores,
    gameOver.showRematch,
  );

  if (
    gameOver.showRematch &&
    tileX >= rematchX &&
    tileX <= rematchX + btnW &&
    tileY >= btnY &&
    tileY <= btnY + GAMEOVER_BTN_H
  ) {
    return FOCUS_REMATCH;
  }
  if (
    tileX >= menuX &&
    tileX <= menuX + btnW &&
    tileY >= btnY &&
    tileY <= btnY + GAMEOVER_BTN_H
  ) {
    return FOCUS_MENU;
  }
  return null;
}

export function gameOverLayout(
  W: number,
  H: number,
  scores: GameOverOverlay["scores"],
  showRematch: boolean,
): GameOverLayout {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const tableH = sorted.length * GAMEOVER_ROW_H;
  const panelW = Math.round(W * GAMEOVER_PANEL_W_RATIO);
  const panelH = GAMEOVER_HEADER_H + tableH + 16 + GAMEOVER_BTN_H + 12;
  const px = Math.round((W - panelW) / 2);
  const py = Math.round((H - panelH) / 2);
  const btnW = Math.round((panelW - 30) / 2);
  return {
    panelW,
    panelH,
    px,
    py,
    btnW,
    btnY: py + panelH - GAMEOVER_BTN_H - 10,
    rematchX: px + 10,
    // Menu is the only button when rematch is hidden — center it.
    menuX: showRematch
      ? px + panelW - 10 - btnW
      : px + Math.round((panelW - btnW) / 2),
  };
}

/**
 * Hit-test a lobby click against player panels and gear button.
 * Returns { type: "gear" } for gear click, { type: "slot", slotId }
 * for a player slot click, or null if nothing was hit.
 */
export function lobbyClickHitTest(params: {
  canvasX: number;
  canvasY: number;
  canvasW: number;
  canvasH: number;
  tileSize: number;
  slotCount: number;
  computeLayout: (
    tsW: number,
    tsH: number,
    count: number,
  ) => { gap: number; rectW: number; rectH: number; rectY: number };
}): LobbyHit | null {
  const {
    canvasX,
    canvasY,
    canvasW,
    canvasH,
    tileSize,
    slotCount,
    computeLayout,
  } = params;

  const tsW = GRID_COLS * tileSize;
  const tsH = GRID_ROWS * tileSize;
  const x = canvasX * (tsW / canvasW);
  const y = canvasY * (tsH / canvasH);

  if (
    x >= SETTINGS_GEAR_X &&
    x <= SETTINGS_GEAR_X + SETTINGS_GEAR_SIZE &&
    y >= SETTINGS_GEAR_Y &&
    y <= SETTINGS_GEAR_Y + SETTINGS_GEAR_SIZE
  ) {
    return { type: "gear" };
  }

  const { gap, rectW, rectH, rectY } = computeLayout(tsW, tsH, slotCount);
  for (let i = 0; i < slotCount; i++) {
    const rx = gap + i * (rectW + gap);
    if (x >= rx && x <= rx + rectW && y >= rectY && y <= rectY + rectH) {
      return { type: "slot", slotId: i as ValidPlayerId };
    }
  }
  return null;
}

/** Compute lobby panel layout (shared by drawing and hit-testing). */
export function computeLobbyLayout(W: number, H: number, count: number) {
  const { gap, rectHRatio, rectYRatio } = LOBBY_LAYOUT;
  const rectW = Math.round((W - gap * (count + 1)) / count);
  const rectH = Math.round(H * rectHRatio);
  const rectY = Math.round(H * rectYRatio);
  return { gap, rectW, rectH, rectY };
}

function upgradePickStartY(H: number, entryCount: number): number {
  const totalH = entryCount * upgradePickEntryH() - UPGRADE_ROW_GAP;
  return Math.max(H * 0.14, (H - totalH - 30) / 2);
}

function upgradePickEntryH(): number {
  return UPGRADE_NAME_H + UPGRADE_CARD_H + UPGRADE_ROW_GAP;
}

function buildCastleOverlay(view: RenderView): CastleData[] {
  return view.players
    .filter((player) => player.castleWallTiles.size > 0)
    .map((player) => ({
      walls: player.walls,
      interior: player.interior,
      cannons: player.cannons,
      playerId: player.id,
      damagedWalls:
        player.damagedWalls.size > 0 ? player.damagedWalls : undefined,
      cannonTier: cannonTier(player),
    }));
}

function buildStatusBar(
  view: RenderView,
  povPlayerId: ValidPlayerId,
  playerColors: ReadonlyArray<{ wall: RGB }>,
): UIOverlay["statusBar"] {
  if (view.phase === Phase.CASTLE_SELECT || view.phase === Phase.BATTLE) {
    return undefined;
  }
  const povPlayer = view.players.find((player) => player.id === povPlayerId);
  const upgradeLabels = povPlayer
    ? Array.from(povPlayer.upgrades.keys(), (id) => {
        const def = UPGRADE_POOL.find((upgrade) => upgrade.id === id);
        return def?.label ?? id;
      })
    : [];
  const modifierId = view.modern?.activeModifier ?? null;
  const secs = Math.max(0, Math.ceil(view.timer) - 1);
  return {
    round: Number.isFinite(view.maxRounds)
      ? `R${view.round}/${view.maxRounds}`
      : `R${view.round}`,
    phase: PHASE_STATUS_LABELS[view.phase],
    timer: view.timer > 0 ? `${secs}s` : "",
    modifier: modifierId ? modifierDef(modifierId).label : undefined,
    upgrades: upgradeLabels.length > 0 ? upgradeLabels : undefined,
    players: view.players.map((player) => ({
      score: player.score,
      cannons: player.cannons.length,
      lives: player.lives,
      color: playerColors[player.id % playerColors.length]!.wall,
      eliminated: player.eliminated,
    })),
  };
}

function buildEnclosedTowersByIndex(
  view: RenderView,
): Map<TowerIdx, ValidPlayerId> {
  const enclosedTowers = new Map<TowerIdx, ValidPlayerId>();
  for (const player of view.players) {
    for (const tower of player.enclosedTowers) {
      enclosedTowers.set(tower.index, player.id);
    }
  }
  return enclosedTowers;
}

function buildHomeTowerIndices(view: RenderView): Set<TowerIdx> {
  const indices = new Set<TowerIdx>();
  for (const player of view.players) {
    if (player.homeTower) indices.add(player.homeTower.index);
  }
  return indices;
}

function buildLifeLostDialogUi(
  dialog: LifeLostDialogState | null,
  playerNames: ReadonlyArray<string>,
  playerColors: ReadonlyArray<{ wall: RGB }>,
  maxTimer: number,
  getPanelPos: (playerId: ValidPlayerId) => { px: number; py: number },
): LifeLostDialogOverlay | undefined {
  if (!dialog) return undefined;

  return {
    entries: dialog.entries.map((e) => {
      const { px, py } = getPanelPos(e.playerId);
      return {
        playerId: e.playerId,
        name: playerNames[e.playerId] ?? `P${e.playerId + 1}`,
        lives: e.lives,
        color: playerColors[e.playerId % playerColors.length]!.wall,
        choice: e.choice,
        focusedButton: e.focusedButton,
        px,
        py,
      };
    }),
    timer: dialog.timer,
    maxTimer,
  };
}

function buildUpgradePickUi(
  dialog: UpgradePickDialogState | null,
  interactiveSlots: ReadonlySet<ValidPlayerId>,
  playerNames: ReadonlyArray<string>,
  playerColors: ReadonlyArray<{ wall: RGB }>,
  bannerUi: BannerUi | undefined,
): UpgradePickOverlay | undefined {
  if (!dialog) return undefined;
  const fadeMask = computeUpgradePickFadeMask(bannerUi);

  const entries = dialog.entries.map((entry) => {
    const isInteractive = interactiveSlots.has(entry.playerId);
    // focusedCard is only meaningful when someone is actively moving it —
    // the local interactive player (via input) or an auto-resolving AI
    // (via the cycling/lock-in tick). Remote human entries on the host
    // have static focusedCard=0 until their pick message arrives, which
    // would otherwise render a phantom border on card 0 throughout.
    const focusIsLive = isInteractive || entry.autoResolve;
    return {
      playerName: playerNames[entry.playerId] ?? `P${entry.playerId + 1}`,
      color: playerColors[entry.playerId % playerColors.length]!.wall,
      resolved: entry.choice !== null,
      interactive: isInteractive,
      cards: entry.offers.map((upgradeId, cardIdx) => {
        const def = UPGRADE_POOL.find(
          (upgradeDef) => upgradeDef.id === upgradeId,
        );
        const picked = entry.choice === upgradeId;
        const pulseAge =
          picked && entry.pickedAtTimer !== null
            ? Math.max(0, dialog.timer - entry.pickedAtTimer)
            : 0;
        return {
          label: def?.label ?? upgradeId,
          description: def?.description ?? "",
          category: def?.category ?? "",
          focused:
            entry.choice === null &&
            focusIsLive &&
            entry.focusedCard === cardIdx,
          picked,
          pulseAge,
        };
      }),
    };
  });

  return {
    entries,
    timer: dialog.timer,
    maxTimer: UPGRADE_PICK_MAX_TIMER,
    ...(fadeMask ? { fadeMask } : {}),
  };
}

function computeUpgradePickFadeMask(
  bannerUi: BannerUi | undefined,
): { rectTop: number; rectBottom: number } | undefined {
  // The only banner that shares frames with a live upgrade-pick dialog
  // is the UPGRADE_PICK entry banner — the dialog is pre-created in
  // `enter-upgrade-pick.mutate` and reveals above the sweeping banner
  // strip. By the time the WALL_BUILD banner sweeps, the upgrade-pick
  // subsystem has already torn down its dialog state (it does so before
  // handing the resolution back to the phase machine, which only then
  // dispatches `enter-wall-build`), so no other banner kind needs a
  // clip rect.
  if (bannerUi?.kind === "upgrade-pick") {
    return { rectTop: 0, rectBottom: bannerUi.top };
  }
  return undefined;
}

function buildBattleCannonballsPayload(
  inBattle: boolean,
  cannonballs: readonly Cannonball[],
): OverlayCannonball[] | undefined {
  if (!inBattle) return undefined;

  return cannonballs.map((b) => {
    const progress = b.flightTime > 0 ? b.elapsed / b.flightTime : 1;
    return {
      x: b.x,
      y: b.y,
      startX: b.startX,
      startY: b.startY,
      progress,
      altitude: b.altitude,
      incendiary: b.incendiary,
      mortar: b.mortar,
    };
  });
}

function buildBattleSupplyShipsPayload(
  ships: readonly SupplyShip[] | null | undefined,
): readonly OverlaySupplyShip[] | undefined {
  // No phase gate: `state.modern.supplyShips` is null outside the
  // battle window (apply() spawns at battle start, clear() nulls at
  // BATTLE_END), so the field nullness IS the gate. Including the
  // overlay during MODIFIER_REVEAL is essential — that's the phase
  // whose banner sweep snapshots the post-apply scene and reveals the
  // ships in place.
  if (!ships || ships.length === 0) return undefined;
  return ships.map((ship) => ({
    id: ship.id,
    x: ship.position.col * TILE_SIZE + TILE_SIZE / 2,
    y: ship.position.row * TILE_SIZE + TILE_SIZE / 2,
    headingRad: ship.headingRad,
    hpFrac: ship.hp / 2,
    sinking: ship.sinking,
    // Reveal the bonus only once the ship is sinking — alive ships
    // keep their cargo hidden so the player has to read which one to
    // chase. Without this gate the bonus would leak to the UI/cheat
    // surface during gameplay.
    bonus: ship.sinking ? ship.bonus : undefined,
  }));
}

function buildBattleBalloonsPayload(
  flights: ReadonlyArray<{ flight: BalloonFlight; progress: number }>,
): OverlayBalloon[] | undefined {
  if (flights.length === 0) return undefined;

  return flights.map((b) => ({
    x: b.flight.startX,
    y: b.flight.startY,
    targetX: b.flight.endX,
    targetY: b.flight.endY,
    progress: b.progress,
  }));
}

function formatComboFloats(
  events: readonly ComboEvent[] | undefined,
  povPlayerId: ValidPlayerId,
): { text: string; age: number }[] | undefined {
  if (!events || events.length === 0) return undefined;
  const filtered = events.filter((event) => event.playerId === povPlayerId);
  if (filtered.length === 0) return undefined;
  return filtered.map((event) => ({
    text: formatComboText(event),
    age: event.age,
  }));
}

function formatComboText(event: ComboEvent): string {
  const label = COMBO_LABELS[event.kind];
  const streak = event.streak > 1 ? ` x${event.streak}` : "";
  return `${label}${streak}! +${event.bonus}`;
}

function collectSapperTargetedWalls(view: RenderView): readonly TileKey[] {
  const targeted = new Set<TileKey>();
  for (const grunt of view.grunts) {
    if (grunt.targetedWall !== undefined) targeted.add(grunt.targetedWall);
  }
  return [...targeted];
}
