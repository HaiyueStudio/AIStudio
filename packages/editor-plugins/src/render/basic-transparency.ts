import { BasicMaterial } from '@haiyue/engine';

export interface BasicTransparencyOptions {
  readonly blending?: 'auto' | 'none' | 'normal' | 'additive';
  readonly depthWrite?: boolean | 'auto';
}

export const BASIC_TRANSPARENCY_PROPERTIES = {
  blending: { enum: ['auto', 'none', 'normal', 'additive'], description: 'Basic material only. auto (default) uses normal blending when color alpha < 1; none explicitly renders opaque. Use normal for transparent textures even when color alpha is 1.' },
  depthWrite: { enum: ['auto', true, false], description: 'Basic material only. auto (default) writes depth for opaque materials and disables writes for transparent materials. Depth testing remains enabled.' },
};

export function basicTransparencyOptions(value: Readonly<Record<string, unknown>> | BasicTransparencyOptions): BasicTransparencyOptions {
  if (value.blending !== undefined && !['auto', 'none', 'normal', 'additive'].includes(value.blending as string)) throw new TypeError('blending must be auto, none, normal or additive.');
  if (value.depthWrite !== undefined && value.depthWrite !== 'auto' && typeof value.depthWrite !== 'boolean') throw new TypeError('depthWrite must be auto or a boolean.');
  return { ...(value.blending === undefined ? {} : { blending: value.blending as BasicTransparencyOptions['blending'] }), ...(value.depthWrite === undefined ? {} : { depthWrite: value.depthWrite as BasicTransparencyOptions['depthWrite'] }) };
}

/** Preserve authored policy, rather than mistaking an automatically resolved GPU state for an explicit override. */
const policies = new WeakMap<BasicMaterial, BasicTransparencyOptions>();
function applyTransparency(material: BasicMaterial, alpha: number, options: BasicTransparencyOptions): void {
  const blending = !options.blending || options.blending === 'auto' ? (alpha < 1 ? 'normal' : 'none') : options.blending;
  material.blending = blending;
  material.depthWrite = typeof options.depthWrite === 'boolean' ? options.depthWrite : blending === 'none';
}

export function createAuthoringBasicMaterial(color: readonly [number, number, number, number], options: BasicTransparencyOptions = {}): BasicMaterial {
  const policy = basicTransparencyOptions(options);
  const material = new BasicMaterial({ color });
  policies.set(material, policy);
  applyTransparency(material, color[3], policy);
  return material;
}

export function copyBasicTransparencyPolicy(source: BasicMaterial, target: BasicMaterial): void {
  const policy = policies.get(source);
  if (policy) policies.set(target, policy);
}

export function setAuthoringBasicMaterialColor(material: BasicMaterial, color: [number, number, number, number]): void {
  material.color = color;
  const policy = policies.get(material);
  if (policy) applyTransparency(material, color[3], policy);
}
