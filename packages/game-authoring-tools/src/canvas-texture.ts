import type { JsonObject } from '@haiyue/ai-studio-contracts';

export interface CanvasTextureRecipe {
  readonly schemaVersion: 1;
  readonly width: number;
  readonly height: number;
  readonly background?: string;
  readonly commands: readonly CanvasTextureCommand[];
}
export interface CanvasTextureCommand {
  readonly type: 'rect' | 'circle' | 'line' | 'polygon' | 'text';
  readonly x?: number; readonly y?: number; readonly width?: number; readonly height?: number;
  readonly radius?: number; readonly points?: readonly (readonly [number, number])[];
  readonly fill?: string; readonly stroke?: string; readonly lineWidth?: number;
  readonly text?: string; readonly fontSize?: number; readonly fontFamily?: 'sans-serif' | 'serif' | 'monospace';
  readonly fontWeight?: 'normal' | 'bold'; readonly align?: 'left' | 'center' | 'right';
}
export interface CanvasTextureRenderer { render(recipe: CanvasTextureRecipe, signal: AbortSignal): Promise<Uint8Array>; }

const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$' };
const coordinate = { type: 'number', minimum: -8192, maximum: 8192 };
const size = { type: 'number', exclusiveMinimum: 0, maximum: 8192 };
const style = { fill: color, stroke: color, lineWidth: { type: 'number', exclusiveMinimum: 0, maximum: 256 } };
const points = { type: 'array', minItems: 2, maxItems: 128, items: { type: 'array', minItems: 2, maxItems: 2, items: coordinate } };
const command = (type: string, fields: JsonObject, required: string[]) => ({ type: 'object', additionalProperties: false, required: ['type', ...required], properties: { type: { const: type }, ...fields } });
export const CANVAS_TEXTURE_RECIPE_SCHEMA: JsonObject = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'width', 'height', 'commands'],
  properties: {
    schemaVersion: { const: 1 }, width: { type: 'integer', minimum: 1, maximum: 2048 }, height: { type: 'integer', minimum: 1, maximum: 2048 }, background: color,
    commands: { type: 'array', maxItems: 512, items: { oneOf: [
      command('rect', { x: coordinate, y: coordinate, width: size, height: size, ...style }, ['x', 'y', 'width', 'height']),
      command('circle', { x: coordinate, y: coordinate, radius: size, ...style }, ['x', 'y', 'radius']),
      command('line', { points, stroke: color, lineWidth: style.lineWidth }, ['points', 'stroke']),
      command('polygon', { points: { ...points, minItems: 3 }, ...style }, ['points']),
      command('text', { x: coordinate, y: coordinate, text: { type: 'string', minLength: 1, maxLength: 256 }, fontSize: { type: 'number', minimum: 1, maximum: 1024 }, fontFamily: { enum: ['sans-serif', 'serif', 'monospace'] }, fontWeight: { enum: ['normal', 'bold'] }, align: { enum: ['left', 'center', 'right'] }, ...style }, ['x', 'y', 'text', 'fontSize']),
    ] } },
  },
};

