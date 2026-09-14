import { RenderEffectsPlayRuntime, type RenderEffectSceneEntity } from '@haiyue/ai-studio-script-preview/effects';
import type { Entity, HaiyueEngine, Scene } from '@haiyue/engine';
import type { StableId } from '@haiyue/ai-studio-contracts';
import { loadPreviewAssets, releasePreviewAssetUrls, type PreviewAssetManifestEntry, type PreviewAssetReadResult, type PreviewRuntimeAsset } from './preview-asset-transfer.js';
import { loadControlledMaterialTexture } from './scene-material-textures.js';

/** Own only material components in the editor; scripts, audio and simulation are never installed. */
export class AuthoringMaterials {
  private controller = new AbortController();
  private runtime: RenderEffectsPlayRuntime | null = null;
  private assets: readonly PreviewRuntimeAsset[] = [];
  private readonly urls = new Set<string>();
  private disposed = false;
  constructor(private readonly read: (id: StableId) => Promise<PreviewAssetReadResult>) {}

  async apply(engine: HaiyueEngine, scene: Scene, snapshot: Readonly<{ entities: readonly RenderEffectSceneEntity[]; assets?: readonly PreviewAssetManifestEntry[] }>, entities: ReadonlyMap<string, Entity>): Promise<boolean> {
    if (this.disposed) return false;
    this.clear();
    const signal = this.controller.signal;
    const materialEntities = snapshot.entities.map(item => ({ ...item, components: item.components?.filter(component => component.type === 'haiyue.material.pbr') ?? [] }));
    const assets = await loadPreviewAssets({ entities: materialEntities, assets: snapshot.assets ?? [] }, this.read, undefined, signal);
    if (signal.aborted) { releasePreviewAssetUrls(assets); return false; }
    this.assets = assets;
    const byId = new Map(assets.map(asset => {
      if (asset.mimeType !== 'image/ktx2' || !asset.blob) return [asset.id, asset] as const;
      const url = URL.createObjectURL(asset.blob); this.urls.add(url); return [asset.id, { ...asset, url }] as const;
    }));
    const runtime = await RenderEffectsPlayRuntime.create({ engine, scene, sceneEntities: materialEntities, entitiesByStableId: entities, signal,
      resolveTextureAsset: async (id, signal, slot) => {
        const asset = byId.get(id as StableId);
        if (!asset || asset.kind !== 'texture') throw new Error(`texture.asset-missing: ${id}.`);
        return loadControlledMaterialTexture(engine, asset, signal, slot);
      },
    });
    if (signal.aborted) { runtime.dispose(); return false; }
    this.runtime = runtime;
    return true;
  }
  clear(): void {
    this.controller.abort(); this.controller = new AbortController();
    this.runtime?.dispose(); this.runtime = null;
    releasePreviewAssetUrls(this.assets); this.assets = [];
    for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear();
  }
  dispose(): void { this.disposed = true; this.clear(); }
}
