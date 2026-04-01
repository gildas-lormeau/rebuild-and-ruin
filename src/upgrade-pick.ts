/**
 * Upgrade pick dialog — create, tick, and resolve logic.
 * L3 (shared interfaces), mirrors life-lost.ts pattern.
 *
 * Pure functions operating on UpgradePickDialogState.
 * No runtime or rendering dependencies.
 */

import type {
  GameState,
  UpgradePickDialogState,
  UpgradePickEntry,
} from "./types.ts";
import { UPGRADE_POOL, type UpgradeId } from "./upgrade-defs.ts";

interface CreateUpgradePickDeps {
  readonly state: GameState;
  readonly isHost: boolean;
  readonly myPlayerId: number;
  readonly remoteHumanSlots: ReadonlySet<number>;
  readonly isHumanController: (playerId: number) => boolean;
}

/** Number of upgrade choices offered per pick. */
const OFFER_COUNT = 3;
/** First round that triggers upgrade picks (modern mode). */
const UPGRADE_FIRST_ROUND = 3;
/** AI delay before auto-picking (seconds). */
export const UPGRADE_PICK_AI_DELAY = 1.5;
/** Max time before force-picking for pending players (seconds). */
export const UPGRADE_PICK_MAX_TIMER = 15;

/** Generate upgrade offers and create the pick dialog.
 *  Uses state.rng for deterministic online sync. Returns null if picks
 *  are not applicable (classic mode, too early, no alive players). */
export function createUpgradePickDialog(
  deps: CreateUpgradePickDeps,
): UpgradePickDialogState | null {
  const { state } = deps;
  if (state.gameMode !== "modern") return null;
  if (state.round < UPGRADE_FIRST_ROUND) return null;

  const entries: UpgradePickEntry[] = [];
  for (const player of state.players) {
    if (player.eliminated) continue;
    if (!player.homeTower) continue;

    const offers = drawOffers(state);
    const isAi = deps.isHost
      ? !deps.isHumanController(player.id) &&
        !deps.remoteHumanSlots.has(player.id)
      : player.id !== deps.myPlayerId;

    entries.push({
      playerId: player.id,
      offers,
      choice: null,
      isAi,
      aiTimer: 0,
      focused: 0,
    });
  }

  if (entries.length === 0) return null;
  return { entries, timer: 0 };
}

/** Tick the upgrade pick dialog. AI players auto-pick after a delay.
 *  Returns the dialog (still active) or null (all resolved). */
export function tickUpgradePickDialog(
  dialog: UpgradePickDialogState,
  dt: number,
  aiDelay: number,
  maxTimer: number,
): boolean {
  dialog.timer += dt;

  // AI auto-pick
  for (const entry of dialog.entries) {
    if (entry.choice !== null) continue;
    if (entry.isAi) {
      entry.aiTimer += dt;
      if (entry.aiTimer >= aiDelay) {
        entry.choice = entry.offers[0];
      }
    }
  }

  // Max timer — force-pick for anyone still pending
  if (dialog.timer >= maxTimer) {
    for (const entry of dialog.entries) {
      if (entry.choice === null) {
        entry.choice = entry.offers[0];
      }
    }
  }

  return dialog.entries.every((entry) => entry.choice !== null);
}

/** Apply all picked upgrades to player state. */
export function applyUpgradePicks(
  state: GameState,
  dialog: UpgradePickDialogState,
): void {
  for (const entry of dialog.entries) {
    if (entry.choice === null) continue;
    const player = state.players[entry.playerId];
    if (!player) continue;
    const current = player.upgrades.get(entry.choice) ?? 0;
    player.upgrades.set(entry.choice, current + 1);
  }
}

/** Draw N unique upgrades from the weighted pool using state.rng. */
function drawOffers(state: GameState): [UpgradeId, UpgradeId, UpgradeId] {
  const available = [...UPGRADE_POOL];
  const picked: UpgradeId[] = [];

  for (let i = 0; i < OFFER_COUNT && available.length > 0; i++) {
    const totalWeight = available.reduce((sum, def) => sum + def.weight, 0);
    let roll = state.rng.next() * totalWeight;
    let chosenIdx = available.length - 1;
    for (let ci = 0; ci < available.length; ci++) {
      roll -= available[ci]!.weight;
      if (roll <= 0) {
        chosenIdx = ci;
        break;
      }
    }
    picked.push(available[chosenIdx]!.id);
    available.splice(chosenIdx, 1);
  }

  return picked as [UpgradeId, UpgradeId, UpgradeId];
}
