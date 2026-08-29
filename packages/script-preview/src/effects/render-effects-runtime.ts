import { Camera2D, CartesianTransform3D, Mesh3D, Transform2D, type Entity, type HaiyueEngine, type Scene } from '@haiyue/engine';
import { MusicPlayerComponent, ParticleEmitter2D, ParticleEmitter3D } from '@haiyue/engine/components';
import { DirectionalLight, EnvironmentLight, Fog, type EnvironmentCubeTexture } from '@haiyue/engine/lighting';
import { PbrMaterial, type MaterialTextureSource } from '@haiyue/engine/material';
import { FxaaPass, GaussianBlurPass, GrayscalePass, GtaoPass, MotionBlurPass, OutlinePass, PostProcessRenderFeature, SaoPass, SsaoPass, TaaPass, type PostProcessPass } from '@haiyue/engine/postprocess';
import { Particle2DRenderSystem, Particle2DSystem, Particle3DRenderSystem, Particle3DSystem } from '@haiyue/engine/systems';
import { GltfModelComponent, GltfModelSystem } from '@haiyue/extensions/gltf';
import { Animation2DComponent, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import {
  Animation3DMixer,
  Animation3DPoseApplier,
  Animation3DPoseBuffer,
  type Animation3DAction,
  type Animation3DBinding,
  type Animation3DBindingResolver,
  type Animation3DClip,
  type Animation3DResolvedBinding,
} from '@haiyue/extensions/animation3d';
import type { AnimationSource } from '@haiyue/animation-spec';

export type RenderProfileName = 'simple' | 'batched' | 'gpu-driven' | 'diagnostic';

export interface RenderEffectComponent {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface RenderEffectSceneEntity {
  readonly id: string;
  readonly name: string;
  readonly components?: readonly RenderEffectComponent[];
}

export interface ResolvedAudioAsset { readonly url: string; release(): void; }
export interface ResolvedModelAsset { readonly url: string; release(): void; }
export interface ResolvedTextureAsset { readonly texture: MaterialTextureSource; release(): void; }
export interface ResolvedAnimationAsset { readonly source: AnimationSource; release(): void; }
export interface ResolvedEnvironmentAsset { readonly texture: EnvironmentCubeTexture | GPUTexture; release(): void; }
export interface RenderEffectsRuntimeOptions {
  readonly engine: HaiyueEngine;
  readonly scene: Scene;
  readonly sceneEntities: readonly RenderEffectSceneEntity[];
  readonly entitiesByStableId: ReadonlyMap<string, Entity>;
  readonly resolveAudioAsset?: (assetId: string, signal: AbortSignal) => Promise<ResolvedAudioAsset>;
  readonly resolveModelAsset?: (assetId: string, signal: AbortSignal) => Promise<ResolvedModelAsset>;
  readonly resolveTextureAsset?: (assetId: string, signal: AbortSignal) => Promise<ResolvedTextureAsset>;
  readonly resolveAnimationAsset?: (assetId: string, signal: AbortSignal) => Promise<ResolvedAnimationAsset>;
  readonly resolveEnvironmentAsset?: (assetId: string, signal: AbortSignal) => Promise<ResolvedEnvironmentAsset>;
  readonly signal?: AbortSignal;
}

export interface RenderEngineProfile {
  readonly renderProfile: RenderProfileName;
  readonly msaaSamples: 1 | 4;
  readonly clearColor: Readonly<{ r: number; g: number; b: number; a: number }>;
  readonly devicePixelRatio: number;
  readonly maxRenderPixels: number;
}

export interface RenderEffectManifest {
  readonly schemaVersion: 1;
  readonly render: RenderEngineProfile;
  readonly viewport: Readonly<{ width: number; height: number; pixelWidth: number; pixelHeight: number }>;
  readonly postprocess: readonly Readonly<{ kind: string; order: number; enabled: boolean }>[];
  readonly owners: Readonly<{ materials: number; textures: number; models: number; lighting: number; fog: number; particles2d: number; particles3d: number; animations2d: number; animations3d: number; audio: number }>;
  readonly device: 'active' | 'lost';
}

interface AnimationOwner {
  readonly entity: Entity;
  readonly entityId: string;
  readonly descriptor: RenderEffectComponent;
  readonly mixer: Animation3DMixer;
  readonly pose: Animation3DPoseBuffer;
  readonly applier: Animation3DPoseApplier;
  readonly actions: ReadonlyMap<string, Animation3DAction>;
  selectedClip: string;
}

export class RenderEffectsPlayRuntime {
  private readonly installedComponents: Array<Readonly<{ entity: Entity; component: object }>> = [];
  private readonly installedSystems: object[] = [];
  private readonly runtimeAssets: Array<Readonly<{ release(): void }>> = [];
  private readonly restorations: Array<() => void> = [];
  private readonly animations: AnimationOwner[] = [];
  private readonly tickingSystems: Array<{ disabled: boolean }> = [];
  private readonly postprocess: Array<Readonly<{ kind: string; order: number; enabled: boolean }>> = [];
  private disposed = false;
  private deviceLost = false;
  private counts = { materials: 0, textures: 0, models: 0, lighting: 0, fog: 0, particles2d: 0, particles3d: 0, animations2d: 0, animations3d: 0, audio: 0 };

  private constructor(private readonly options: RenderEffectsRuntimeOptions, private readonly profile: RenderEngineProfile) {}

  static engineProfile(sceneEntities: readonly RenderEffectSceneEntity[]): RenderEngineProfile {
    const value = findEnabled(sceneEntities, 'haiyue.render.profile')?.value;
    const color = tuple(value?.clearColor, 4, [0.03, 0.03, 0.03, 1]);
    return Object.freeze({
      renderProfile: enumValue(value?.profile, ['simple', 'batched', 'gpu-driven', 'diagnostic'], 'batched'),
      msaaSamples: value?.msaaSamples === 4 ? 4 : 1,
      clearColor: Object.freeze({ r: color[0], g: color[1], b: color[2], a: color[3] }),
      devicePixelRatio: finite(value?.devicePixelRatio, 0.25, 4, 1),
      maxRenderPixels: integer(value?.maxRenderPixels, 65_536, 33_554_432, 8_388_608),
    });
  }

  static async create(options: RenderEffectsRuntimeOptions): Promise<RenderEffectsPlayRuntime> {
    throwIfAborted(options.signal);
    const runtime = new RenderEffectsPlayRuntime(options, RenderEffectsPlayRuntime.engineProfile(options.sceneEntities));
    try {
      await runtime.install();
      throwIfAborted(options.signal);
      return runtime;
    } catch (cause) {
      runtime.dispose();
      throw cause;
    }
  }

  beforeTick(tick: number): void {
    if (this.disposed || this.deviceLost) return;
    for (const owner of this.animations) {
      const value = owner.descriptor.value;
      if (value.playing !== true) continue;
      const initial = typeof value.initialClip === 'string' ? value.initialClip : '';
      const state = findEntityComponent(this.options.sceneEntities, owner.entityId, 'haiyue.animation.state');
      const requested = typeof state?.value.clip === 'string' ? state.value.clip : initial;
      const action = owner.actions.get(requested) ?? owner.actions.values().next().value;
      if (!action) continue;
      if (owner.selectedClip !== action.clip.id) {
        const previous = owner.actions.get(owner.selectedClip);
        action.reset().startAt(owner.mixer.time).play();
        const transitionSeconds = integer(state?.value.transitionTicks, 0, 100_000, 0) / 60;
        if (previous && transitionSeconds > 0) previous.crossFadeTo(action, transitionSeconds);
        else { previous?.stop(); action.play(); }
        owner.selectedClip = action.clip.id;
      }
      const speed = finite(value.speed, 0, 100, 1);
      owner.applier.apply(owner.mixer.setTime(Math.max(owner.mixer.time, tick * speed / 60), owner.pose));
    }
  }

  manifest(): RenderEffectManifest {
    const width = integer(this.options.engine.width, 1, 100_000, 1);
    const height = integer(this.options.engine.height, 1, 100_000, 1);
    const scale = Math.min(this.profile.devicePixelRatio, Math.sqrt(this.profile.maxRenderPixels / (width * height)));
    return Object.freeze({
      schemaVersion: 1,
      render: this.profile,
      viewport: Object.freeze({ width, height, pixelWidth: Math.max(1, Math.floor(width * scale)), pixelHeight: Math.max(1, Math.floor(height * scale)) }),
      postprocess: Object.freeze([...this.postprocess]), owners: Object.freeze({ ...this.counts }), device: this.deviceLost ? 'lost' : 'active',
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.engine.off('device-lost', this.onDeviceLost);
    this.options.engine.off('device-restored', this.onDeviceRestored);
    for (const item of this.installedComponents.splice(0).reverse()) {
      try { item.entity.removeComponent(item.component as never); } catch { /* Scene destruction remains the final owner. */ }
    }
    for (const system of this.installedSystems.splice(0).reverse()) {
      try { this.options.scene.world.removeSystem(system as never); } catch { /* Scene destruction remains the final owner. */ }
    }
    this.tickingSystems.length = 0;
    for (const owner of this.animations.splice(0).reverse()) { try { owner.mixer.destroy(); } catch { /* Mixer teardown is idempotent at this owner boundary. */ } }
    for (const restore of this.restorations.splice(0).reverse()) { try { restore(); } catch { /* Scene destruction remains the final owner. */ } }
    for (const asset of this.runtimeAssets.splice(0).reverse()) { try { asset.release(); } catch { /* Release is best effort during stop. */ } }
    this.postprocess.length = 0;
    this.counts = { materials: 0, textures: 0, models: 0, lighting: 0, fog: 0, particles2d: 0, particles3d: 0, animations2d: 0, animations3d: 0, audio: 0 };
  }

  private async install(): Promise<void> {
    this.options.engine.on('device-lost', this.onDeviceLost);
    this.options.engine.on('device-restored', this.onDeviceRestored);
    const mixer = findEnabled(this.options.sceneEntities, 'haiyue.audio.mixer')?.value;
    for (const source of this.options.sceneEntities) {
      const entity = this.options.entitiesByStableId.get(source.id);
      if (!entity) throw new Error(`render.stale-entity: ${source.id}.`);
      for (const descriptor of source.components ?? []) {
        if (!descriptor.enabled) continue;
        if (descriptor.type === 'haiyue.material.pbr') await this.installMaterial(entity, descriptor);
        else if (descriptor.type === 'haiyue.light.directional') this.configureDirectionalShadow(entity, descriptor);
        else if (descriptor.type === 'haiyue.light.environment') await this.installEnvironment(entity, descriptor);
        else if (descriptor.type === 'haiyue.render.fog') this.installFog(entity, descriptor);
        else if (descriptor.type === 'haiyue.particles.2d') this.installParticle2D(entity, descriptor);
        else if (descriptor.type === 'haiyue.particles.3d') this.installParticle3D(entity, descriptor);
        else if (descriptor.type === 'haiyue.animation.transform-clips') this.installAnimation3D(entity, source.id, descriptor);
        else if (descriptor.type === 'haiyue.animation.2d') await this.installAnimation2D(entity, descriptor);
        else if (descriptor.type === 'haiyue.audio.source') await this.installAudio(entity, descriptor, mixer);
        else if (descriptor.type === 'haiyue.model.gltf') await this.installModel(entity, descriptor);
      }
    }
    this.installPostprocess();
    this.installParticleSystems();
    this.installAnimation2DSystems();
    this.installModelSystem();
  }

  private async installMaterial(entity: Entity, descriptor: RenderEffectComponent): Promise<void> {
    const mesh = entity.getComponent(Mesh3D);
    if (!mesh) throw new Error(`render.material-target-invalid: ${entity.name} has no Mesh3D.`);
    const value = descriptor.value;
    const baseColorTexture = await this.resolveTexture(value.baseColorAssetId);
    const metallicRoughnessTexture = await this.resolveTexture(value.metallicRoughnessAssetId);
    const normalTexture = await this.resolveTexture(value.normalAssetId);
    const occlusionTexture = await this.resolveTexture(value.occlusionAssetId);
    const emissiveTexture = await this.resolveTexture(value.emissiveAssetId);
    const material = new PbrMaterial({
      baseColor: tuple(value.baseColor, 4, [0.16, 0.58, 1, 1]), metallic: finite(value.metallic, 0, 1, 0.05), roughness: finite(value.roughness, 0, 1, 0.65),
      emissiveFactor: tuple(value.emissiveFactor, 3, [0, 0, 0]), normalScale: finite(value.normalScale, 0, 8, 1), occlusionStrength: finite(value.occlusionStrength, 0, 1, 1),
      alphaMode: enumValue(value.alphaMode, ['opaque', 'mask', 'blend'], 'opaque'), alphaCutoff: finite(value.alphaCutoff, 0, 1, 0.5), doubleSided: value.doubleSided === true,
      ...(baseColorTexture === null ? {} : { baseColorTexture }),
      ...(metallicRoughnessTexture === null ? {} : { metallicRoughnessTexture }),
      ...(normalTexture === null ? {} : { normalTexture }),
      ...(occlusionTexture === null ? {} : { occlusionTexture }),
      ...(emissiveTexture === null ? {} : { emissiveTexture }),
    });
    const previous = mesh.material;
    mesh.material = material;
    this.restorations.push(() => { mesh.material = previous; });
    this.counts.materials++;
  }

  private async resolveTexture(assetId: unknown): Promise<MaterialTextureSource> {
    if (typeof assetId !== 'string' || assetId.startsWith('asset:unbound-')) return null;
    if (!this.options.resolveTextureAsset) throw new Error(`texture.asset-resolver-unavailable: Play cannot resolve ${assetId}.`);
    throwIfAborted(this.options.signal);
    const asset = await this.options.resolveTextureAsset(assetId, this.runtimeSignal());
    this.runtimeAssets.push(asset);
    this.counts.textures++;
    throwIfAborted(this.options.signal);
    return asset.texture;
  }

  private async installModel(entity: Entity, descriptor: RenderEffectComponent): Promise<void> {
    const assetId = descriptor.value.assetId;
    if (typeof assetId !== 'string' || assetId.startsWith('asset:unbound-')) return;
    if (!this.options.resolveModelAsset) throw new Error(`model.asset-resolver-unavailable: Play cannot resolve ${assetId}.`);
    throwIfAborted(this.options.signal);
    const asset = await this.options.resolveModelAsset(assetId, this.runtimeSignal());
    this.runtimeAssets.push(asset);
    throwIfAborted(this.options.signal);
    const component = new GltfModelComponent({
      src: asset.url,
      scene: integer(descriptor.value.scene, 0, 65_535, 0),
      autoLoad: descriptor.value.autoLoad !== false,
      clearPrevious: descriptor.value.clearPrevious !== false,
      baseColorFactor: tuple(descriptor.value.baseColorFactor, 4, [1, 1, 1, 1]),
    });
    entity.addComponent(component);
    this.installedComponents.push({ entity, component });
    this.counts.models++;
  }

  private async installEnvironment(entity: Entity, descriptor: RenderEffectComponent): Promise<void> {
    const value = descriptor.value;
    const diffuseTexture = await this.resolveEnvironmentTexture(value.diffuseAssetId);
    const specularTexture = await this.resolveEnvironmentTexture(value.specularAssetId);
    const component = new EnvironmentLight({ intensity: finite(value.intensity, 0, 100, 1), rotation: finite(value.rotationDegrees, -360_000, 360_000, 0) * Math.PI / 180, diffuseColor: tuple(value.diffuseColor, 3, [0.39, 0.39, 0.39]), specularColor: tuple(value.specularColor, 3, [0.88, 0.88, 0.88]), diffuseTexture, specularTexture });
    entity.addComponent(component); this.installedComponents.push({ entity, component }); this.counts.lighting++;
  }

  private async resolveEnvironmentTexture(assetId: unknown): Promise<EnvironmentCubeTexture | GPUTexture | null> {
    if (typeof assetId !== 'string' || assetId.startsWith('asset:unbound-')) return null;
    if (!this.options.resolveEnvironmentAsset) throw new Error(`environment.asset-resolver-unavailable: Play cannot resolve ${assetId}.`);
    throwIfAborted(this.options.signal);
    const asset = await this.options.resolveEnvironmentAsset(assetId, this.runtimeSignal());
    this.runtimeAssets.push(asset);
    this.counts.textures++;
    throwIfAborted(this.options.signal);
    return asset.texture;
  }

  private configureDirectionalShadow(entity: Entity, descriptor: RenderEffectComponent): void {
    const light = entity.getComponent(DirectionalLight);
    if (!light) throw new Error(`render.light-target-invalid: ${entity.name} has no DirectionalLight.`);
    const value = descriptor.value, shadow = isRecord(value.shadow) ? value.shadow : {};
    const previousCastShadow = light.castShadow;
    const previousShadow = { ...light.shadow };
    this.restorations.push(() => { light.castShadow = previousCastShadow; light.shadow = previousShadow; light.markDirty(); });
    light.castShadow = value.castShadow !== false;
    light.shadow = {
      mapSize: shadow.mapSize === 512 || shadow.mapSize === 2048 ? shadow.mapSize : 1024,
      extent: finite(shadow.extent, 1, 100_000, 20), near: finite(shadow.near, 0.01, 100_000, 0.1), far: finite(shadow.far, 1, 1_000_000, 60),
      bias: finite(shadow.bias, 0, 1, 0.0015), normalBias: finite(shadow.normalBias, 0, 100, 0.02),
    };
    light.markDirty(); this.counts.lighting++;
  }

  private installFog(entity: Entity, descriptor: RenderEffectComponent): void {
    const value = descriptor.value;
    const component = new Fog({ mode: value.mode === 'height' ? 'height' : 'distance', color: tuple(value.color, 4, [0.62, 0.7, 0.8, 1]), maxOpacity: finite(value.maxOpacity, 0, 1, 1), distanceStart: finite(value.distanceStart, 0, 1_000_000, 10), distanceEnd: finite(value.distanceEnd, 0, 1_000_000, 60), baseHeight: finite(value.baseHeight, -1_000_000, 1_000_000, 0), density: finite(value.density, 0, 1_000, 0.04), heightFalloff: finite(value.heightFalloff, 0, 1_000, 0.2) });
    entity.addComponent(component); this.installedComponents.push({ entity, component }); this.counts.fog++;
  }

  private installParticle2D(entity: Entity, descriptor: RenderEffectComponent): void {
    const value = descriptor.value;
    const angle = tuple(value.angleDegrees, 2, [0, 360]);
    const component = new ParticleEmitter2D({ maxParticles: integer(value.maxParticles, 1, 20_000, 512), emissionRate: finite(value.emissionRate, 0, 20_000, 30), burst: integer(value.burst, 0, 20_000, 0), duration: finite(value.duration, 0.001, 3_600, 60), loop: value.loop === true, seed: integer(value.seed, 1, 4_294_967_295, 1), lifetime: tuple(value.lifetime, 2, [0.8, 1.6]), speed: tuple(value.speed, 2, [40, 100]), angle: [angle[0] * Math.PI / 180, angle[1] * Math.PI / 180], gravity: tuple(value.gravity, 2, [0, -20]), startSize: tuple(value.startSize, 2, [8, 18]), endSize: tuple(value.endSize, 2, [0, 4]), startColor: tuple(value.startColor, 4, [1, 1, 1, 1]), endColor: tuple(value.endColor, 4, [1, 1, 1, 0]), shape: enumValue(value.shape, ['point', 'box', 'circle'], 'point'), shapeSize: tuple(value.shapeSize, 2, [0, 0]), shapeRadius: finite(value.shapeRadius, 0, 100_000, 0), blendMode: value.blendMode === 'normal' ? 'normal' : 'additive', radial: value.radial === true, playing: value.playing === true, emitting: value.emitting === true });
    if (!entity.getComponent(Transform2D)) {
      const source = entity.getComponent(CartesianTransform3D);
      const transform = new Transform2D({ x: source?.position[0] ?? 0, y: source?.position[1] ?? 0 });
      entity.addComponent(transform); this.installedComponents.push({ entity, component: transform });
    }
    entity.addComponent(component); this.installedComponents.push({ entity, component }); this.counts.particles2d++;
  }

  private installParticle3D(entity: Entity, descriptor: RenderEffectComponent): void {
    const value = descriptor.value;
    const rotation = tuple(value.rotationDegrees, 2, [0, 360]), angular = tuple(value.angularVelocityDegrees, 2, [0, 0]);
    const component = new ParticleEmitter3D({ maxParticles: integer(value.maxParticles, 1, 20_000, 1024), emissionRate: finite(value.emissionRate, 0, 20_000, 60), burst: integer(value.burst, 0, 20_000, 0), duration: finite(value.duration, 0.001, 3_600, 60), loop: value.loop === true, seed: integer(value.seed, 1, 4_294_967_295, 1), lifetime: tuple(value.lifetime, 2, [1, 2]), speed: tuple(value.speed, 2, [1, 3]), direction: tuple(value.direction, 3, [0, 1, 0]), spread: finite(value.spreadDegrees, 0, 180, 180) * Math.PI / 180, gravity: tuple(value.gravity, 3, [0, -1, 0]), startSize: tuple(value.startSize, 2, [0.08, 0.2]), endSize: tuple(value.endSize, 2, [0, 0.06]), rotation: [rotation[0] * Math.PI / 180, rotation[1] * Math.PI / 180], angularVelocity: [angular[0] * Math.PI / 180, angular[1] * Math.PI / 180], startColor: tuple(value.startColor, 4, [1, 1, 1, 1]), endColor: tuple(value.endColor, 4, [1, 1, 1, 0]), shape: enumValue(value.shape, ['point', 'box', 'sphere'], 'point'), shapeSize: tuple(value.shapeSize, 3, [0, 0, 0]), shapeRadius: finite(value.shapeRadius, 0, 100_000, 0), blendMode: value.blendMode === 'normal' ? 'normal' : 'additive', radial: value.radial === true, playing: value.playing === true, emitting: value.emitting === true, opacity: finite(value.opacity, 0, 1, 1), depthTest: value.depthTest === true, depthWrite: value.depthWrite === true, sortMode: value.sortMode === 'back-to-front' ? 'back-to-front' : 'none' });
    entity.addComponent(component); this.installedComponents.push({ entity, component }); this.counts.particles3d++;
  }

  private async installAnimation2D(entity: Entity, descriptor: RenderEffectComponent): Promise<void> {
    const assetId = descriptor.value.assetId;
    if (typeof assetId !== 'string' || assetId.startsWith('asset:unbound-')) return;
    if (!this.options.resolveAnimationAsset) throw new Error(`animation.asset-resolver-unavailable: Play cannot resolve ${assetId}.`);
    throwIfAborted(this.options.signal);
    const asset = await this.options.resolveAnimationAsset(assetId, this.runtimeSignal());
    this.runtimeAssets.push(asset);
    throwIfAborted(this.options.signal);
    if (!entity.getComponent(Transform2D)) {
      const source = entity.getComponent(CartesianTransform3D);
      const transform = new Transform2D({ x: source?.position[0] ?? 0, y: source?.position[1] ?? 0 });
      entity.addComponent(transform);
      this.installedComponents.push({ entity, component: transform });
    }
    const component = new Animation2DComponent(asset.source, {
      autoplay: descriptor.value.autoplay !== false,
      loop: descriptor.value.loop !== false,
      speed: finite(descriptor.value.speed, 0, 100, 1),
      startTime: finite(descriptor.value.startTime, 0, 86_400, 0),
    });
    entity.addComponent(component);
    this.installedComponents.push({ entity, component });
    this.counts.animations2d++;
  }

  private installAnimation3D(entity: Entity, entityId: string, descriptor: RenderEffectComponent): void {
    const transform = entity.getComponent(CartesianTransform3D);
    if (!transform) throw new Error(`animation3d.target-invalid: ${entity.name} has no CartesianTransform3D.`);
    const resolver = new CartesianAnimation3DResolver(entityId, transform);
    const mixer = new Animation3DMixer(resolver);
    const pose = new Animation3DPoseBuffer();
    const applier = new Animation3DPoseApplier(resolver);
    try {
      const clips = compileTransformClips(descriptor, entityId);
      const actions = new Map<string, Animation3DAction>();
      for (const clip of clips) {
        const loop = transformClipLoop(descriptor, clip.id) ? 'repeat' : 'once';
        actions.set(clip.id, mixer.createAction(clip, { id: `${descriptor.id}:${clip.id}`, loop, repetitions: loop === 'repeat' ? Infinity : 1, clampWhenFinished: true }));
      }
      const initial = typeof descriptor.value.initialClip === 'string' ? descriptor.value.initialClip : '';
      const action = actions.get(initial) ?? actions.values().next().value;
      if (!action) throw new Error('animation3d.clip-empty: At least one validated clip is required.');
      action.play();
      this.animations.push({ entity, entityId, descriptor, mixer, pose, applier, actions, selectedClip: action.clip.id });
      this.counts.animations3d++;
    } catch (cause) {
      mixer.destroy();
      throw cause;
    }
  }

  private async installAudio(entity: Entity, descriptor: RenderEffectComponent, mixer: Readonly<Record<string, unknown>> | undefined): Promise<void> {
    if (!this.options.resolveAudioAsset) throw new Error('audio.asset-resolver-unavailable: Play cannot resolve controlled audio assets.');
    const ids = Array.isArray(descriptor.value.assetIds) ? descriptor.value.assetIds.filter((item): item is string => typeof item === 'string') : [];
    const resolved: ResolvedAudioAsset[] = [];
    for (const id of ids) {
      throwIfAborted(this.options.signal);
      const asset = await this.options.resolveAudioAsset(id, this.runtimeSignal());
      // Take ownership immediately: a later resolver may fail or be aborted.
      resolved.push(asset);
      this.runtimeAssets.push(asset);
      throwIfAborted(this.options.signal);
    }
    const bus = typeof descriptor.value.bus === 'string' ? descriptor.value.bus : 'master';
    const busDescriptor = Array.isArray(mixer?.buses) ? mixer.buses.filter(isRecord).find((candidate) => candidate.name === bus) : undefined;
    const muted = mixer?.muted === true || busDescriptor?.muted === true;
    const volume = muted ? 0 : finite(descriptor.value.volume, 0, 1, 1) * finite(mixer?.masterVolume, 0, 1, 1) * finite(busDescriptor?.volume, 0, 1, 1);
    const component = new MusicPlayerComponent({ urls: resolved.map((asset) => asset.url), volume, autoplay: descriptor.value.autoplay === true, loop: descriptor.value.loop === true });
    entity.addComponent(component);
    // Runtime adapters attach after preview entities already entered the World, so
    // explicitly enter the audio lifecycle that Entity.addComponent cannot replay.
    component.onEntityAddToWorld(entity, this.options.scene.world);
    this.installedComponents.push({ entity, component }); this.counts.audio++;
  }

  private installPostprocess(): void {
    const renderSystem = this.options.scene.render3DSystem;
    if (!renderSystem) return;
    const stacks = allEnabled(this.options.sceneEntities, 'haiyue.render.postprocess-stack');
    const descriptors = stacks.flatMap((stack) => Array.isArray(stack.value.passes) ? stack.value.passes.filter(isRecord) : [])
      .map((value, index) => ({ value, index, order: integer(value.order, 0, 255, index) }))
      .sort((left, right) => left.order - right.order || left.index - right.index);
    const passes: PostProcessPass[] = [];
    for (const descriptor of descriptors) {
      const kind = typeof descriptor.value.kind === 'string' ? descriptor.value.kind : 'fxaa';
      const enabled = descriptor.value.enabled === true;
      this.postprocess.push(Object.freeze({ kind, order: descriptor.order, enabled }));
      if (enabled) passes.push(createPostprocessPass(kind, descriptor.value));
    }
    if (stacks.length === 0) return;
    const feature = new PostProcessRenderFeature(renderSystem, passes);
    this.options.scene.addSystem(feature);
    this.installedSystems.push(feature);
  }

  private installParticleSystems(): void {
    if (this.counts.particles3d > 0) {
      const simulation = new Particle3DSystem({ maxDeltaSeconds: 0.1, priority: -10 });
      const renderer = new Particle3DRenderSystem(this.options.engine, this.options.scene.activeCameraEntity, { loadOp: 'load', priority: 30 });
      simulation.disabled = this.deviceLost;
      this.tickingSystems.push(simulation);
      this.options.scene.addSystem(simulation, false).addSystem(renderer); this.installedSystems.push(simulation, renderer);
    }
    if (this.counts.particles2d > 0) {
      const cameraEntity = this.options.scene.activeCameraEntity;
      const camera = new Camera2D({ width: this.options.engine.width, height: this.options.engine.height, designWidth: this.options.engine.width, designHeight: this.options.engine.height, viewportMode: 'fit' });
      cameraEntity.addComponent(camera); this.installedComponents.push({ entity: cameraEntity, component: camera });
      const simulation = new Particle2DSystem({ maxDeltaSeconds: 0.1, priority: -9 });
      const renderer = new Particle2DRenderSystem(this.options.engine, cameraEntity, { loadOp: 'load', priority: 40 });
      simulation.disabled = this.deviceLost;
      this.tickingSystems.push(simulation);
      this.options.scene.addSystem(simulation, false).addSystem(renderer); this.installedSystems.push(simulation, renderer);
    }
  }

  private installModelSystem(): void {
    if (this.counts.models === 0) return;
    const timeout = allEnabled(this.options.sceneEntities, 'haiyue.model.gltf')
      .reduce((maximum, descriptor) => Math.max(maximum, integer(descriptor.value.loadTimeoutMs, 100, 120_000, 30_000)), 100);
    const system = new GltfModelSystem({ assetManager: this.options.engine.assetManager ?? null, loadTimeoutMs: timeout });
    this.options.scene.addSystem(system, false);
    this.installedSystems.push(system);
  }

  private installAnimation2DSystems(): void {
    if (this.counts.animations2d === 0) return;
    const maximumTargets = allEnabled(this.options.sceneEntities, 'haiyue.animation.2d')
      .reduce((maximum, descriptor) => Math.max(maximum, integer(descriptor.value.maxMaskTargets, 1, 128, 32)), 1);
    const simulation = new Animation2DSystem({ assetManager: this.options.engine.assetManager });
    const renderer = new Animation2DRenderSystem(this.options.engine, this.options.scene.activeCameraEntity, { loadOp: 'load', maxMaskTargets: maximumTargets, priority: 35 });
    simulation.disabled = this.deviceLost;
    this.tickingSystems.push(simulation);
    this.options.scene.addSystem(simulation, false).addSystem(renderer);
    this.installedSystems.push(simulation, renderer);
  }

  private runtimeSignal(): AbortSignal { return this.options.signal ?? new AbortController().signal; }

  private readonly onDeviceLost = (): void => {
    this.deviceLost = true;
    for (const system of this.tickingSystems) system.disabled = true;
  };
  private readonly onDeviceRestored = (): void => {
    this.deviceLost = false;
    for (const system of this.tickingSystems) system.disabled = false;
  };
}

function createPostprocessPass(kind: string, value: Readonly<Record<string, unknown>>): PostProcessPass {
  if (kind === 'fxaa') return new FxaaPass();
  if (kind === 'taa') return new TaaPass({ feedback: finite(value.feedback, 0, 0.99, 0.9), sharpness: finite(value.sharpness, 0, 1, 0.15) });
  if (kind === 'gaussian-blur') return new GaussianBlurPass({ radius: integer(value.radius, 1, 64, 4), sigma: finite(value.sigma, 0.0001, 64, 2) });
  if (kind === 'grayscale') return new GrayscalePass();
  if (kind === 'outline') return new OutlinePass({ visibleEdgeColor: tuple(value.visibleColor, 4, [1, 1, 1, 1]), hiddenEdgeColor: tuple(value.hiddenColor, 4, [0.1, 0.04, 0.02, 1]), edgeStrength: finite(value.intensity, 0, 16, 3), edgeThickness: finite(value.radius, 0, 64, 1), blendMode: enumValue(value.blendMode, ['add', 'multiply', 'replace'], 'add') });
  if (kind === 'motion-blur') return new MotionBlurPass({ intensity: finite(value.intensity, 0, 16, 1), sampleCount: integer(value.sampleCount, 1, 32, 12), maxBlurPixels: finite(value.maxBlurPixels, 0, 256, 32) });
  const options = { radius: finite(value.radius, 0, 64, 1.25), intensity: finite(value.intensity, 0, 16, 1), quality: enumValue(value.quality, ['low', 'medium', 'high'], 'medium') };
  if (kind === 'gtao') return new GtaoPass(options);
  if (kind === 'sao') return new SaoPass(options);
  if (kind === 'ssao') return new SsaoPass(options);
  throw new Error(`postprocess.pass-unsupported: ${kind}.`);
}

class CartesianAnimation3DResolver implements Animation3DBindingResolver {
  readonly revision = 1;
  constructor(private readonly entityId: string, private readonly transform: CartesianTransform3D) {}

  resolve<TBinding extends Animation3DBinding>(binding: TBinding): Animation3DResolvedBinding<TBinding> | null {
    if (binding.target.kind !== 'node-id' || binding.target.nodeId !== this.entityId) return null;
    if (binding.path === 'transform.translation') return {
      binding,
      read: (out) => out.set(this.transform.position),
      write: (value) => this.transform.setPosition(Number(value[0]), Number(value[1]), Number(value[2])),
    };
    if (binding.path === 'transform.scale') return {
      binding,
      read: (out) => out.set(this.transform.scale),
      write: (value) => this.transform.setScale(Number(value[0]), Number(value[1]), Number(value[2])),
    };
    if (binding.path === 'transform.rotation') return {
      binding,
      read: (out) => out.set(quaternionFromYxzEuler(this.transform.rotation)),
      write: (value) => {
        const euler = yxzEulerFromQuaternion(value);
        this.transform.setRotation(euler[0], euler[1], euler[2]);
      },
    };
    return null;
  }
}

function compileTransformClips(descriptor: RenderEffectComponent, entityId: string): Animation3DClip[] {
  const source = Array.isArray(descriptor.value.clips) ? descriptor.value.clips.filter(isRecord) : [];
  return source.map((clip, index) => {
    const id = typeof clip.name === 'string' ? clip.name : `Clip${index + 1}`;
    // Track storage is Float32; use the same rounded value for the clip bound so
    // the public validator never observes the final key microscopically beyond it.
    const duration = Math.fround(integer(clip.durationTicks, 1, 1_000_000, 60) / 60);
    const from = isRecord(clip.from) ? clip.from : {};
    const to = isRecord(clip.to) ? clip.to : from;
    const fromPosition = vec3(from.position, [0, 0, 0]), toPosition = vec3(to.position, fromPosition);
    const fromRotation = vec3(from.rotationDegrees, [0, 0, 0]).map(degreesToRadians) as [number, number, number];
    const toRotation = vec3(to.rotationDegrees, fromRotation.map(radiansToDegrees)).map(degreesToRadians) as [number, number, number];
    const fromScale = vec3(from.scale, [1, 1, 1]), toScale = vec3(to.scale, fromScale);
    const target = Object.freeze({ kind: 'node-id' as const, nodeId: entityId });
    const times = new Float32Array([0, duration]);
    return Object.freeze({
      format: 'haiyue-animation3d-clip@1' as const,
      id,
      name: id,
      duration,
      events: Object.freeze([]),
      tracks: Object.freeze([
        Object.freeze({ id: `${id}:translation`, binding: Object.freeze({ id: `${id}:translation`, target, path: 'transform.translation' as const, valueType: 'vec3' as const, valueSize: 3 as const }), interpolation: 'linear' as const, times, values: new Float32Array([...fromPosition, ...toPosition]) }),
        Object.freeze({ id: `${id}:rotation`, binding: Object.freeze({ id: `${id}:rotation`, target, path: 'transform.rotation' as const, valueType: 'quaternion' as const, valueSize: 4 as const }), interpolation: 'linear' as const, times, values: new Float32Array([...quaternionFromYxzEuler(fromRotation), ...quaternionFromYxzEuler(toRotation)]) }),
        Object.freeze({ id: `${id}:scale`, binding: Object.freeze({ id: `${id}:scale`, target, path: 'transform.scale' as const, valueType: 'vec3' as const, valueSize: 3 as const }), interpolation: 'linear' as const, times, values: new Float32Array([...fromScale, ...toScale]) }),
      ]),
    });
  });
}

function transformClipLoop(descriptor: RenderEffectComponent, clipId: string): boolean {
  return (Array.isArray(descriptor.value.clips) ? descriptor.value.clips : []).some((clip) => isRecord(clip) && clip.name === clipId && clip.loop === true);
}

function quaternionFromYxzEuler(rotation: ArrayLike<number>): [number, number, number, number] {
  const x = Number(rotation[0]), y = Number(rotation[1]), z = Number(rotation[2]);
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
}

function yxzEulerFromQuaternion(rotation: ArrayLike<number>): [number, number, number] {
  const x = Number(rotation[0]), y = Number(rotation[1]), z = Number(rotation[2]), w = Number(rotation[3]);
  const m11 = 1 - 2 * (y * y + z * z), m13 = 2 * (x * z + w * y);
  const m21 = 2 * (x * y + w * z), m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - w * x);
  const m31 = 2 * (x * z - w * y), m33 = 1 - 2 * (x * x + y * y);
  const eulerX = Math.asin(-Math.max(-1, Math.min(1, m23)));
  return Math.abs(m23) < 0.9999999
    ? [eulerX, Math.atan2(m13, m33), Math.atan2(m21, m22)]
    : [eulerX, Math.atan2(-m31, m11), 0];
}
function findEnabled(entities: readonly RenderEffectSceneEntity[], type: string): RenderEffectComponent | undefined { return allEnabled(entities, type)[0]; }
function allEnabled(entities: readonly RenderEffectSceneEntity[], type: string): RenderEffectComponent[] { return entities.flatMap((entity) => entity.components?.filter((component) => component.enabled && component.type === type) ?? []); }
function findEntityComponent(entities: readonly RenderEffectSceneEntity[], entityId: string, type: string): RenderEffectComponent | undefined { return entities.find((entity) => entity.id === entityId)?.components?.find((component) => component.enabled && component.type === type); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function tuple(value: unknown, length: 2, fallback: readonly [number, number]): [number, number];
function tuple(value: unknown, length: 3, fallback: readonly [number, number, number]): [number, number, number];
function tuple(value: unknown, length: 4, fallback: readonly [number, number, number, number]): [number, number, number, number];
function tuple(value: unknown, length: number, fallback: readonly number[]): number[] { return Array.isArray(value) && value.length === length && value.every(Number.isFinite) ? value.map(Number) : [...fallback]; }
function vec3(value: unknown, fallback: readonly number[]): [number, number, number] { return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z) ? [Number(value.x), Number(value.y), Number(value.z)] : [fallback[0] ?? 0, fallback[1] ?? 0, fallback[2] ?? 0]; }
function finite(value: unknown, minimum: number, maximum: number, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback; }
function integer(value: unknown, minimum: number, maximum: number, fallback: number): number { return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : fallback; }
function enumValue<const T extends string>(value: unknown, values: readonly T[], fallback: T): T { return typeof value === 'string' && values.includes(value as T) ? value as T : fallback; }
function degreesToRadians(value: number): number { return value * Math.PI / 180; }
function radiansToDegrees(value: number): number { return value * 180 / Math.PI; }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('render-effects.start-aborted'); }
