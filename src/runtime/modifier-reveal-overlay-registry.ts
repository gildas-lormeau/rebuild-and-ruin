/**
 * Maps an active modifier id to the 2D `BattleOverlay` scalars its reveal
 * pulse drives. Each entry receives the resolved `revealTimeMs` and
 * returns the fields its consumers read. Add a new 2D reveal effect by
 * writing a `derive*`, adding the field(s) to `BattleOverlay`, and adding
 * one entry below — no `subsystems/render` edits. 3D bursts use a separate
 * registry (`MODIFIER_EFFECT_FACTORIES` + `overlay.ui.modifierReveal`).
 */

import { MODIFIER_ID, type ModifierId } from "../shared/core/game-constants.ts";
import type { BattleOverlay } from "../shared/ui/overlay-types.ts";
import {
  deriveDustStormSwayAmplitude,
  deriveDustStormSwayPhaseRad,
} from "./dust-storm-reveal-overlay.ts";
import { deriveFogRevealOpacity } from "./fog-reveal-overlay.ts";
import { deriveFrostbiteRevealProgress } from "./frostbite-reveal-overlay.ts";
import { deriveGruntSurgeRevealIntensity } from "./grunt-surge-reveal-overlay.ts";
import { deriveRubbleClearingFade } from "./rubble-clearing-overlay.ts";
import { deriveSapperRevealIntensity } from "./sapper-reveal-overlay.ts";

export type RevealOverlayBattleFields = Pick<
  BattleOverlay,
  | "fogRevealOpacity"
  | "dustStormSwayAmplitude"
  | "dustStormSwayPhaseRad"
  | "rubbleClearingFade"
  | "frostbiteRevealProgress"
  | "sapperRevealIntensity"
  | "gruntSurgeRevealIntensity"
>;

interface RevealOverlayDeriver {
  readonly modifierId: ModifierId;
  readonly derive: (
    revealTimeMs: number | undefined,
  ) => RevealOverlayBattleFields;
}

const REVEAL_OVERLAY_DERIVERS: readonly RevealOverlayDeriver[] = [
  {
    modifierId: MODIFIER_ID.FOG_OF_WAR,
    derive: (revealTimeMs) => ({
      fogRevealOpacity: deriveFogRevealOpacity(revealTimeMs),
    }),
  },
  {
    modifierId: MODIFIER_ID.DUST_STORM,
    derive: (revealTimeMs) => ({
      dustStormSwayAmplitude: deriveDustStormSwayAmplitude(revealTimeMs),
      dustStormSwayPhaseRad: deriveDustStormSwayPhaseRad(revealTimeMs),
    }),
  },
  {
    modifierId: MODIFIER_ID.RUBBLE_CLEARING,
    derive: (revealTimeMs) => ({
      rubbleClearingFade: deriveRubbleClearingFade(revealTimeMs),
    }),
  },
  {
    modifierId: MODIFIER_ID.FROSTBITE,
    derive: (revealTimeMs) => ({
      frostbiteRevealProgress: deriveFrostbiteRevealProgress(revealTimeMs),
    }),
  },
  {
    modifierId: MODIFIER_ID.SAPPER,
    derive: (revealTimeMs) => ({
      sapperRevealIntensity: deriveSapperRevealIntensity(revealTimeMs),
    }),
  },
  {
    modifierId: MODIFIER_ID.GRUNT_SURGE,
    derive: (revealTimeMs) => ({
      gruntSurgeRevealIntensity: deriveGruntSurgeRevealIntensity(revealTimeMs),
    }),
  },
];

export function deriveRevealOverlayFields(
  activeModifier: ModifierId | null | undefined,
  revealTimeMs: number | undefined,
): RevealOverlayBattleFields {
  if (activeModifier === undefined || activeModifier === null) return {};
  const entry = REVEAL_OVERLAY_DERIVERS.find(
    (candidate) => candidate.modifierId === activeModifier,
  );
  if (entry === undefined) return {};
  return entry.derive(revealTimeMs);
}
