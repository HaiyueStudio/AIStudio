import type { ComponentDefinitionV2, JsonObject, M12CapabilityId } from '@haiyue/ai-studio-contracts';

const COMMON = Object.freeze({
  schemaVersion: 2,
  owner: 'g08-render-assets-effects-adapters',
  validation: Object.freeze({ mode: 'json-schema', unknownProperties: 'reject', maxSerializedBytes: 64 * 1024 }),
  serializable: true,
  serialization: Object.freeze({ format: 'json', persistDisabled: true }),
  testOwner: 'g08-render-assets-effects-adapters',
} as const);

const number = (minimum?: number, maximum?: number): JsonObject => ({ type: 'number', ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) });
const integer = (minimum?: number, maximum?: number): JsonObject => ({ type: 'integer', ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) });
const array = (length: number, item: JsonObject = number()): JsonObject => ({ type: 'array', minItems: length, maxItems: length, items: item });
const object = (properties: JsonObject, required: readonly string[]): JsonObject => ({ type: 'object', additionalProperties: false, properties, required: [...required] });
const vec3 = (): JsonObject => object({ x: number(), y: number(), z: number() }, ['x', 'y', 'z']);
const transform = (): JsonObject => object({ position: vec3(), rotationDegrees: vec3(), scale: vec3() }, ['position', 'rotationDegrees', 'scale']);

function definition(
  type: string,
  capability: M12CapabilityId,
  effect: ComponentDefinitionV2['effect'],
  risk: ComponentDefinitionV2['risk'],
  label: string,
  category: string,
  runtimeAdapter: string | null,
  valueSchema: JsonObject,
  defaults: JsonObject,
): ComponentDefinitionV2 {
  return Object.freeze({
    ...COMMON,
    type,
    version: '1.0.0',
    capability,
    effect,
    risk,
    valueSchema,
    defaults,
    editor: Object.freeze({ label, category, inspector: `inspector.${type.slice('haiyue.'.length)}` }),
    runtimeAdapter,
  }) as ComponentDefinitionV2;
}

const postProcessPass = object({
  kind: { enum: ['fxaa', 'taa', 'gaussian-blur', 'outline', 'grayscale', 'motion-blur', 'gtao', 'sao', 'ssao'] },
  enabled: { type: 'boolean' }, order: integer(0, 255), radius: number(0, 64), sigma: number(0.0001, 64),
  feedback: number(0, 0.99), sharpness: number(0, 1), intensity: number(0, 16), sampleCount: integer(1, 32),
  maxBlurPixels: number(0, 256), blendMode: { enum: ['add', 'multiply', 'replace'] }, quality: { enum: ['low', 'medium', 'high'] },
  visibleColor: array(4, number(0, 1)), hiddenColor: array(4, number(0, 1)),
}, ['kind', 'enabled', 'order', 'radius', 'sigma', 'feedback', 'sharpness', 'intensity', 'sampleCount', 'maxBlurPixels', 'blendMode', 'quality', 'visibleColor', 'hiddenColor']);

const particleCommon = {
  maxParticles: integer(1, 20_000), emissionRate: number(0, 20_000), burst: integer(0, 20_000), duration: number(0.001, 3_600),
  loop: { type: 'boolean' }, seed: integer(1, 4_294_967_295), lifetime: array(2), speed: array(2), startSize: array(2, number(0)), endSize: array(2, number(0)),
  startColor: array(4, number(0, 1)), endColor: array(4, number(0, 1)), blendMode: { enum: ['normal', 'additive'] }, playing: { type: 'boolean' }, emitting: { type: 'boolean' },
} satisfies JsonObject;
const particleRequired = ['maxParticles', 'emissionRate', 'burst', 'duration', 'loop', 'seed', 'lifetime', 'speed', 'startSize', 'endSize', 'startColor', 'endColor', 'blendMode', 'playing', 'emitting'];

