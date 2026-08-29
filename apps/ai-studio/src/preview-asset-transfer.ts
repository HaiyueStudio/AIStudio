import type { JsonObject, StableId } from '@haiyue/ai-studio-contracts';

export interface PreviewAssetManifestEntry { readonly id: StableId; readonly kind: 'texture' | 'model' | 'audio' | 'animation'; readonly mimeType: string; readonly byteLength: number; readonly decodedBytes: number; }
export interface PreviewAssetComponent { readonly enabled: boolean; readonly value: JsonObject; }
export interface PreviewAssetScene { readonly entities: readonly Readonly<{ readonly components?: readonly PreviewAssetComponent[] }>[]; readonly assets?: readonly PreviewAssetManifestEntry[]; }
export interface PreviewRuntimeAsset { readonly id: StableId; readonly kind: PreviewAssetManifestEntry['kind']; readonly mimeType: string; readonly byteLength: number; readonly url?: string; readonly source?: string; }
export interface PreviewAssetReadResult extends JsonObject { readonly assetId: StableId; readonly kind: PreviewAssetManifestEntry['kind']; readonly mimeType: string; readonly byteLength: number; readonly base64: string; }
export interface PreviewAssetTransferPlatform {
  createObjectUrl(bytes: Uint8Array, mimeType: string): string;
  revokeObjectUrl(url: string): void;
  decodeText(bytes: Uint8Array): string;
}

export async function loadPreviewAssets(snapshot: PreviewAssetScene, read: (assetId: StableId) => Promise<PreviewAssetReadResult>, platform: PreviewAssetTransferPlatform = browserPlatform(), signal?: AbortSignal): Promise<readonly PreviewRuntimeAsset[]> {
  throwIfAborted(signal);
  const manifest = new Map((snapshot.assets ?? []).map((entry) => [entry.id, entry]));
  const referenced = new Set<StableId>();
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    visited += 1;
    if (visited > 50_000 || depth > 24) throw new Error('Preview asset reference graph exceeds its safety budget.');
    if (typeof value === 'string') { if (/^asset:[a-f0-9]{24}$/u.test(value) && manifest.has(value as StableId)) referenced.add(value as StableId); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (value && typeof value === 'object') for (const item of Object.values(value as Readonly<Record<string, unknown>>)) visit(item, depth + 1);
  };
  for (const entity of snapshot.entities) for (const component of entity.components ?? []) if (component.enabled) visit(component.value, 0);
  if (referenced.size > 128) throw new Error('Preview references more than 128 controlled assets.');
  const descriptors = [...referenced].map((id) => manifest.get(id)!);
  const totalBytes = descriptors.reduce((sum, entry) => sum + entry.byteLength, 0);
  const totalDecodedBytes = descriptors.reduce((sum, entry) => sum + entry.decodedBytes, 0);
  if (totalBytes > 64 * 1024 * 1024 || totalDecodedBytes > 256 * 1024 * 1024) throw new Error('Preview assets exceed the aggregate source or decode budget.');
  const loaded: PreviewRuntimeAsset[] = [];
  try {
    for (const entry of descriptors) {
      throwIfAborted(signal);
      const response = await read(entry.id);
      throwIfAborted(signal);
      if (response.assetId !== entry.id || response.kind !== entry.kind || response.mimeType !== entry.mimeType || response.byteLength !== entry.byteLength) throw new Error(`Preview asset descriptor changed for ${entry.id}.`);
      const bytes = decodeBase64(response.base64, entry.byteLength);
      if (entry.kind === 'animation') loaded.push(Object.freeze({ id: entry.id, kind: entry.kind, mimeType: entry.mimeType, byteLength: entry.byteLength, source: platform.decodeText(bytes) }));
      else loaded.push(Object.freeze({ id: entry.id, kind: entry.kind, mimeType: entry.mimeType, byteLength: entry.byteLength, url: platform.createObjectUrl(bytes, entry.mimeType) }));
    }
    throwIfAborted(signal);
    return Object.freeze(loaded);
  } catch (cause) {
    releasePreviewAssetUrls(loaded, platform);
    throw cause;
  }
}

export function releasePreviewAssetUrls(assets: readonly PreviewRuntimeAsset[], platform: Pick<PreviewAssetTransferPlatform, 'revokeObjectUrl'> = browserPlatform()): void { for (const asset of assets) if (asset.url) platform.revokeObjectUrl(asset.url); }

export function decodeBase64(value: string, expectedBytes: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(expectedBytes / 3) * 4 + 4) throw new Error('Preview asset payload exceeds its encoded budget.');
  let binary: string;
  try { binary = atob(value); } catch { throw new Error('Preview asset payload is not valid base64.'); }
  if (binary.length !== expectedBytes) throw new Error('Preview asset byte length changed during transfer.');
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function browserPlatform(): PreviewAssetTransferPlatform { return Object.freeze({
  createObjectUrl(bytes: Uint8Array, mimeType: string): string { const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; return URL.createObjectURL(new Blob([data], { type: mimeType })); },
  revokeObjectUrl(url: string): void { URL.revokeObjectURL(url); },
  decodeText(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); },
}); }

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Preview asset transfer was aborted.');
}
