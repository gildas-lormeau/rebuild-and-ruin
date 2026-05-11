/**
 * Supply-ship effect manager — renders the neutral cargo ships.
 * Reconciles one THREE.Group per ship by id, drives motion + sink
 * via root-group transforms. Sink: 0→0.4 roll 20°; 0.4→1.0 hold tilt
 * + descend + bubbles. Foam splash on sink-completion is rendered by
 * the shared ImpactsManager — gameplay pushes a TilePos to
 * newImpacts; this manager owns the hull/bubbles only.
 */

import * as THREE from "three";
import { MODIFIER_ID } from "../../../shared/core/game-constants.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { OverlaySupplyShip } from "../../../shared/ui/overlay-types.ts";
import { Z_FIGHT_MARGIN } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import {
  buildSupplyShip,
  getSupplyShipVariant,
} from "../sprites/supply-ship-scene.ts";
import { type EffectManager, getSharedSmokeTexture } from "./fire-burst.ts";
import { createFlatDisc } from "./helpers.ts";

interface BubbleSprite {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  /** Seconds since this bubble was last (re-)spawned. */
  age: number;
  /** Horizontal jitter offset relative to the host's local X. */
  offsetX: number;
  offsetZ: number;
  /** Phase offset for desynchronizing emission. */
  phase: number;
}

interface ShipHost {
  group: THREE.Group;
  id: number;
  /** Bubble billboards owned by this host (live under `group`). */
  bubbles: BubbleSprite[];
  /** Reveal-halo sub-group — sibling of `group` under `root` so it
   *  inherits no scale from the TILE-scaled ship group. Positioned to
   *  the ship's world coords each frame. */
  haloGroup: THREE.Group;
  haloDisc: THREE.Mesh;
  haloDiscMaterial: THREE.MeshBasicMaterial;
  haloFlash: THREE.Mesh;
  haloFlashMaterial: THREE.MeshBasicMaterial;
}

/** Waterline elevation. Authored locally rather than via
 *  `ELEVATION_STACK` because the river surface isn't a thing any
 *  existing stack entry models — it's neither a ground-plane effect
 *  (those sit at 0.3 – 0.8) nor a fog-style overhead layer (80). The
 *  terrain mesh paints water at `ELEVATION_STACK.TERRAIN_MESH = 0.01`,
 *  so we float the hull center such that its draft portion straddles
 *  that. The scene authors hull yCenter so ~40% of the hull sits below
 *  Y=0 (draft) and ~60% above (freeboard); placing the host at Y=0
 *  leaves the deck top at +0.2625 · TILE_SIZE ≈ +4.2 world units
 *  above the water — cleanly visible from the tilted overhead view. */
const WATER_Y = 0;
/** Supply-ship scenes are authored in a ±1 frustum covering a 2-tile
 *  span (matches the cannon convention — see
 *  `entities/cannons.ts:cannonScaleForSize`), so scaling the host by
 *  TILE_SIZE makes 1 authored unit = 1 game tile. */
const SUPPLY_SHIP_SCALE = TILE_SIZE;
/** Authored hull draft (cells below Y=0) — `hull.yCenter − hull.height/2`
 *  in supply-ship-scene authoring units = cells(0.6) − cells(1.5) =
 *  cells(−0.9) ≈ −0.1125. Multiplied by scale gives world units. The
 *  sink descent target is `−draft · 1.5` so the deck sinks visibly
 *  below the waterline. */
const HULL_DRAFT = 0.1125 * SUPPLY_SHIP_SCALE;
/** Idle bob amplitudes. Kept small so the ships read as "sailing on
 *  calm water" rather than tossing in a storm. */
const BOB_Y_AMPLITUDE = 0.5;
const BOB_ROLL_AMPLITUDE = 0.03;
/** Idle bob period (seconds). Each ship adds its `id` as a phase
 *  offset so the 3 simultaneous bobs aren't synchronized. */
const BOB_PERIOD_SEC = 2.4;
/** Sink-tilt timing. `tilt` lerps 0 → MAX_TILT across [0, TILT_PEAK_T]
 *  then holds at MAX_TILT for the descent phase. */
const SINK_TILT_PEAK_T = 0.4;
const SINK_TILT_RAD = (25 * Math.PI) / 180;
/** Bubble billboards — N per ship, emitted continuously during the
 *  descent phase. Tracked locally (one `THREE.Sprite` each) and
 *  recycled when they age out. Kept low so 3 sinking ships at once
 *  don't pile up draw calls. */
