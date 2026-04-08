/**
 * Dialog facade — explicit contract boundary between game/ and runtime/
 * for the three dialog-related subsystems (banner, life-lost, upgrade-pick).
 *
 * Runtime subsystems import this single facade instead of reaching into
 * individual game/ files.
 */

import { createBannerState } from "../shared/ui-contracts.ts";
import {
  applyLifeLostChoice,
  confirmLifeLostFocusedChoice,
  continuingPlayers,
  createLifeLostDialogState,
  eliminateAbandoned,
  isLifeLostAllResolved,
  resolveAfterLifeLost,
  tickLifeLostDialog,
  toggleLifeLostFocus,
} from "./life-lost.ts";
import {
  snapshotCastles,
  snapshotEntities,
  tickBannerTransition,
} from "./phase-banner.ts";
import {
  applyUpgradePicks,
  createUpgradePickDialog,
  moveUpgradePickFocus,
  resolveUpgradePickEntry,
  tickUpgradePickDialog,
  UPGRADE_PICK_AUTO_DELAY,
  UPGRADE_PICK_MAX_TIMER,
} from "./upgrade-pick.ts";

export const dialogFacade = {
  createLifeLostDialog: createLifeLostDialogState,
  isLifeLostAllResolved,
  tickLifeLostDialog,
  continuingPlayers,
  resolveAfterLifeLost,
  eliminateAbandoned,
  toggleLifeLostFocus,
  confirmLifeLostFocusedChoice,
  applyLifeLostChoice,
  createUpgradePickDialog,
  tickUpgradePickDialog,
  applyUpgradePicks,
  moveUpgradePickFocus,
  resolveUpgradePickEntry,
  UPGRADE_PICK_AUTO_DELAY,
  UPGRADE_PICK_MAX_TIMER,
  createBannerState,
  snapshotCastles,
  snapshotEntities,
  tickBannerTransition,
};
