/**
 * Visual debugger for the directional sun rig (toggled via
 * `__dev.lightDebug(true)`). Renders a shrunken arc-dome proxy + sun
 * marker, a direction arrow, the shadow-camera frustum, and a HUD with
 * sunT/intensity. Direction matches the real sun; only the marker
 * distance is shrunk from SUN_DISTANCE to DEBUG_DOME_RADIUS for
 * visibility.
 */

import * as THREE from "three";
import { MAP_PX_H, MAP_PX_W } from "../../shared/core/grid.ts";
import { sunDirectionFromT } from "./lights.ts";

interface LightDebugState {
  group: THREE.Group;
  arc: THREE.Line;
  arcMaterial: THREE.LineBasicMaterial;
  marker: THREE.Mesh;
  markerMaterial: THREE.MeshBasicMaterial;
  arrow: THREE.ArrowHelper;
  shadowCameraHelper: THREE.CameraHelper;
}

/** Dome radius for the scaled-down debug visualization. Big enough to
 *  read against the map (which is ~700 wide), small enough that the
 *  full dome fits comfortably above the map center under the typical
 *  camera tilt. */
const DEBUG_DOME_RADIUS = 200;
/** Number of segments in the sun-arc polyline. 60 gives a smooth curve
 *  without hitting the 120-pt budget the rest of the renderer leans on
 *  for sub-tile motion. */
const ARC_SEGMENTS = 60;
/** Map center (world coords). */
const MAP_CENTER = new THREE.Vector3(MAP_PX_W / 2, 0, MAP_PX_H / 2);
const HUD_STYLE =
  "position:fixed;top:8px;left:8px;z-index:9999;padding:6px 10px;" +
  "background:rgba(0,0,0,0.75);color:#ffd866;font:12px monospace;" +
  "pointer-events:none;white-space:pre;";

let state: LightDebugState | undefined;
let hud: HTMLElement | undefined;
let enabled = false;

export function setLightDebugEnabled(on: boolean): void {
  enabled = on;
  if (state) state.group.visible = on;
  if (state) state.shadowCameraHelper.visible = on;
  if (hud) hud.style.display = on ? "block" : "none";
}

export function isLightDebugEnabled(): boolean {
  return enabled;
}

/** Per-frame update. Cheap no-op when disabled. Lazily builds the
 *  helper meshes + HUD on first activation so production builds (where
 *  `__dev.lightDebug` is never called) pay nothing. */
export function updateLightDebug(
  scene: THREE.Scene,
  ambient: THREE.AmbientLight,
  sun: THREE.DirectionalLight,
  sunT: number | undefined,
  blend: number,
): void {
  if (!enabled) return;
  if (!state) state = createDebugState(scene, sun);
  if (!hud) hud = createHud();

  const active = sunT !== undefined;
  const t = sunT ?? 0.5;

  // Place marker on the dome at the current sun direction.
  const dir = sunDirectionFromT(t);
  const length = Math.hypot(dir.x, dir.y, dir.z);
  const markerX = MAP_CENTER.x + (dir.x / length) * DEBUG_DOME_RADIUS;
  const markerY = MAP_CENTER.y + (dir.y / length) * DEBUG_DOME_RADIUS;
  const markerZ = MAP_CENTER.z + (dir.z / length) * DEBUG_DOME_RADIUS;
  state.marker.position.set(markerX, markerY, markerZ);

  // Arrow points from map center toward the sun's direction.
  state.arrow.position.copy(MAP_CENTER);
  state.arrow.setDirection(new THREE.Vector3(dir.x, dir.y, dir.z).normalize());
  state.arrow.setLength(DEBUG_DOME_RADIUS * 0.9, 30, 18);

  // Color = state. Active = warm yellow/orange (sun is shining);
  // inactive = neutral grey.
  const arcColor = active ? 0xffd866 : 0x666666;
  const markerColor = active ? 0xff8c42 : 0xaaaaaa;
  state.arcMaterial.color.setHex(arcColor);
  state.markerMaterial.color.setHex(markerColor);
  arrowLineMat(state.arrow).color.setHex(arcColor);
  arrowConeMat(state.arrow).color.setHex(markerColor);

  // CameraHelper has to be told the underlying camera moved (the sun
  // moved its shadow camera attached to it).
  state.shadowCameraHelper.update();

  hud.textContent =
    `light-debug\n` +
    `sunT       ${active ? t.toFixed(3) : "—"}\n` +
    `blend      ${blend.toFixed(3)}\n` +
    `ambient    ${ambient.intensity.toFixed(2)}\n` +
    `directional${sun.intensity.toFixed(2)}\n` +
    `castShadow ${sun.castShadow ? "on" : "off"}\n` +
    `sun pos    ${sun.position.x.toFixed(0)}, ${sun.position.y.toFixed(0)}, ${sun.position.z.toFixed(0)}`;
}