const BUBBLES_PER_SHIP = 6;
const BUBBLE_LIFE_SEC = 1.6;
const BUBBLE_RISE_SPEED = 6;
const BUBBLE_BASE_SIZE = 3;
const BUBBLE_SIZE_GROWTH = 4;
const BUBBLE_COLOR = 0xc8d6dc;
/** Reveal-halo pulse — one-shot per ship during MODIFIER_REVEAL. Plays
 *  exactly once when `ctx.overlay.ui.modifierReveal.modifierId` matches
 *  this modifier, then hides until the next reveal. `revealTimeMs`
 *  stays 0 during the banner-snapshot capture window and rolls forward
 *  post-sweep — so the halo is invisible in the static snapshot and
 *  fires during the post-sweep dwell as intended. */
const HALO_PULSE_DURATION_MS = 800;
const HALO_FLASH_DURATION_MS = 200;
const HALO_DISC_MIN_RADIUS = TILE_SIZE * 0.8;
const HALO_DISC_MAX_RADIUS = TILE_SIZE * 2.4;
const HALO_FLASH_MIN_RADIUS = TILE_SIZE * 0.4;
const HALO_FLASH_MAX_RADIUS = TILE_SIZE * 2.0;
const HALO_DISC_PEAK_OPACITY = 0.5;
const HALO_FLASH_PEAK_OPACITY = 1.0;
const HALO_DISC_COLOR = 0xffd84a;
const HALO_FLASH_COLOR = 0xffffff;

