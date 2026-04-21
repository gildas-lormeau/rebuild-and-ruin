// sprite-materials.ts — shared MaterialSpec constants used by 2+ scene files.
//
// Each *-scene.ts file previously declared its own copies of these
// materials (and some had drifted slightly — e.g. WOOD_DARK roughness
// 0.90 vs 0.95, BAND_GREEN roughness 0.60 vs 0.65). This module is the
// single source of truth; scene files import only what they use.
//
// Scene-local materials (used by exactly one file and conceptually
// tied to that sprite — HULL_GREEN, ENVELOPE_RED, LAVA_HOT, STONE_BODY
// for house, etc.) stay in their scene file.
//
// PALETTE arrays are intentionally NOT consolidated here: each variant
// quantizes against a per-scene palette that reflects what that
// variant actually renders, and those arrays should continue to drift
// independently of the materials list.

import type { MaterialSpec } from "./sprite-kit.ts";

// Wall side stones (untextured — the textured variants STONE_MAIN /
// STONE_LIGHT in wall-scene.ts wrap these colours with a procedural
// brick map).
export const WALL_STONE_DARK: MaterialSpec = {
  kind: "standard",
  color: 0xcfcfc5,
  roughness: 0.85,
  metalness: 0.05,
};
export const WALL_STONE_MAIN: MaterialSpec = {
  kind: "standard",
  color: 0xffffff,
  roughness: 0.85,
  metalness: 0.05,
};
export const WALL_STONE_LIGHT: MaterialSpec = {
  kind: "standard",
  color: 0xffffff,
  roughness: 0.8,
  metalness: 0.05,
};
// Dark wood — used on tower flag-poles and on broken-wood debris
// (cannon carriage splinters, tower beam stubs). Canonical roughness
// 0.95 (debris spec); tower previously used 0.90.
export const WOOD_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x3a2410,
  roughness: 0.95,
  metalness: 0.0,
};
// Green band / emblem shared by the rampart reinforcer's core band and
// by the green "band" detail sampled into cannon-rubble piles. Canonical
// roughness 0.65 (debris spec); rampart previously used 0.60.
export const BAND_GREEN: MaterialSpec = {
  kind: "standard",
  color: 0x71b04e,
  roughness: 0.65,
  metalness: 0.3,
};
// Pennant / flag red. Used on tower flagpoles (as a thin two-sided
// plane) and on the flag fragment sampled into tower-rubble piles.
// side:'double' is harmless on the rubble (the 3D debris chunk renders
// both sides anyway) and required by the tower pennant plane.
export const FLAG_RED: MaterialSpec = {
  kind: "standard",
  color: 0xb02a2a,
  roughness: 0.65,
  metalness: 0.0,
  side: "double",
};
// Dark, matte plane painted under merlons on the walkway / roof deck
// to fake the contact shadow where a merlon meets the stone below.
// Used by both wall-scene (walkway) and tower-scene (turret roof deck).
export const MERLON_AO: MaterialSpec = {
  kind: "standard",
  color: 0x282828,
  roughness: 1.0,
  metalness: 0.0,
};
// Soft/hard shadow discs dropped on the ground under free-standing
// sprites (balloon base, cannon/tower rubble) so they don't look like
// they're floating above the grass tile.
export const GROUND_SHADOW: MaterialSpec = {
  kind: "basic",
  color: 0x1a1510,
  side: "double",
};
export const GROUND_AO: MaterialSpec = {
  kind: "basic",
  color: 0x141008,
  side: "double",
};
/** Near-black cap used for cannon bore / vent interiors. Rendered
 *  double-sided so the ring reads as a deep hole from any angle. */
export const BORE_DARK: MaterialSpec = {
  kind: "basic",
  color: 0x0a0a0a,
  side: "double",
};
