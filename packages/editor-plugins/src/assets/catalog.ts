import { createHash } from 'node:crypto';
import path from 'node:path';
import type { JsonValue, StableId } from '@haiyue/ai-studio-contracts';

export const CONTROLLED_ASSET_CATALOG_SETTING_KEY = 'studio.assets.catalog.v1';

export type ControlledAssetKind = 'texture' | 'model' | 'audio' | 'animation';
export type ControlledAssetLicense = 'project-owned' | 'cc0' | 'cc-by-4.0' | 'internal-test';

export interface ControlledAssetImportInput {
  readonly projectPath: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly kind: ControlledAssetKind;
  readonly license: ControlledAssetLicense;
  readonly provenance: string;
  readonly decodedBytes: number;
  readonly width?: number;
  readonly height?: number;
}

export interface ControlledAssetManifestEntry {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly kind: ControlledAssetKind;
  readonly digest: `sha256:${string}`;
  readonly projectPath: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly decodedBytes: number;
  readonly license: ControlledAssetLicense;
  readonly provenance: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ControlledAssetCatalogOptions {
  readonly assetRoot?: string;
  readonly maxSourceBytes?: number;
  readonly maxDecodedBytes?: number;
  readonly maxImageDimension?: number;
  readonly maxEntries?: number;
}

export class ControlledAssetError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ControlledAssetError'; }
}

const FORMAT_POLICY: Readonly<Record<ControlledAssetKind, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  texture: Object.freeze({ 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/ktx2': ['.ktx2'] }),
  model: Object.freeze({ 'model/gltf+json': ['.gltf'], 'model/gltf-binary': ['.glb'] }),
  audio: Object.freeze({ 'audio/wav': ['.wav'], 'audio/mpeg': ['.mp3'], 'audio/ogg': ['.ogg'] }),
  animation: Object.freeze({ 'application/vnd.haiyue.animation+json': ['.hya.json'] }),
});

export class ControlledAssetCatalog {
  private readonly entries = new Map<string, ControlledAssetManifestEntry>();
  private readonly root: string;
  private readonly maxSourceBytes: number;
  private readonly maxDecodedBytes: number;
  private readonly maxImageDimension: number;
  private readonly maxEntries: number;

  constructor(options: ControlledAssetCatalogOptions = {}) {
    this.root = normalizeRoot(options.assetRoot ?? 'assets');
    this.maxSourceBytes = positiveInteger(options.maxSourceBytes ?? 32 * 1024 * 1024, 'maxSourceBytes');
    this.maxDecodedBytes = positiveInteger(options.maxDecodedBytes ?? 128 * 1024 * 1024, 'maxDecodedBytes');
    this.maxImageDimension = positiveInteger(options.maxImageDimension ?? 8192, 'maxImageDimension');
    this.maxEntries = positiveInteger(options.maxEntries ?? 4096, 'maxEntries');
  }

  static fromManifest(value: unknown, options: ControlledAssetCatalogOptions = {}): ControlledAssetCatalog {
    const catalog = new ControlledAssetCatalog(options);
    if (value === undefined || value === null) return catalog;
    if (!Array.isArray(value) || value.length > catalog.maxEntries) throw new ControlledAssetError('asset.manifest-invalid', `Asset manifest must contain at most ${catalog.maxEntries} entries.`);
    for (const candidate of value) catalog.restore(candidate);
    return catalog;
  }