function createDebugState(
  scene: THREE.Scene,
  sun: THREE.DirectionalLight,
): LightDebugState {
  const group = new THREE.Group();
  group.name = "light-debug";

  // Arc polyline through the dome.
  const arcPoints: THREE.Vector3[] = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t = i / ARC_SEGMENTS;
    const dir = sunDirectionFromT(t);
    const length = Math.hypot(dir.x, dir.y, dir.z);
    arcPoints.push(
      new THREE.Vector3(
        MAP_CENTER.x + (dir.x / length) * DEBUG_DOME_RADIUS,
        MAP_CENTER.y + (dir.y / length) * DEBUG_DOME_RADIUS,
        MAP_CENTER.z + (dir.z / length) * DEBUG_DOME_RADIUS,
      ),
    );
  }
  const arcGeometry = new THREE.BufferGeometry().setFromPoints(arcPoints);
  const arcMaterial = new THREE.LineBasicMaterial({
    color: 0xffd866,
    depthTest: false,
    transparent: true,
    opacity: 0.85,
  });
  const arc = new THREE.Line(arcGeometry, arcMaterial);
  arc.renderOrder = 999;
  group.add(arc);

  // Current-sun-position marker (sphere) on the dome.
  const markerGeometry = new THREE.SphereGeometry(12, 16, 12);
  const markerMaterial = new THREE.MeshBasicMaterial({
    color: 0xff8c42,
    depthTest: false,
    transparent: true,
    opacity: 1.0,
  });
  const marker = new THREE.Mesh(markerGeometry, markerMaterial);
  marker.renderOrder = 1000;
  group.add(marker);

  // Direction arrow from map center toward the sun.
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    MAP_CENTER,
    DEBUG_DOME_RADIUS * 0.9,
    0xffd866,
    30,
    18,
  );
  const arrowLine = arrowLineMat(arrow);
  const arrowCone = arrowConeMat(arrow);
  arrowLine.depthTest = false;
  arrowLine.transparent = true;
  arrowCone.depthTest = false;
  arrowCone.transparent = true;
  arrow.renderOrder = 998;
  group.add(arrow);

  scene.add(group);

  // Shadow-camera helper attaches directly to the scene; it draws the
  // ortho frustum the shadow map projects through, which lives in
  // sun-space and is way bigger than the dome — keeping it as a
  // sibling of `group` lets us toggle visibility independently if we
  // ever want to. Updates each frame via `update()`.
  const shadowCameraHelper = new THREE.CameraHelper(sun.shadow.camera);
  scene.add(shadowCameraHelper);

  group.visible = enabled;
  shadowCameraHelper.visible = enabled;

  return {
    group,
    arc,
    arcMaterial,
    marker,
    markerMaterial,
    arrow,
    shadowCameraHelper,
  };
}

function createHud(): HTMLElement {
  const hudElement = document.createElement("div");
  hudElement.style.cssText = HUD_STYLE;
  hudElement.style.display = enabled ? "block" : "none";
  document.body.appendChild(hudElement);
  return hudElement;
}

// `Object3D.material` is typed as `Material | Material[]` because three.js
// supports multi-material meshes. ArrowHelper authors a single material
// for both line and cone, but we have to assert the narrow type ourselves
// to read .color / .depthTest / .transparent off it.
function arrowLineMat(arrow: THREE.ArrowHelper): THREE.LineBasicMaterial {
  return arrow.line.material as THREE.LineBasicMaterial;
}

function arrowConeMat(arrow: THREE.ArrowHelper): THREE.MeshBasicMaterial {
  return arrow.cone.material as THREE.MeshBasicMaterial;
}
