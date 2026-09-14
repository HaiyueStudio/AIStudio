import { Entity, Mesh3D, BasicMaterial, PbrMaterial } from '@haiyue/engine';
import { BlinnPhongMaterial } from '@haiyue/engine/material';

export function readPlayMaterialColor(entity: Entity): readonly number[] | null {
  const material = entity.getComponent(Mesh3D)?.material;
  const color = material instanceof PbrMaterial ? material.baseColor : material instanceof BasicMaterial ? material.color : material instanceof BlinnPhongMaterial ? material.diffuse : null;
  return color ? Object.freeze([...color.writeSRGB(new Float32Array(4))]) : null;
}

/** Update the actual renderer material through its public setter (including GPU revision). */
export function setPlayMaterialColor(entity: Entity, value: unknown, entities: Iterable<Entity>): void {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) throw new TypeError('Material color requires four finite sRGB RGBA channels in 0..1.');
  const mesh = entity.getComponent(Mesh3D);
  const source = mesh?.material;
  if (!mesh || !(source instanceof PbrMaterial || source instanceof BasicMaterial || source instanceof BlinnPhongMaterial)) throw new Error('Target requires a Basic, PBR or Blinn-Phong Mesh3D; use instances.set for instanced colors.');
  let material: PbrMaterial | BasicMaterial | BlinnPhongMaterial = source;
  // Preserve textures/settings while isolating a target that shares a material with another object.
  for (const other of entities) if (other !== entity && other.getComponent(Mesh3D)?.material === material) { material = material instanceof BasicMaterial ? new BasicMaterial({color: material.color, texture: material.texture, emissiveFactor: material.emissiveFactor, emissiveTexture: material.emissiveTexture, blending: material.blending, depthWrite: material.depthWrite, cullMode: material.cullMode, frontFace: material.frontFace, sampler: material.sampler}) : material.clone(); mesh.material = material; break; }
  const color: [number, number, number, number] = [value[0], value[1], value[2], value[3]];
  if (material instanceof PbrMaterial) material.baseColor = color;
  else if (material instanceof BasicMaterial) material.color = color;
  else material.diffuse = color;
}