  import(input: ControlledAssetImportInput): ControlledAssetManifestEntry {
    const projectPath = containedProjectPath(input.projectPath, this.root);
    validateFormat(input.kind, input.mimeType, projectPath);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > this.maxSourceBytes) throw new ControlledAssetError('asset.source-budget', `Asset source must contain 1..${this.maxSourceBytes} bytes.`);
    if (!Number.isSafeInteger(input.decodedBytes) || input.decodedBytes < input.bytes.byteLength || input.decodedBytes > this.maxDecodedBytes) throw new ControlledAssetError('asset.decode-budget', `Decoded asset bytes must be within source size..${this.maxDecodedBytes}.`);
    const width = optionalDimension(input.width, this.maxImageDimension, 'width');
    const height = optionalDimension(input.height, this.maxImageDimension, 'height');
    if ((width === null) !== (height === null)) throw new ControlledAssetError('asset.image-dimensions', 'Image width and height must be supplied together.');
    validateAssetContent(input.kind, input.mimeType, input.bytes, width, height, input.decodedBytes);
    if (!['project-owned', 'cc0', 'cc-by-4.0', 'internal-test'].includes(input.license)) throw new ControlledAssetError('asset.license-invalid', 'Asset license is not allowed.');
    const provenance = boundedText(input.provenance, 1, 512, 'provenance');
    const digest = `sha256:${createHash('sha256').update(input.bytes).digest('hex')}` as const;
    const id = `asset:${digest.slice('sha256:'.length, 'sha256:'.length + 24)}` as StableId;
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.digest !== digest || existing.kind !== input.kind) throw new ControlledAssetError('asset.digest-collision', `Asset id ${id} collides with a different descriptor.`);
      return existing;
    }
    if (this.entries.size >= this.maxEntries) throw new ControlledAssetError('asset.catalog-full', `Asset catalog limit ${this.maxEntries} was reached.`);
    const entry = Object.freeze({ schemaVersion: 1 as const, id, kind: input.kind, digest, projectPath, mimeType: input.mimeType, byteLength: input.bytes.byteLength, decodedBytes: input.decodedBytes, license: input.license, provenance, width, height });
    this.entries.set(id, entry);
    return entry;
  }

  get(id: string): ControlledAssetManifestEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new ControlledAssetError('asset.not-found', `Asset ${id} is not in the controlled catalog.`);
    return entry;
  }

  search(query: Readonly<{ text?: string; kind?: ControlledAssetKind; limit?: number }> = {}): readonly ControlledAssetManifestEntry[] {
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ControlledAssetError('asset.search-limit', 'Asset search limit must be an integer from 1 to 200.');
    const text = query.text?.trim().toLocaleLowerCase('en-US') ?? '';
    return Object.freeze([...this.entries.values()]
      .filter((entry) => (!query.kind || entry.kind === query.kind) && (!text || `${entry.projectPath} ${entry.provenance} ${entry.license}`.toLocaleLowerCase('en-US').includes(text)))
      .sort((left, right) => left.projectPath.localeCompare(right.projectPath))
      .slice(0, limit));
  }

  assignment(assetId: string, usage: 'texture.base-color' | 'texture.metallic-roughness' | 'texture.normal' | 'texture.occlusion' | 'texture.emissive' | 'texture.environment-diffuse' | 'texture.environment-specular' | 'model' | 'audio' | 'animation'): Readonly<{ type: StableId; version: '1.0.0'; value: Readonly<{ assetId: StableId; usage: string }> }> {
    const entry = this.get(assetId);
    const expected = usage.startsWith('texture.') ? 'texture' : usage;
    if (entry.kind !== expected) throw new ControlledAssetError('asset.usage-mismatch', `Asset ${assetId} is ${entry.kind}, not ${expected}.`);
    if (usage.startsWith('texture.environment-') && entry.mimeType !== 'image/ktx2' && (entry.width === null || entry.height === null || entry.width !== entry.height * 2)) throw new ControlledAssetError('asset.environment-shape', 'Environment textures must be KTX2 cubemaps or decoded 2:1 equirectangular images.');
    return Object.freeze({ type: 'haiyue.asset.reference' as StableId, version: '1.0.0', value: Object.freeze({ assetId: entry.id, usage }) });
  }

  manifest(): readonly ControlledAssetManifestEntry[] { return Object.freeze([...this.entries.values()].sort((left, right) => left.id.localeCompare(right.id))); }
  settingValue(): JsonValue { return this.manifest() as unknown as JsonValue; }

  private restore(value: unknown): void {
    if (!isRecord(value)) throw new ControlledAssetError('asset.manifest-invalid', 'Asset manifest entry must be an object.');
    exactKeys(value, ['schemaVersion', 'id', 'kind', 'digest', 'projectPath', 'mimeType', 'byteLength', 'decodedBytes', 'license', 'provenance', 'width', 'height']);
    if (value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.digest)) throw new ControlledAssetError('asset.manifest-invalid', 'Asset manifest identity or digest is invalid.');
    if (!['texture', 'model', 'audio', 'animation'].includes(String(value.kind))) throw new ControlledAssetError('asset.manifest-invalid', 'Asset manifest kind is invalid.');
    const projectPath = containedProjectPath(String(value.projectPath), this.root);
    validateFormat(value.kind as ControlledAssetKind, String(value.mimeType), projectPath);
    const byteLength = boundedPositiveInteger(value.byteLength, this.maxSourceBytes, 'byteLength');
    const decodedBytes = boundedPositiveInteger(value.decodedBytes, this.maxDecodedBytes, 'decodedBytes');
    if (decodedBytes < byteLength) throw new ControlledAssetError('asset.manifest-invalid', 'Decoded asset bytes cannot be smaller than source bytes.');
    const width = nullableDimension(value.width, this.maxImageDimension, 'width');
    const height = nullableDimension(value.height, this.maxImageDimension, 'height');
    if ((width === null) !== (height === null)) throw new ControlledAssetError('asset.image-dimensions', 'Image width and height must be supplied together.');
    if (!['project-owned', 'cc0', 'cc-by-4.0', 'internal-test'].includes(String(value.license))) throw new ControlledAssetError('asset.license-invalid', 'Asset license is not allowed.');
    const provenance = boundedText(String(value.provenance), 1, 512, 'provenance');
    const expectedId = `asset:${value.digest.slice('sha256:'.length, 'sha256:'.length + 24)}`;
    if (value.id !== expectedId) throw new ControlledAssetError('asset.manifest-invalid', `Asset id ${value.id} does not match its digest.`);
    if (this.entries.has(value.id)) throw new ControlledAssetError('asset.manifest-invalid', `Asset manifest contains duplicate id ${value.id}.`);
    this.entries.set(value.id, Object.freeze({ schemaVersion: 1, id: value.id as StableId, kind: value.kind as ControlledAssetKind, digest: value.digest as `sha256:${string}`, projectPath, mimeType: String(value.mimeType), byteLength, decodedBytes, license: value.license as ControlledAssetLicense, provenance, width, height }));
  }
}

