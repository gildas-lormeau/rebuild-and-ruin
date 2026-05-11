/**
 * Supply-ship effect manager — renders the neutral cargo ships from
 * the `supply_ship` modifier. Reads `overlay.battle?.supplyShips`,
 * reconciles one THREE.Group per ship by id, drives motion + sink
 * via root-group transforms. Sink driven by `ship.sinking.progress`
 * (0→0.4: roll to 20°; 0.4→1.0: hold tilt + descend below waterline
 * + bubbles; 1.0: one-shot foam ring). No hit-detection, no RNG.
 */

import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { OverlaySupplyShip } from "../../../shared/ui/overlay-types.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import {
  buildSupplyShip,
  getSupplyShipVariant,
} from "../sprites/supply-ship-scene.ts";
import { type EffectManager, getSharedSmokeTexture } from "./fire-burst.ts";

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
  /** Highest sink progress observed so far — used to fire the foam
   *  splash exactly once when progress first reaches ≥ 1.0. */
  maxProgressSeen: number;
  /** Last known position (refreshed every frame the ship is in the
   *  overlay). Used as the splash anchor when the ship leaves the
   *  overlay between frames. */
  lastX: number;
  lastZ: number;
}

interface FoamRing {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
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
/** Foam splash — local kernel triggered one-shot when sink progress
 *  crosses ≥ 1.0. A widening, fading flat ring at the waterline;
 *  authored here because the existing `ImpactsManager` is overlay-
 *  driven (reads `overlay.battle.impacts`) and we can't push synthetic
 *  entries from the render layer. */
const FOAM_LIFE_SEC = 0.9;
const FOAM_START_RADIUS = TILE_SIZE * 0.35;
const FOAM_END_RADIUS = TILE_SIZE * 0.95;
const FOAM_COLOR = 0xe0eef4;

export function createSupplyShipManager(scene: THREE.Scene): EffectManager {
  const root = new THREE.Group();
  root.name = "supply-ships";
  scene.add(root);

  const hosts = new Map<number, ShipHost>();
  const seen = new Set<number>();

  // Foam-ring resources (local kernel — see FOAM_* constants above).
  // Shared ring geometry across every live splash; per-splash materials
  // own the fading opacity so each animates independently.
  const foamGeometry = new THREE.RingGeometry(0.85, 1.0, 24);
  foamGeometry.rotateX(-Math.PI / 2);
  const foams: FoamRing[] = [];

  // Bubble texture is borrowed from the fire-burst smoke kernel — it's
  // a soft radial gradient with a few overlay blobs, which doubles
  // cleanly as an air-bubble billboard under a cool tint.
  const bubbleTexture = getSharedSmokeTexture();

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

    return {
      group,
      id,
      bubbles,
      maxProgressSeen: 0,
      lastX: 0,
      lastZ: 0,
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
  }

  function spawnFoamSplash(worldX: number, worldZ: number): void {
    const material = new THREE.MeshBasicMaterial({
      color: FOAM_COLOR,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(foamGeometry, material);
    mesh.position.set(worldX, WATER_Y + 0.05, worldZ);
    mesh.scale.set(FOAM_START_RADIUS, 1, FOAM_START_RADIUS);
    root.add(mesh);
    foams.push({ mesh, material, age: 0 });
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

  function animateFoams(dtSec: number): void {
    // Iterate from the back so we can splice without skipping entries.
    for (let i = foams.length - 1; i >= 0; i--) {
      const foam = foams[i]!;
      foam.age += dtSec;
      const lifeT = foam.age / FOAM_LIFE_SEC;
      if (lifeT >= 1) {
        root.remove(foam.mesh);
        foam.material.dispose();
        foams.splice(i, 1);
        continue;
      }
      const radius =
        FOAM_START_RADIUS + (FOAM_END_RADIUS - FOAM_START_RADIUS) * lifeT;
      foam.mesh.scale.set(radius, 1, radius);
      foam.material.opacity = 0.85 * (1 - lifeT);
    }
  }

  let lastNowMs: number | undefined;

  function update(ctx: FrameCtx): void {
    const ships = ctx.overlay?.battle?.supplyShips;
    const dtSec =
      lastNowMs === undefined ? 0 : Math.max(0, (ctx.now - lastNowMs) / 1000);
    lastNowMs = ctx.now;

    // No ships: dispose all hosts, keep foam rings alive until they
    // fade (a ship can sink and then leave the overlay on the same
    // frame the foam was spawned).
    if (!ships || ships.length === 0) {
      if (hosts.size > 0) {
        for (const host of hosts.values()) disposeHost(host);
        hosts.clear();
      }
      lastIdFingerprint = "";
      animateFoams(dtSec);
      return;
    }

    // Cheap fingerprint over the id set — rebuilds only on add/remove.
    let fingerprint = "";
    for (const ship of ships) fingerprint += `${ship.id}|`;
    if (fingerprint !== lastIdFingerprint) {
      lastIdFingerprint = fingerprint;
    }

    seen.clear();
    for (const ship of ships) {
      seen.add(ship.id);
      let host = hosts.get(ship.id);
      if (!host) {
        host = buildHost(ship.id);
        hosts.set(ship.id, host);
      }
      animateShip(host, ship, ctx.now, dtSec);
    }

    // Dispose any host whose ship has vanished from the overlay. The
    // foam splash (if its sink completed earlier this frame) is
    // already in the `foams` list and lives on its own clock.
    for (const [id, host] of hosts) {
      if (seen.has(id)) continue;
      disposeHost(host);
      hosts.delete(id);
    }

    animateFoams(dtSec);
  }

  function animateShip(
    host: ShipHost,
    ship: OverlaySupplyShip,
    nowMs: number,
    dtSec: number,
  ): void {
    host.lastX = ship.x;
    host.lastZ = ship.y;

    const sinkProgress = ship.sinking?.progress ?? 0;
    const isSinking = ship.sinking !== undefined;

    // One-shot foam splash on progress crossing ≥ 1.0.
    if (sinkProgress >= 1 && host.maxProgressSeen < 1) {
      spawnFoamSplash(ship.x, ship.y);
    }
    host.maxProgressSeen = Math.max(host.maxProgressSeen, sinkProgress);

    // Heading: scene-Z maps to world-Y (row axis), matching
    // `cannonballs.ts` (`position.z = ball.y`). The overlay's
    // `headingRad` is "0 = facing +X (world)"; the ship's long axis is
    // its local +Z. The host's rotation.y in three.js is a CCW rotation
    // about +Y, which rotates local +Z toward +X when set to +π/2 (we
    // want the long axis to point along +X when heading = 0). So:
    //   yaw = headingRad − π/2
    host.group.rotation.y = ship.headingRad - Math.PI / 2;

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
      host.maxProgressSeen = 0;
    }

    // hpFrac is in the overlay shape but not consumed visually here —
    // hit-feedback (flash on hpFrac change, debris on hpFrac = 0) is
    // handled gameplay-side via the existing `impacts` overlay slice.
    // Leaving this as a no-op consumer for forward compatibility.
    void ship.hpFrac;
  }

  function dispose(): void {
    for (const host of hosts.values()) disposeHost(host);
    hosts.clear();
    for (const foam of foams) {
      root.remove(foam.mesh);
      foam.material.dispose();
    }
    foams.length = 0;
    foamGeometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
