import type { HaiyueEngine } from '@haiyue/engine';
import type { ResolvedTextureAsset } from '@haiyue/ai-studio-script-preview/effects';

type ImageOwner = { references: number; image: Promise<ImageBitmap> };
const images = new WeakMap<HaiyueEngine, Map<string, ImageOwner>>();
function retainImage(engine: HaiyueEngine, id: string, blob: Blob): Readonly<{ image: Promise<ImageBitmap>; release(): void }> {
  let pool = images.get(engine); if (!pool) { pool = new Map(); images.set(engine, pool); }
  let entry = pool.get(id);
  if (!entry) { entry = { references: 0, image: createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }) }; pool.set(id, entry); }
  const owned = entry; owned.references++; let released = false;
  return { image: owned.image, release() {
    if (released) return; released = true;
    if (--owned.references === 0) { if (pool!.get(id) === owned) pool!.delete(id); void owned.image.then(image => image.close(), () => {}); }
  } };
}

/** Shared authoring/Play path: decode controlled bytes locally and await GPU upload. */
export async function loadControlledMaterialTexture(
  engine: HaiyueEngine,
  asset: Readonly<{ id: string; mimeType: string; byteLength: number; blob?: Blob; url?: string }>,
  signal: AbortSignal,
  slot: 'baseColor' | 'metallicRoughness' | 'normal' | 'occlusion' | 'emissive',
): Promise<ResolvedTextureAsset> {
  signal.throwIfAborted();
  const manager = engine.assetManager;
  if (!manager) throw new Error('texture.asset-manager-unavailable: Engine AssetManager is unavailable.');
  if (asset.mimeType === 'image/ktx2') {
    if (!asset.url) throw new Error(`texture.asset-payload-invalid: ${asset.id} needs a local compressed texture URL.`);
    const handle = await manager.loadTexture({ kind: 'compressed-texture', type: 'texture/ktx2', src: asset.url }, { signal });
    return Object.freeze({ texture: { kind: 'compressed-texture' as const, type: 'texture/ktx2', src: asset.url }, release: () => handle.release() });
  }
  if (!asset.blob && (!asset.url || !asset.url.startsWith('blob:'))) throw new Error(`texture.asset-payload-invalid: ${asset.id} has no controlled image.`);
  const blob = asset.blob ?? await (await fetch(asset.url!, { signal })).blob();
  signal.throwIfAborted();
  if (blob.size !== asset.byteLength || blob.type !== asset.mimeType) throw new Error(`texture.asset-payload-invalid: ${asset.id} descriptor changed.`);
  const owner = retainImage(engine, asset.id, blob);
  try {
    const bitmap = await owner.image;
    signal.throwIfAborted();
    const handle = await manager.loadTexture(bitmap, { signal, format: slot === 'baseColor' || slot === 'emissive' ? 'rgba8unorm-srgb' : 'rgba8unorm', mipmaps: 'generate' });
    if (signal.aborted) { handle.release(); signal.throwIfAborted(); }
    // Keep the CPU source alive for Engine device recovery and let its renderer share the preloaded handle.
    return Object.freeze({ texture: bitmap, release() { handle.release(); owner.release(); } });
  } catch (cause) {
    owner.release();
    if (signal.aborted) throw cause;
    throw new Error(`texture.load-failed: ${asset.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
