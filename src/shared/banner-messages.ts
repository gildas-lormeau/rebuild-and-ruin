/**
 * Phase transition banner strings.
 *
 * Display copy for the banner UI that plays between phase transitions.
 * Owned by shared/ because banner text is a UI concern — the game domain
 * emits phase events, the renderer chooses what to display.
 */

export const BANNER_PLACE_CANNONS = "Place Cannons";
export const BANNER_PLACE_CANNONS_SUB = "Position inside fort walls";
export const BANNER_BATTLE = "Prepare for Battle";
export const BANNER_BATTLE_SUB = "Shoot at enemy walls";
export const BANNER_BUILD = "Build & Repair";
export const BANNER_BUILD_SUB = "Surround castles, repair walls";
export const BANNER_UPGRADE_PICK = "Choose Upgrade";
export const BANNER_UPGRADE_PICK_SUB = "Pick one upgrade per player";
export const BANNER_SELECT = "Select your home castle";
