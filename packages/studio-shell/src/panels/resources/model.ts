import type { ResourceCatalogEntryV1, ResourceReferenceV1 } from '@haiyue/ai-studio-contracts';

/** Presentation only. The owner keeps the authoritative query binding and validates IPC. */
export interface ResourcePanelItem {
  readonly entry: ResourceCatalogEntryV1;
  readonly health: string;
  readonly diagnostics: readonly string[];
  readonly metadata: readonly Readonly<{ label: string; value: string }>[];
  readonly configuration: string | null;
  readonly locations: readonly Readonly<{ ref: Extract<ResourceReferenceV1, { kind: 'instance' }>; label: string; field: string }>[];
  readonly target: 'none' | 'entity';
  readonly assignments: readonly string[];
}
export interface ResourcePanelQuery {
  readonly text?: string;
  readonly category?: string;
  readonly kind?: ResourceCatalogEntryV1['kind'];
  readonly status?: ResourceCatalogEntryV1['status'];
  readonly unused?: boolean;
  readonly cursor?: string;
  readonly limit: number;
}
export interface ResourcePanelData {
  readonly projectKey: string | null;
  /** Opaque source token, resolved to the exact project/revision binding by the owner. */
  readonly viewToken: string | null;
  readonly state: 'empty' | 'ready' | 'loading' | 'error';
  readonly items: readonly ResourcePanelItem[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly categories: readonly string[];
  readonly diagnostics: readonly string[];
  readonly target: Readonly<{ entityId: string; label: string }> | null;
}
export type ResourcePanelIntent =
  | Readonly<{ type: 'query' | 'refresh'; query: ResourcePanelQuery }>
  | Readonly<{ type: 'cancel' | 'select-target' }>
  | Readonly<{ type: 'import'; viewToken: string; kind: 'texture' | 'model' | 'audio' | 'animation' }>
  | Readonly<{ type: 'action'; viewToken: string; entry: ResourceCatalogEntryV1; action: ResourceCatalogEntryV1['intents'][number]; targetEntityId?: string; usage?: string }>
  | Readonly<{ type: 'locate-use'; viewToken: string; entry: ResourceCatalogEntryV1; ref: Extract<ResourceReferenceV1, { kind: 'instance' }>; field: string }>;

export const RESOURCE_KIND_LABELS = Object.freeze({ asset: '文件资产', template: '注册模板', preset: '配置预设', instance: '场景实例' });
export const RESOURCE_ACTION_LABELS = Object.freeze({ 'resource.locate': '定位来源', 'asset.inspect': '检查文件', 'asset.assign': '分配给目标', 'template.create': '创建实例', 'preset.apply': '应用预设', 'instance.inspect': '检查实例' });
export function resourceCategoryLabel(value: string): string {
  return ({ Lighting: '灯光', Geometry: '几何体', Material: '材质', Texture: '纹理', Model: '模型', Script: '脚本', Animation: '动画', Audio: '音频', Scene: '场景' } as Record<string, string>)[value] ?? value;
}
export function resourceUsageLabel(entry: ResourceCatalogEntryV1): string {
  if (entry.usage.status === 'known') return entry.usage.items.length ? `${entry.usage.items.length} 处已知使用` : '已确认 0 处使用';
  return entry.usage.status === 'unknown' ? `使用情况未知：${entry.usage.reason}` : entry.usage.reason;
}
export function resourceActions(item: ResourcePanelItem): readonly ResourceCatalogEntryV1['intents'][number][] {
  const entry = item.entry;
  if (entry.schemaVersion !== 1 || entry.kind !== entry.ref.kind || entry.status !== 'available' || !(entry.kind in RESOURCE_KIND_LABELS)) return [];
  const allowed = { asset: ['resource.locate', 'asset.inspect', 'asset.assign'], template: ['resource.locate', 'template.create'], preset: ['resource.locate', 'preset.apply'], instance: ['resource.locate', 'instance.inspect'] }[entry.kind];
  return entry.intents.filter(action => allowed.includes(action));
}
export const EMPTY_RESOURCE_PANEL: ResourcePanelData = Object.freeze({ projectKey: null, viewToken: null, state: 'empty', items: [], total: 0, nextCursor: null, categories: [], diagnostics: [], target: null });
