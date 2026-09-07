

export function stringField(value: unknown, fallback: string): string { return typeof value === 'string' ? value.slice(0, 2_000) : fallback; }
export function numberField(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
export function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
export function errorCode(value: unknown): string { return value && typeof value === 'object' && 'code' in value ? String((value as { code: unknown }).code).slice(0, 96) : 'conversation.operation-failed'; }
export function errorMessage(value: unknown): string { return (value instanceof Error ? value.message : String(value)).slice(0, 2_000); }
