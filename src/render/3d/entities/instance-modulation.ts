/**
 * Per-instance opacity for THREE.InstancedMesh.
 *
 * three.js exposes per-instance matrix and per-instance color natively
 * but not per-instance opacity. This module plumbs an `instanceOpacity`
 * float attribute through an `onBeforeCompile` shader patch — the
 * fragment shader multiplies its final alpha by the per-instance value
 * after the standard alpha-map chunk so existing material features
 * (alphaMap, alphaTest, etc.) still compose.
 *
 * Usage:
 *
 *   const opacityAttr = attachInstanceOpacity(mesh, capacity);
 *   // write into opacityAttr.array (Float32Array), then:
 *   opacityAttr.needsUpdate = true;
 *
 * The patcher is module-level (referenced by identity) so three.js's
 * program cache treats every patched material as one shader variant —
 * defining the patcher inline per call would compile a new program per
 * material.
 */

import * as THREE from "three";

/** Attach a `Float32` per-instance opacity attribute to `mesh.geometry`,
 *  patch every material on `mesh` to multiply final alpha by it, and
 *  flag the material(s) transparent so the alpha multiply takes effect.
 *  Returns the underlying attribute so callers can write into
 *  `attr.array` (Float32Array) directly. */
export function attachInstanceOpacity(
  mesh: THREE.InstancedMesh,
  capacity: number,
): THREE.InstancedBufferAttribute {
  const data = new Float32Array(capacity);
  data.fill(1);
  const attr = new THREE.InstancedBufferAttribute(data, 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  mesh.geometry.setAttribute("instanceOpacity", attr);

  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];
  for (const material of materials) {
    material.transparent = true;
    material.onBeforeCompile = patchInstanceOpacity;
    material.needsUpdate = true;
  }
  return attr;
}

/** Module-level shader patcher shared across every patched material so
 *  three.js's program cache treats them as one shader variant. Injects
 *  the per-instance opacity varying through `<common>` / `<begin_vertex>`
 *  in the vertex shader and multiplies `diffuseColor.a` after the
 *  standard `<alphamap_fragment>` chunk so alpha-map-driven materials
 *  still compose correctly. */
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