export function createSupplyShipManager(scene: THREE.Scene): EffectManager {
  const root = new THREE.Group();
  root.name = "supply-ships";
  scene.add(root);

  const hosts = new Map<number, ShipHost>();
  const seen = new Set<number>();

  // Bubble texture is borrowed from the fire-burst smoke kernel — it's
  // a soft radial gradient with a few overlay blobs, which doubles
  // cleanly as an air-bubble billboard under a cool tint.
  const bubbleTexture = getSharedSmokeTexture();
  // Shared geometry for the reveal-halo disc + flash ring — both meshes
  // animate via material opacity + scale, never via geometry replacement,
  // so a single circle does for every ship.
  const haloGeometry = createFlatDisc();

  /** Fingerprint of the current ship-id set — cheap rebuild guard. The
   *  expensive per-host work (geometry build + material allocation)
   *  only happens when the id set changes; per-frame motion writes
   *  position/rotation/scale only. */
  let lastIdFingerprint = "";

  function buildHost(id: number): ShipHost {
    const variant = getSupplyShipVariant();
    const group = new THREE.Group();
    group.scale.setScalar(SUPPLY_SHIP_SCALE);
    root.add(group);
    buildSupplyShip(THREE, group, variant.params);

    // Pre-allocate bubble sprites up-front so the descent phase doesn't
    // pay an allocation cost per frame. They start invisible and only
    // become visible during the descent half of the sink animation.
    const bubbles: BubbleSprite[] = [];
    for (let i = 0; i < BUBBLES_PER_SHIP; i++) {
      const material = new THREE.SpriteMaterial({
        color: BUBBLE_COLOR,
        map: bubbleTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      // Local-frame offsets — host scale applies, so these are in
      // authored units. Spread across the deck centerline (cells(±2)
      // along local Z, small X jitter).
      const offsetX = (((i * 73) % 11) / 11 - 0.5) * 0.4;
      const offsetZ = (((i * 37) % 13) / 13 - 0.5) * 1.6;
      sprite.position.set(offsetX, 0, offsetZ);
      group.add(sprite);
      bubbles.push({
        sprite,
        material,
        age: BUBBLE_LIFE_SEC * (i / BUBBLES_PER_SHIP),
        offsetX,
        offsetZ,
        phase: i * 0.37,
      });
    }

    // Reveal-halo lives as a sibling of `group` under `root` so the
    // host group's TILE_SIZE scale doesn't leak into the halo radii —
    // they're authored directly in world units.
    const haloGroup = new THREE.Group();
    haloGroup.visible = false;
    const haloDiscMaterial = new THREE.MeshBasicMaterial({
      color: HALO_DISC_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const haloDisc = new THREE.Mesh(haloGeometry, haloDiscMaterial);
    haloGroup.add(haloDisc);
    const haloFlashMaterial = new THREE.MeshBasicMaterial({
      color: HALO_FLASH_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const haloFlash = new THREE.Mesh(haloGeometry, haloFlashMaterial);
    haloFlash.position.y = Z_FIGHT_MARGIN;
    haloGroup.add(haloFlash);
    root.add(haloGroup);

    return {
      group,
      id,
      bubbles,
      haloGroup,
      haloDisc,
      haloDiscMaterial,
      haloFlash,
      haloFlashMaterial,
    };
  }

  function disposeHost(host: ShipHost): void {
    for (const bubble of host.bubbles) bubble.material.dispose();
    host.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const materials = obj.material;
        if (Array.isArray(materials)) {
          for (const entry of materials) entry.dispose();
        } else {
          materials.dispose();
        }
      }
    });
    root.remove(host.group);
    host.haloDiscMaterial.dispose();
    host.haloFlashMaterial.dispose();
    root.remove(host.haloGroup);
  }

  function animateBubbles(host: ShipHost, dtSec: number): void {
    for (const bubble of host.bubbles) {
      bubble.age += dtSec;
      if (bubble.age >= BUBBLE_LIFE_SEC) bubble.age -= BUBBLE_LIFE_SEC;
      const lifeT = bubble.age / BUBBLE_LIFE_SEC;
      bubble.sprite.visible = true;
      // Sprite Y is in local-frame units; the host's group scale
      // amplifies it. Authored offset is cells-of-the-frustum, so the
      // bubble rises within the local ±1 box.
      bubble.sprite.position.y =
        BUBBLE_RISE_SPEED * lifeT * (1 / SUPPLY_SHIP_SCALE);
      // Slight X drift so bubbles don't rise in a perfect column.
      bubble.sprite.position.x =
        bubble.offsetX + Math.sin(bubble.age * 3 + bubble.phase) * 0.05;
      const size = BUBBLE_BASE_SIZE + BUBBLE_SIZE_GROWTH * lifeT;
      bubble.sprite.scale.set(size, size, 1);
      // Fade in over the first 20% of life, hold, fade out over the
      // last 30%. Capped low-ish so a column of 6 doesn't over-bloom.
      let alpha: number;
      if (lifeT < 0.2) alpha = lifeT / 0.2;
      else if (lifeT > 0.7) alpha = Math.max(0, 1 - (lifeT - 0.7) / 0.3);
      else alpha = 1;
      bubble.material.opacity = alpha * 0.7;
    }
  }

  function hideBubbles(host: ShipHost): void {
    for (const bubble of host.bubbles) {
      bubble.sprite.visible = false;
      bubble.material.opacity = 0;
    }
  }

  let lastNowMs: number | undefined;

  function update(ctx: FrameCtx): void {
    const ships = ctx.overlay?.battle?.supplyShips;
    const dtSec =
      lastNowMs === undefined ? 0 : Math.max(0, (ctx.now - lastNowMs) / 1000);
    lastNowMs = ctx.now;

    if (!ships || ships.length === 0) {
      if (hosts.size > 0) {
        for (const host of hosts.values()) disposeHost(host);
        hosts.clear();
      }
      lastIdFingerprint = "";
      return;
    }

    // Cheap fingerprint over the id set — rebuilds only on add/remove.
    let fingerprint = "";
    for (const ship of ships) fingerprint += `${ship.id}|`;
    if (fingerprint !== lastIdFingerprint) {
      lastIdFingerprint = fingerprint;
    }

    // Reveal-halo: active only when the current modifier reveal targets
    // `supply_ship`. `revealTimeMs` is `0` during the snapshot capture
    // window and rolls forward post-sweep, so the halo stays hidden in
    // the static snapshot and animates during the post-sweep dwell.
    const reveal = ctx.overlay?.ui?.modifierReveal;
    const revealTimeMs =
      reveal?.modifierId === MODIFIER_ID.SUPPLY_SHIP ? reveal.revealTimeMs : -1;

    seen.clear();
    for (const ship of ships) {
      seen.add(ship.id);
      let host = hosts.get(ship.id);
      if (!host) {
        host = buildHost(ship.id);
        hosts.set(ship.id, host);
      }
      animateShip(host, ship, ctx.now, dtSec);
      if (revealTimeMs >= 0) animateHalo(host, ship, revealTimeMs);
      else hideHalo(host);
    }

    // Dispose any host whose ship has vanished from the overlay. The
    // foam splash on sink-completion comes from the gameplay-emitted
    // Impact entry, rendered by the shared ImpactsManager.
    for (const [id, host] of hosts) {
      if (seen.has(id)) continue;
      disposeHost(host);
      hosts.delete(id);
    }
  }

  function animateShip(
    host: ShipHost,
    ship: OverlaySupplyShip,
    nowMs: number,
    dtSec: number,
  ): void {
    const sinkProgress = ship.sinking?.progress ?? 0;
    const isSinking = ship.sinking !== undefined;

    // Heading: scene-Z maps to world-Y (row axis), matching
    // `cannonballs.ts` (`position.z = ball.y`). The overlay's
    // `headingRad` is "0 = facing +X (world)"; the ship's long axis is
    // its local +Z (bow). A rotation.y of θ moves local +Z to
    // (sin θ, 0, cos θ), so for the bow to point along the world +X
    // axis when heading = 0 we need rotation.y = +π/2, and for the bow
    // to point along the world +Z axis when heading = π/2 we need
    // rotation.y = 0. The closed form is:
    //   yaw = π/2 − headingRad
    // Earlier this was `headingRad − π/2`, which mirrors the ship
    // across the Z axis — the bow read as perpendicular to motion on
    // diagonals, like the ship was drifting sideways.
    host.group.rotation.y = Math.PI / 2 - ship.headingRad;

    // Position + bob + roll.
    if (isSinking) {
      // 0.0 → 0.4: tilt to MAX_TILT, position at waterline.
      // 0.4 → 1.0: hold tilt, descend.
      const tiltT = Math.min(sinkProgress / SINK_TILT_PEAK_T, 1);
      const roll = SINK_TILT_RAD * tiltT;
      // One-directional list (always +Z roll); reads as ship taking on
      // water from one side.
      host.group.rotation.z = roll;

      let descentY = WATER_Y;
      if (sinkProgress > SINK_TILT_PEAK_T) {
        const descentT =
          (sinkProgress - SINK_TILT_PEAK_T) / (1 - SINK_TILT_PEAK_T);
        descentY = WATER_Y - HULL_DRAFT * 1.5 * descentT;
      }
      host.group.position.set(ship.x, descentY, ship.y);

      // Bubbles only emit during the descent half — the spec says
      // "spawn bubble billboards … emitting from the deck centerline".
      if (sinkProgress > SINK_TILT_PEAK_T) {
        animateBubbles(host, dtSec);
      } else {
        hideBubbles(host);
      }
    } else {
      // Idle bob — sin-wave on Y and rotation.z keyed off (now, id) so
      // the 3 ships don't bob in lockstep.
      const nowSec = nowMs / 1000;
      const phase = (nowSec / BOB_PERIOD_SEC) * 2 * Math.PI + ship.id * 1.7;
      const bobY = Math.sin(phase) * BOB_Y_AMPLITUDE;
      const roll = Math.sin(phase * 0.85 + 0.4) * BOB_ROLL_AMPLITUDE;
      host.group.position.set(ship.x, WATER_Y + bobY, ship.y);
      host.group.rotation.z = roll;
      hideBubbles(host);
    }

    // hpFrac is in the overlay shape but not consumed visually here —
    // hit-feedback (flash on hpFrac change, debris on hpFrac = 0) is
    // handled gameplay-side via the existing `impacts` overlay slice.
    // Leaving this as a no-op consumer for forward compatibility.
    void ship.hpFrac;
  }

  function animateHalo(
    host: ShipHost,
    ship: OverlaySupplyShip,
    revealTimeMs: number,
  ): void {
    // <=0 catches the snapshot window (revealTimeMs holds at 0 there);
    // >=duration ends the one-shot pulse.
    if (revealTimeMs <= 0 || revealTimeMs >= HALO_PULSE_DURATION_MS) {
      hideHalo(host);
      return;
    }
    host.haloGroup.visible = true;
    // Pin to the ship's world XZ at the waterline. Independent of the
    // ship group's bob/sink Y so the halo always reads as "on the water".
    host.haloGroup.position.set(ship.x, WATER_Y + Z_FIGHT_MARGIN, ship.y);

    // Disc: grows linearly, opacity peaks at the pulse midpoint then fades.
    const progress = revealTimeMs / HALO_PULSE_DURATION_MS;
    const discRadius =
      HALO_DISC_MIN_RADIUS +
      (HALO_DISC_MAX_RADIUS - HALO_DISC_MIN_RADIUS) * progress;
    const discAlpha =
      (progress < 0.5 ? progress * 2 : (1 - progress) * 2) *
      HALO_DISC_PEAK_OPACITY;
    host.haloDiscMaterial.opacity = discAlpha;
    host.haloDisc.scale.set(discRadius, 1, discRadius);
    host.haloDisc.visible = true;

    // Flash ring: sharp burst that expires before the disc fade-out.
    if (revealTimeMs < HALO_FLASH_DURATION_MS) {
      const flashProgress = revealTimeMs / HALO_FLASH_DURATION_MS;
      const flashRadius =
        HALO_FLASH_MIN_RADIUS +
        (HALO_FLASH_MAX_RADIUS - HALO_FLASH_MIN_RADIUS) * flashProgress;
      host.haloFlashMaterial.opacity =
        (1 - flashProgress) * HALO_FLASH_PEAK_OPACITY;
      host.haloFlash.scale.set(flashRadius, 1, flashRadius);
      host.haloFlash.visible = true;
    } else {
      host.haloFlash.visible = false;
    }
  }

  function hideHalo(host: ShipHost): void {
    host.haloGroup.visible = false;
  }

  function dispose(): void {
    for (const host of hosts.values()) disposeHost(host);
    hosts.clear();
    haloGeometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