function normalizeRoot(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').includes('..')) throw new ControlledAssetError('asset.root-invalid', 'Asset root must be a project-relative contained path.');
  return normalized;
}
function containedProjectPath(value: string, root: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new ControlledAssetError('asset.path-invalid', 'Asset path is invalid.');
  const portable = value.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:/u.test(portable)) throw new ControlledAssetError('asset.path-outside-project', 'Absolute asset paths are not allowed.');
  const normalized = path.posix.normalize(portable).replace(/^\.\//u, '');
  if (normalized === '..' || normalized.startsWith('../') || (normalized !== root && !normalized.startsWith(`${root}/`))) throw new ControlledAssetError('asset.path-outside-project', `Asset path must stay under ${root}/.`);
  return normalized;
}
function validateFormat(kind: ControlledAssetKind, mimeType: string, projectPath: string): void {
  const extensions = FORMAT_POLICY[kind]?.[mimeType];
  if (!extensions || !extensions.some((extension) => projectPath.toLocaleLowerCase('en-US').endsWith(extension))) throw new ControlledAssetError('asset.format-not-allowed', `${kind} asset format ${mimeType} is not allowed for ${projectPath}.`);
}
function validateAssetContent(kind: ControlledAssetKind, mimeType: string, bytes: Uint8Array, width: number | null, height: number | null, decodedBytes: number): void {
  if (kind === 'texture') {
    const actual = textureDimensions(mimeType, bytes);
    if (width === null || height === null) throw new ControlledAssetError('asset.image-dimensions', 'Texture width and height are required and must match the file header.');
    if (actual[0] !== width || actual[1] !== height) throw new ControlledAssetError('asset.image-dimensions', `Declared texture dimensions ${width}x${height} do not match ${actual[0]}x${actual[1]}.`);
    const minimumDecoded = actual[0] * actual[1] * 4;
    if (!Number.isSafeInteger(minimumDecoded) || decodedBytes < minimumDecoded) throw new ControlledAssetError('asset.decode-budget', `Texture decodedBytes must be at least ${minimumDecoded}.`);
    return;
  }
  if (kind === 'audio') { validateAudioSignature(mimeType, bytes); return; }
  if (kind === 'model') {
    const document = mimeType === 'model/gltf-binary' ? parseGlbDocument(bytes) : parseJsonDocument(bytes, 'glTF');
    if (!isRecord(document.asset) || typeof document.asset.version !== 'string' || !document.asset.version.startsWith('2.')) throw new ControlledAssetError('asset.content-invalid', 'glTF asset.version must be 2.x.');
    rejectExternalUris(document, 'glTF');
    return;
  }
  const document = parseJsonDocument(bytes, 'HaiYue animation');
  if (document.format !== 'haiyue-animation' || document.version !== '1.0') throw new ControlledAssetError('asset.content-invalid', 'HaiYue animation must use format haiyue-animation version 1.0.');
  rejectExternalUris(document, 'HaiYue animation');
}

