/**
 * Per-instance opacity + tint for THREE.InstancedMesh.
 *
 * three.js exposes per-instance matrix and per-instance color natively
 * but not opacity or tint. This module plumbs `instanceOpacity` (float)
 * and optionally `instanceTint` (float mix factor) through an
 * `onBeforeCompile` shader patch — the fragment shader multiplies
 * `diffuseColor.a` and lerps `diffuseColor.rgb` after the standard
 * alpha-map chunk so existing material features still compose.
 *
 * Two attachment helpers, one per shader variant:
 *
 *   const opacity = attachInstanceOpacity(mesh, capacity);
 *   // → opacity-only patch (one program shared across all callers)
 *
 *   const { opacity, tint } = attachInstanceTint(mesh, capacity, hex);
 *   // → opacity + tint patch (one program shared across all callers,
 *   //   per-material `instanceTintColor` uniform varies per call)
 *
 * Each helper installs a module-level patcher AND a stable
 * `customProgramCacheKey`, so three.js's program cache collapses every
 * material attached via the same helper into a single shader program.
 */

import * as THREE from "three";

const OPACITY_PROGRAM_KEY = "instance-modulation-opacity-v1";
const TINT_PROGRAM_KEY = "instance-modulation-tint-v1";

/** Attach a `Float32` per-instance opacity attribute to `mesh.geometry`,
 *  patch every material on `mesh` to multiply final alpha by it, and
 *  flag the material(s) transparent so the alpha multiply takes effect.
 *  Returns the underlying attribute so callers can write into
 *  `attr.array` (Float32Array) directly. */
export function attachInstanceOpacity(
  mesh: THREE.InstancedMesh,
  capacity: number,
): THREE.InstancedBufferAttribute {
  const opacity = createUnitAttribute(capacity, 1);
  mesh.geometry.setAttribute("instanceOpacity", opacity);

  for (const material of materialsOf(mesh)) {
    material.transparent = true;
    material.customProgramCacheKey = opacityProgramCacheKey;
    material.onBeforeCompile = patchInstanceOpacity;
    material.needsUpdate = true;
  }
  return opacity;
}

/** Same as `attachInstanceOpacity` plus an `instanceTint` float
 *  attribute that lerps `diffuseColor.rgb` toward the per-material
 *  `tintHex` uniform. Per-instance tint defaults to 0 (no tint).
 *  Callers write opacity + tint floats per slot to drive both.
 *
 *  `keepOpaque: true` skips forcing `material.transparent = true`. Use
 *  for entities that never fade (opacity stays at 1) — three.js's
 *  `OPAQUE` define wipes our `diffuseColor.a *= vInstanceOpacity`
 *  patch but the tint patch still composes, and the material renders
 *  through the opaque pass (no z-sorting cost). */
export function attachInstanceTint(
  mesh: THREE.InstancedMesh,
  capacity: number,
  tintHex: number,
  options?: { keepOpaque?: boolean },
): {
  opacity: THREE.InstancedBufferAttribute;
  tint: THREE.InstancedBufferAttribute;
} {
  const opacity = createUnitAttribute(capacity, 1);
  const tint = createUnitAttribute(capacity, 0);
  mesh.geometry.setAttribute("instanceOpacity", opacity);
  mesh.geometry.setAttribute("instanceTint", tint);

  const tintColor = new THREE.Color(tintHex);
  for (const material of materialsOf(mesh)) {
    if (!options?.keepOpaque) material.transparent = true;
    material.customProgramCacheKey = tintProgramCacheKey;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.instanceTintColor = { value: tintColor };
      patchInstanceOpacityAndTint(shader);
    };
    material.needsUpdate = true;
  }
  return { opacity, tint };
}

function createUnitAttribute(
  capacity: number,
  fillValue: number,
): THREE.InstancedBufferAttribute {
  const data = new Float32Array(capacity);
  data.fill(fillValue);
  const attr = new THREE.InstancedBufferAttribute(data, 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  return attr;
}

function materialsOf(mesh: THREE.InstancedMesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function opacityProgramCacheKey(): string {
  return OPACITY_PROGRAM_KEY;
}

function tintProgramCacheKey(): string {
  return TINT_PROGRAM_KEY;
}

/** Module-level shader patcher: opacity-only variant. */
function patchInstanceOpacity(
  shader: THREE.WebGLProgramParametersWithUniforms,
): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\nattribute float instanceOpacity;\nvarying float vInstanceOpacity;",
    )
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvInstanceOpacity = instanceOpacity;",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      "#include <common>\nvarying float vInstanceOpacity;",
    )
    .replace(
      "#include <alphamap_fragment>",
      "#include <alphamap_fragment>\ndiffuseColor.a *= vInstanceOpacity;",
    );
}

/** Module-level shader patcher: opacity + tint variant. */
function patchInstanceOpacityAndTint(
  shader: THREE.WebGLProgramParametersWithUniforms,
): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\nattribute float instanceOpacity;\nattribute float instanceTint;\nvarying float vInstanceOpacity;\nvarying float vInstanceTint;",
    )
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvInstanceOpacity = instanceOpacity;\nvInstanceTint = instanceTint;",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      "#include <common>\nvarying float vInstanceOpacity;\nvarying float vInstanceTint;\nuniform vec3 instanceTintColor;",
    )
    .replace(
      "#include <alphamap_fragment>",
      "#include <alphamap_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, instanceTintColor, vInstanceTint);\ndiffuseColor.a *= vInstanceOpacity;",
    );
}