export const G08_COMPONENT_DEFINITIONS: readonly ComponentDefinitionV2[] = Object.freeze([
  definition('haiyue.render.profile', 'material.pbr', 'gpu-owner', 'medium', 'Render Profile', 'Rendering', 'adapter.render.profile',
    object({ profile: { enum: ['simple', 'batched', 'gpu-driven', 'diagnostic'] }, msaaSamples: { enum: [1, 4] }, clearColor: array(4, number(0, 1)), devicePixelRatio: number(0.25, 4), maxRenderPixels: integer(65_536, 33_554_432) }, ['profile', 'msaaSamples', 'clearColor', 'devicePixelRatio', 'maxRenderPixels']),
    { profile: 'batched', msaaSamples: 1, clearColor: [0.03, 0.03, 0.03, 1], devicePixelRatio: 1, maxRenderPixels: 8_388_608 }),
  definition('haiyue.material.pbr', 'material.pbr', 'gpu-owner', 'medium', 'PBR Material', 'Materials', 'adapter.material.pbr',
    object({ baseColor: array(4, number(0, 1)), metallic: number(0, 1), roughness: number(0, 1), emissiveFactor: array(3, number(0)), normalScale: number(0, 8), occlusionStrength: number(0, 1), alphaMode: { enum: ['opaque', 'mask', 'blend'] }, alphaCutoff: number(0, 1), doubleSided: { type: 'boolean' }, baseColorAssetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' }, metallicRoughnessAssetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' }, normalAssetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' }, occlusionAssetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' }, emissiveAssetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' } }, ['baseColor', 'metallic', 'roughness', 'emissiveFactor', 'normalScale', 'occlusionStrength', 'alphaMode', 'alphaCutoff', 'doubleSided', 'baseColorAssetId', 'metallicRoughnessAssetId', 'normalAssetId', 'occlusionAssetId', 'emissiveAssetId']),
    { baseColor: [0.16, 0.58, 1, 1], metallic: 0.05, roughness: 0.65, emissiveFactor: [0, 0, 0], normalScale: 1, occlusionStrength: 1, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, baseColorAssetId: 'asset:unbound-base-color', metallicRoughnessAssetId: 'asset:unbound-metallic-roughness', normalAssetId: 'asset:unbound-normal', occlusionAssetId: 'asset:unbound-occlusion', emissiveAssetId: 'asset:unbound-emissive' }),
  definition('haiyue.light.environment', 'lighting', 'gpu-owner', 'medium', 'Environment Light', 'Lighting', 'adapter.light.environment',
    object({ intensity: number(0, 100), rotationDegrees: number(-360_000, 360_000), diffuseColor: array(3, number(0)), specularColor: array(3, number(0)), diffuseAssetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' }, specularAssetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' } }, ['intensity', 'rotationDegrees', 'diffuseColor', 'specularColor', 'diffuseAssetId', 'specularAssetId']),
    { intensity: 1, rotationDegrees: 0, diffuseColor: [0.39, 0.39, 0.39], specularColor: [0.88, 0.88, 0.88], diffuseAssetId: 'asset:unbound-diffuse', specularAssetId: 'asset:unbound-specular' }),
  definition('haiyue.render.fog', 'lighting', 'gpu-owner', 'medium', 'Fog', 'Lighting', 'adapter.render.fog',
    object({ mode: { enum: ['distance', 'height'] }, color: array(4, number(0, 1)), maxOpacity: number(0, 1), distanceStart: number(0, 1_000_000), distanceEnd: number(0, 1_000_000), baseHeight: number(-1_000_000, 1_000_000), density: number(0, 1_000), heightFalloff: number(0, 1_000) }, ['mode', 'color', 'maxOpacity', 'distanceStart', 'distanceEnd', 'baseHeight', 'density', 'heightFalloff']),
    { mode: 'distance', color: [0.62, 0.7, 0.8, 1], maxOpacity: 1, distanceStart: 10, distanceEnd: 60, baseHeight: 0, density: 0.04, heightFalloff: 0.2 }),
  definition('haiyue.render.postprocess-stack', 'postprocess', 'gpu-owner', 'medium', 'Post-process Stack', 'Rendering', 'adapter.render.postprocess-stack',
    object({ passes: { type: 'array', maxItems: 16, items: postProcessPass } }, ['passes']), { passes: [] }),
  definition('haiyue.particles.2d', 'particles.2d', 'gpu-owner', 'medium', 'Particle Emitter 2D', 'Effects', 'adapter.particles.2d',
    object({ ...particleCommon, angleDegrees: array(2), gravity: array(2), shape: { enum: ['point', 'box', 'circle'] }, shapeSize: array(2, number(0)), shapeRadius: number(0, 100_000), radial: { type: 'boolean' } }, [...particleRequired, 'angleDegrees', 'gravity', 'shape', 'shapeSize', 'shapeRadius', 'radial']),
    { maxParticles: 512, emissionRate: 30, burst: 0, duration: 60, loop: true, seed: 1, lifetime: [0.8, 1.6], speed: [40, 100], startSize: [8, 18], endSize: [0, 4], startColor: [1, 1, 1, 1], endColor: [1, 1, 1, 0], blendMode: 'additive', playing: true, emitting: true, angleDegrees: [0, 360], gravity: [0, -20], shape: 'point', shapeSize: [0, 0], shapeRadius: 0, radial: true }),
  definition('haiyue.particles.3d', 'particles.3d', 'gpu-owner', 'medium', 'Particle Emitter 3D', 'Effects', 'adapter.particles.3d',
    object({ ...particleCommon, direction: array(3), spreadDegrees: number(0, 180), gravity: array(3), rotationDegrees: array(2), angularVelocityDegrees: array(2), shape: { enum: ['point', 'box', 'sphere'] }, shapeSize: array(3, number(0)), shapeRadius: number(0, 100_000), radial: { type: 'boolean' }, opacity: number(0, 1), depthTest: { type: 'boolean' }, depthWrite: { type: 'boolean' }, sortMode: { enum: ['none', 'back-to-front'] } }, [...particleRequired, 'direction', 'spreadDegrees', 'gravity', 'rotationDegrees', 'angularVelocityDegrees', 'shape', 'shapeSize', 'shapeRadius', 'radial', 'opacity', 'depthTest', 'depthWrite', 'sortMode']),
    { maxParticles: 1024, emissionRate: 60, burst: 0, duration: 60, loop: true, seed: 1, lifetime: [1, 2], speed: [1, 3], startSize: [0.08, 0.2], endSize: [0, 0.06], startColor: [1, 1, 1, 1], endColor: [1, 1, 1, 0], blendMode: 'additive', playing: true, emitting: true, direction: [0, 1, 0], spreadDegrees: 180, gravity: [0, -1, 0], rotationDegrees: [0, 360], angularVelocityDegrees: [0, 0], shape: 'point', shapeSize: [0, 0, 0], shapeRadius: 0, radial: true, opacity: 1, depthTest: true, depthWrite: false, sortMode: 'none' }),
  definition('haiyue.animation.transform-clips', 'animation.3d', 'runtime-owner', 'medium', '3D Transform Clips', 'Animation', 'adapter.animation.3d-mixer',
    object({ initialClip: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,95}$' }, playing: { type: 'boolean' }, speed: number(0, 100), clips: { type: 'array', minItems: 1, maxItems: 64, items: object({ name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,95}$' }, durationTicks: integer(1, 1_000_000), loop: { type: 'boolean' }, from: transform(), to: transform() }, ['name', 'durationTicks', 'loop', 'from', 'to']) } }, ['initialClip', 'playing', 'speed', 'clips']),
    { initialClip: 'Idle', playing: true, speed: 1, clips: [{ name: 'Idle', durationTicks: 60, loop: true, from: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, to: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 360, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] }),
  definition('haiyue.animation.2d', 'animation.2d', 'gpu-owner', 'medium', 'HaiYue Animation 2D', 'Animation', 'adapter.animation.2d',
    object({ assetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' }, autoplay: { type: 'boolean' }, loop: { type: 'boolean' }, speed: number(0, 100), startTime: number(0, 86_400), maxMaskTargets: integer(1, 128) }, ['assetId', 'autoplay', 'loop', 'speed', 'startTime', 'maxMaskTargets']),
    { assetId: 'asset:unbound-animation', autoplay: true, loop: true, speed: 1, startTime: 0, maxMaskTargets: 32 }),
  definition('haiyue.animation.state', 'animation.3d', 'data', 'low', 'Animation State', 'Animation', null,
    object({ state: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,95}$' }, clip: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,95}$' }, transitionTicks: integer(0, 100_000) }, ['state', 'clip', 'transitionTicks']), { state: 'default', clip: 'Idle', transitionTicks: 0 }),
  definition('haiyue.audio.mixer', 'audio.playback', 'audio-owner', 'medium', 'Audio Mixer', 'Audio', 'adapter.audio.mixer',
    object({ masterVolume: number(0, 1), muted: { type: 'boolean' }, buses: { type: 'array', maxItems: 32, items: object({ name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,63}$' }, volume: number(0, 1), muted: { type: 'boolean' } }, ['name', 'volume', 'muted']) } }, ['masterVolume', 'muted', 'buses']),
    { masterVolume: 1, muted: false, buses: [{ name: 'master', volume: 1, muted: false }, { name: 'music', volume: 0.7, muted: false }, { name: 'sfx', volume: 1, muted: false }] }),
  definition('haiyue.audio.source', 'audio.playback', 'audio-owner', 'medium', 'Audio Source', 'Audio', 'adapter.audio.source',
    object({ assetIds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' } }, bus: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,63}$' }, volume: number(0, 1), autoplay: { type: 'boolean' }, loop: { type: 'boolean' } }, ['assetIds', 'bus', 'volume', 'autoplay', 'loop']),
    { assetIds: ['asset:unbound-audio'], bus: 'sfx', volume: 1, autoplay: false, loop: false }),
  definition('haiyue.model.gltf', 'asset.import', 'gpu-owner', 'medium', 'glTF Model', 'Models', 'adapter.model.gltf',
    object({ assetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' }, scene: integer(0, 65_535), autoLoad: { type: 'boolean' }, clearPrevious: { type: 'boolean' }, baseColorFactor: array(4, number(0, 1)), loadTimeoutMs: integer(100, 120_000) }, ['assetId', 'scene', 'autoLoad', 'clearPrevious', 'baseColorFactor', 'loadTimeoutMs']),
    { assetId: 'asset:unbound-model', scene: 0, autoLoad: true, clearPrevious: true, baseColorFactor: [1, 1, 1, 1], loadTimeoutMs: 30_000 }),
  definition('haiyue.asset.reference', 'asset.import', 'data', 'low', 'Asset Reference', 'Assets', null,
    object({ assetId: { type: 'string', pattern: '^asset:[A-Za-z0-9._:-]{3,120}$' }, usage: { enum: ['texture.base-color', 'texture.metallic-roughness', 'texture.normal', 'texture.occlusion', 'texture.emissive', 'texture.environment-diffuse', 'texture.environment-specular', 'model', 'audio', 'animation'] } }, ['assetId', 'usage']),
    { assetId: 'asset:unbound-reference', usage: 'texture.base-color' }),
]);
