/**
 * Dialog facade — explicit contract boundary between game/ and runtime/
 * for the three dialog-related subsystems (banner, life-lost, upgrade-pick).
 *
 * Runtime subsystems import this single facade instead of reaching into
 * individual game/ files.
 */

import { createBannerState } from "../shared/ui-contracts.ts";
import {
  continuingPlayers,
  createLifeLostDialogState,
  eliminateAbandoned,
  resolveAfterLifeLost,
  tickLifeLostDialog,
} from "./life-lost.ts";
import { showBannerTransition, tickBannerTransition } from "./phase-banner.ts";
import {
  applyUpgradePicks,
  createUpgradePickDialog,
  tickUpgradePickDialog,
  UPGRADE_PICK_AUTO_DELAY,
  UPGRADE_PICK_MAX_TIMER,
} from "./upgrade-pick.ts";

export const dialogFacade = {
  createLifeLostDialog: createLifeLostDialogState,
  tickLifeLostDialog,
  continuingPlayers,
  resolveAfterLifeLost,
  eliminateAbandoned,
  createUpgradePickDialog,
  tickUpgradePickDialog,
  applyUpgradePicks,
  UPGRADE_PICK_AUTO_DELAY,
  UPGRADE_PICK_MAX_TIMER,
  createBannerState,
  showBannerTransition,
  tickBannerTransition,
};