function textureDimensions(mimeType: string, bytes: Uint8Array): readonly [number, number] {
  if (mimeType === 'image/png') {
    if (bytes.length < 24 || !matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) || ascii(bytes, 12, 4) !== 'IHDR') invalidContent('PNG signature or IHDR header is invalid.');
    return validDimensions(readU32Be(bytes, 16), readU32Be(bytes, 20), 'PNG');
  }
  if (mimeType === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) invalidContent('JPEG signature is invalid.');
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const segmentLength = readU16Be(bytes, offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) invalidContent('JPEG segment table is invalid.');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return validDimensions(readU16Be(bytes, offset + 7), readU16Be(bytes, offset + 5), 'JPEG');
      offset += 2 + segmentLength;
    }
    invalidContent('JPEG has no supported frame dimensions.');
  }
  if (mimeType === 'image/webp') {
    if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') invalidContent('WebP RIFF signature is invalid.');
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X') return validDimensions(1 + readU24Le(bytes, 24), 1 + readU24Le(bytes, 27), 'WebP');
    if (chunk === 'VP8 ' && matches(bytes, 23, [0x9d, 0x01, 0x2a])) return validDimensions(readU16Le(bytes, 26) & 0x3fff, readU16Le(bytes, 28) & 0x3fff, 'WebP');
    if (chunk === 'VP8L' && bytes[20] === 0x2f) return validDimensions(1 + Number(bytes[21]) + ((Number(bytes[22]) & 0x3f) << 8), 1 + (Number(bytes[22]) >> 6) + (Number(bytes[23]) << 2) + ((Number(bytes[24]) & 0x0f) << 10), 'WebP');
    invalidContent('WebP dimensions are invalid or unsupported.');
  }
  if (mimeType === 'image/ktx2') {
    if (bytes.length < 36 || !matches(bytes, 0, [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])) invalidContent('KTX2 signature is invalid.');
    return validDimensions(readU32Le(bytes, 20), readU32Le(bytes, 24), 'KTX2');
  }
  invalidContent(`Unsupported texture content type ${mimeType}.`);
}

function validateAudioSignature(mimeType: string, bytes: Uint8Array): void {
  const valid = mimeType === 'audio/wav' ? bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE'
    : mimeType === 'audio/ogg' ? bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS'
      : mimeType === 'audio/mpeg' ? bytes.length >= 3 && (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (Number(bytes[1]) & 0xe0) === 0xe0))
        : false;
  if (!valid) invalidContent(`${mimeType} signature is invalid.`);
}

