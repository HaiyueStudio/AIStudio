import type { JsonObject } from '@haiyue/ai-studio-contracts';
import type { ResourcePanelItem } from '@haiyue/ai-studio-shell/resources/model';
import type { SceneGeometryKind } from '@haiyue/ai-studio-editor-plugins';
import { createGeometry } from './scene-entity-rendering.js';

const SIZE = 128;
const kinds = new Set(['cube', 'rounded-box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron']);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const unit = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/** Read-only thumbnail owner. No live scene, scripts, GPU loop or project mutation. */
export class ResourceThumbnails {
  private project: string | null = null;
  private owner = new AbortController();
  private closed = false;
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly cache = new Map<string, HTMLCanvasElement>();
  constructor(private readonly document: Document, private readonly read: (assetId: string, signal: AbortSignal) => Promise<JsonObject>) {}
  setProject(project: string | null): void {
    if (project === this.project) return;
    this.owner.abort(); this.owner = new AbortController(); this.project = project; this.cache.clear();
  }
  dispose(): void { this.closed = true; this.owner.abort(); this.cache.clear(); }
  async render(target: HTMLCanvasElement, item: ResourcePanelItem, renderSignal: AbortSignal): Promise<void> {
    if (this.closed) return;
    const signal = AbortSignal.any([renderSignal, this.owner.signal]);
    const key = JSON.stringify([item.entry.ref, item.configuration, item.health]);
    const paint = (canvas: HTMLCanvasElement) => {
      signal.throwIfAborted();
      const context = target.getContext('2d'); context?.clearRect(0, 0, SIZE, SIZE); context?.drawImage(canvas, 0, 0);
      target.dataset.thumbnailReady = 'true';
    };
    const cached = this.cache.get(key);
    if (cached) { paint(cached); return; }
    await this.enter(signal);
    try {
      signal.throwIfAborted();
      const canvas = this.document.createElement('canvas'); canvas.width = canvas.height = SIZE;
      const context = canvas.getContext('2d'); if (!context) return;
      const configuration = record(item.configuration ? JSON.parse(item.configuration) : null);
      const value = record(configuration.value);
      if (item.entry.category === 'Geometry' && kinds.has(String(value.kind))) drawGeometry(context, value);
      else if (item.entry.category === 'Material') {
        drawMaterial(context, value, String(configuration.type));
        target.title = '材质球 · 示意光照';
      } else if (item.entry.kind === 'asset' && item.entry.ref.kind === 'asset') {
        const metadata = new Map(item.metadata.map(row => [row.label, row.value]));
        const mime = metadata.get('格式');
        if (!mime || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return;
        const bytes = Number(metadata.get('文件字节')), decoded = Number(metadata.get('解码预算'));
        if (!(bytes > 0 && bytes <= 20 * 1024 * 1024 && decoded > 0 && decoded <= 64 * 1024 * 1024)) return;
        const result = await this.read(item.entry.ref.assetId, signal);
        signal.throwIfAborted();
        if (result.assetId !== item.entry.ref.assetId || result.digest !== item.entry.ref.digest || result.mimeType !== mime || result.byteLength !== bytes
          || typeof result.base64 !== 'string' || result.base64.length > Math.ceil(bytes / 3) * 4) throw Error('Thumbnail asset changed.');
        const binary = atob(result.base64); if (binary.length !== bytes) throw Error('Thumbnail byte length mismatch.');
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: mime }), { resizeWidth: SIZE, resizeHeight: SIZE, resizeQuality: 'high' });
        try {
          signal.throwIfAborted();
          // Read the source aspect ratio from the validated manifest, not the square resize.
          const width = Number(metadata.get('宽度')), height = Number(metadata.get('高度'));
          const ratio = width > 0 && height > 0 ? width / height : 1;
          const w = ratio >= 1 ? SIZE : SIZE * ratio, h = ratio >= 1 ? SIZE / ratio : SIZE;
          context.drawImage(bitmap, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
        } finally { bitmap.close(); }
      } else return;
      signal.throwIfAborted();
      if (this.cache.size >= 48) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, canvas); paint(canvas);
    } finally { this.active--; this.queue.shift()?.(); }
  }
  private async enter(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < 2) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const start = () => { signal.removeEventListener('abort', cancel); this.active++; resolve(); };
      const cancel = () => { const index = this.queue.indexOf(start); if (index >= 0) this.queue.splice(index, 1); reject(signal.reason); };
      this.queue.push(start); signal.addEventListener('abort', cancel, { once: true });
    });
  }
}

function drawGeometry(context: CanvasRenderingContext2D, value: Record<string, unknown>): void {
  // Reuse the same public Engine geometry factory and authoring parameters as the viewport.
  const geometry = createGeometry(value.kind as SceneGeometryKind, [{ type: 'haiyue.render.geometry', value }]);
  const positions = geometry.positions, indices = geometry.indices;
  if (positions.length > 600_000) throw Error('Thumbnail geometry budget exceeded.');
  const points: [number, number][] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    points.push([.78 * x - .63 * z, -.32 * x - .82 * y - .40 * z]);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const scale = 96 / Math.max(maxX - minX, maxY - minY, .001);
  const project = (index: number) => { const p = points[index]!; return [(p[0] - (minX + maxX) / 2) * scale + 64, (p[1] - (minY + maxY) / 2) * scale + 64] as const; };
  context.strokeStyle = '#a9cafa'; context.lineWidth = .65; context.globalAlpha = .65;
  context.beginPath();
  const count = indices?.length ?? points.length, stride = Math.max(1, Math.ceil(count / 9000)) * 3;
  for (let i = 0; i + 2 < count; i += stride) {
    const a = project(indices?.[i] ?? i), b = project(indices?.[i + 1] ?? i + 1), c = project(indices?.[i + 2] ?? i + 2);
    context.moveTo(...a); context.lineTo(...b); context.lineTo(...c); context.lineTo(...a);
  }
  context.stroke(); context.globalAlpha = 1;
}

/** Small shaded sphere for recognition, not a replacement for the engine's PBR preview. */
function drawMaterial(context: CanvasRenderingContext2D, value: Record<string, unknown>, type: string): void {
  const raw = value.baseColor ?? value.color ?? value.diffuse;
  const color = Array.isArray(raw) ? raw.map(channel => unit(channel, .5)) : [.6, .65, .75, 1];
  const metallic = unit(value.metallic, .05), roughness = unit(value.roughness, .65);
  const material = value.material ?? (type === 'haiyue.material.pbr' ? 'pbr' : 'blinn-phong');
  const pixels = context.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const nx = (x - 63.5) / 49, ny = (63.5 - y) / 49, r = nx * nx + ny * ny;
    if (r > 1) continue;
    const nz = Math.sqrt(1 - r), diffuse = Math.max(0, nx * -.4 + ny * .55 + nz * .73);
    const highlight = Math.pow(Math.max(0, nx * -.23 + ny * .32 + nz * .918), 8 + (1 - roughness) * 150);
    const offset = (y * SIZE + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const base = color[channel] ?? .5;
      const shaded = material === 'normal' ? ([nx, ny, nz][channel]! + 1) / 2 : material === 'basic' ? base
        : base * (.22 + diffuse * .78) * (1 - metallic * .3) + highlight * (.15 + metallic * .65);
      pixels.data[offset + channel] = Math.min(255, Math.round(shaded * 255));
    }
    pixels.data[offset + 3] = Math.round((color[3] ?? 1) * 255 * Math.min(1, (1 - r) * 49));
  }
  context.putImageData(pixels, 0, 0);
}