export function normalizeCanvasTextureRecipe(value: unknown): CanvasTextureRecipe {
  const fail = (): never => { throw new TypeError('Texture recipe must be version 1, at most 2048 × 2048 pixels and 512 bounded rect/circle/line/polygon/text commands.'); };
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
  const exact = (raw: Record<string, unknown>, required: string[], optional: string[]) => {
    if (required.some(key => raw[key] === undefined) || Object.keys(raw).some(key => ![...required, ...optional].includes(key))) fail();
  };
  const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fail();
  const color = (value: unknown) => { if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/u.test(value)) fail(); };
  const raw = record(value); exact(raw, ['schemaVersion', 'width', 'height', 'commands'], ['background']);
  if (raw.schemaVersion !== 1 || !Number.isInteger(number(raw.width, 1, 2048)) || !Number.isInteger(number(raw.height, 1, 2048))) fail();
  if (raw.background !== undefined) color(raw.background);
  if (!Array.isArray(raw.commands) || raw.commands.length > 512 || JSON.stringify(raw).length > 128 * 1024) fail();
  for (const value of raw.commands as unknown[]) {
    const item = record(value); const type = item.type; const style = ['fill', 'stroke', 'lineWidth'];
    if (type === 'rect') exact(item, ['type', 'x', 'y', 'width', 'height'], style);
    else if (type === 'circle') exact(item, ['type', 'x', 'y', 'radius'], style);
    else if (type === 'line') exact(item, ['type', 'points', 'stroke'], ['lineWidth']);
    else if (type === 'polygon') exact(item, ['type', 'points'], style);
    else if (type === 'text') exact(item, ['type', 'x', 'y', 'text', 'fontSize'], [...style, 'fontFamily', 'fontWeight', 'align']);
    else fail();
    for (const key of ['x', 'y']) if (item[key] !== undefined) number(item[key], -8192, 8192);
    for (const key of ['width', 'height', 'radius']) if (item[key] !== undefined && number(item[key], 0, 8192) === 0) fail();
    if (item.lineWidth !== undefined && number(item.lineWidth, 0, 256) === 0) fail();
    for (const key of ['fill', 'stroke']) if (item[key] !== undefined) color(item[key]);
    if (type === 'line' || type === 'polygon') {
      if (!Array.isArray(item.points) || item.points.length < (type === 'polygon' ? 3 : 2) || item.points.length > 128) fail();
      for (const point of item.points as unknown[]) { if (!Array.isArray(point) || point.length !== 2) fail(); for (const coordinate of point as unknown[]) number(coordinate, -8192, 8192); }
    }
    if (type === 'text') {
      if (typeof item.text !== 'string' || item.text.length < 1 || item.text.length > 256) fail();
      number(item.fontSize, 1, 1024);
      if (item.fontFamily !== undefined && !['sans-serif', 'serif', 'monospace'].includes(String(item.fontFamily))) fail();
      if (item.fontWeight !== undefined && !['normal', 'bold'].includes(String(item.fontWeight))) fail();
      if (item.align !== undefined && !['left', 'center', 'right'].includes(String(item.align))) fail();
    }
  }
  return JSON.parse(JSON.stringify(raw)) as CanvasTextureRecipe;
}

/** Pure browser entry: only a validated drawing recipe is supplied, never executable user code. */
export function drawCanvasTexture(recipe: CanvasTextureRecipe): string {
  const canvas = document.createElement('canvas'); canvas.width = recipe.width; canvas.height = recipe.height;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas 2D is unavailable.');
  try {
    if (recipe.background) { context.fillStyle = recipe.background; context.fillRect(0, 0, recipe.width, recipe.height); }
    for (const item of recipe.commands) {
      context.save(); context.lineWidth = item.lineWidth ?? 1; context.fillStyle = item.fill ?? '#000000'; context.strokeStyle = item.stroke ?? '#000000';
      context.beginPath();
      if (item.type === 'rect') context.rect(item.x!, item.y!, item.width!, item.height!);
      else if (item.type === 'circle') context.arc(item.x!, item.y!, item.radius!, 0, Math.PI * 2);
      else if (item.type === 'line' || item.type === 'polygon') {
        item.points!.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
        if (item.type === 'polygon') context.closePath();
      } else {
        context.font = `${item.fontWeight ?? 'normal'} ${item.fontSize}px ${item.fontFamily ?? 'sans-serif'}`;
        context.textAlign = item.align ?? 'center'; context.textBaseline = 'middle';
        if (item.fill || !item.stroke) context.fillText(item.text!, item.x!, item.y!);
        if (item.stroke) context.strokeText(item.text!, item.x!, item.y!);
      }
      if (item.type !== 'text') {
        if (item.type !== 'line' && (item.fill || !item.stroke)) context.fill();
        if (item.stroke) context.stroke();
      }
      context.restore();
    }
    return canvas.toDataURL('image/png');
  } finally { canvas.width = 0; canvas.height = 0; }
}