function parseGlbDocument(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length < 20 || readU32Le(bytes, 0) !== 0x46546c67 || readU32Le(bytes, 4) !== 2 || readU32Le(bytes, 8) !== bytes.length) invalidContent('GLB header or declared length is invalid.');
  const jsonLength = readU32Le(bytes, 12), jsonType = readU32Le(bytes, 16);
  if (jsonType !== 0x4e4f534a || jsonLength < 2 || 20 + jsonLength > bytes.length) invalidContent('GLB JSON chunk is invalid.');
  return parseJsonDocument(bytes.subarray(20, 20 + jsonLength), 'GLB');
}

function parseJsonDocument(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/[\u0000\u0020]+$/gu, '')); }
  catch { throw new ControlledAssetError('asset.content-invalid', `${label} JSON is invalid.`); }
  if (!isRecord(value)) throw new ControlledAssetError('asset.content-invalid', `${label} root must be an object.`);
  return value;
}

function rejectExternalUris(root: Record<string, unknown>, label: string): void {
  const pending: unknown[] = [root];
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (++visited > 100_000) throw new ControlledAssetError('asset.content-budget', `${label} structure exceeds the validation budget.`);
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (['uri', 'url', 'src'].includes(key.toLocaleLowerCase('en-US')) && typeof child === 'string' && !child.startsWith('data:')) throw new ControlledAssetError('asset.external-uri', `${label} external URI fields are not allowed.`);
      pending.push(child);
    }
  }
}

function validDimensions(width: number, height: number, label: string): readonly [number, number] { if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalidContent(`${label} dimensions are invalid.`); return [width, height]; }
function invalidContent(message: string): never { throw new ControlledAssetError('asset.content-invalid', message); }
function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean { return expected.every((value, index) => bytes[offset + index] === value); }
function ascii(bytes: Uint8Array, offset: number, length: number): string { return String.fromCharCode(...bytes.subarray(offset, offset + length)); }
function dataView(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function readU16Be(bytes: Uint8Array, offset: number): number { if (offset < 0 || offset + 2 > bytes.length) invalidContent('Binary header is truncated.'); return dataView(bytes).getUint16(offset, false); }
function readU16Le(bytes: Uint8Array, offset: number): number { if (offset < 0 || offset + 2 > bytes.length) invalidContent('Binary header is truncated.'); return dataView(bytes).getUint16(offset, true); }
function readU24Le(bytes: Uint8Array, offset: number): number { if (offset < 0 || offset + 3 > bytes.length) invalidContent('Binary header is truncated.'); return Number(bytes[offset]) | (Number(bytes[offset + 1]) << 8) | (Number(bytes[offset + 2]) << 16); }
function readU32Be(bytes: Uint8Array, offset: number): number { if (offset < 0 || offset + 4 > bytes.length) invalidContent('Binary header is truncated.'); return dataView(bytes).getUint32(offset, false); }
function readU32Le(bytes: Uint8Array, offset: number): number { if (offset < 0 || offset + 4 > bytes.length) invalidContent('Binary header is truncated.'); return dataView(bytes).getUint32(offset, true); }
function optionalDimension(value: number | undefined, maximum: number, label: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ControlledAssetError('asset.image-dimensions', `Asset ${label} must be an integer from 1 to ${maximum}.`);
  return value;
}
function nullableDimension(value: unknown, maximum: number, label: string): number | null { return value === null ? null : optionalDimension(typeof value === 'number' ? value : Number.NaN, maximum, label); }
function boundedPositiveInteger(value: unknown, maximum: number, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new ControlledAssetError('asset.manifest-invalid', `Asset ${label} must be an integer from 1 to ${maximum}.`); return Number(value); }
function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new ControlledAssetError('asset.policy-invalid', `${label} must be a positive integer.`); return value; }
function boundedText(value: string, minimum: number, maximum: number, label: string): string { if (typeof value !== 'string' || value.length < minimum || value.length > maximum) throw new ControlledAssetError('asset.metadata-invalid', `Asset ${label} must contain ${minimum}..${maximum} characters.`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { const keys = Object.keys(value); if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) throw new ControlledAssetError('asset.manifest-invalid', 'Asset manifest entry fields are invalid.'); }
