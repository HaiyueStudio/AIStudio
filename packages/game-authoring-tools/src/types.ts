import type { JsonObject, StableId } from '@haiyue/ai-studio-contracts';
import type { SceneSnapshot } from '@haiyue/ai-studio-editor-plugins';
import type { PreviewPlan, PreviewRuntimeSnapshot } from '@haiyue/ai-studio-script-preview';

export type GameToolEffect = 'observe' | 'reversible-edit' | 'trusted-code' | 'runtime-start';
export type GameToolRisk = 'low' | 'medium' | 'high';
export type GameToolApprovalResolution = 'allow-once' | 'allow-always' | 'reject' | 'cancel';
export type GameToolApprovalDecision = 'pending' | GameToolApprovalResolution | 'expired' | 'stale' | 'unavailable';

export interface GameToolDefinition {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly version: '1.0.0';
  readonly title: string;
  readonly description: string;
  readonly effect: GameToolEffect;
  readonly risk: GameToolRisk;
  readonly requiredCapabilities: readonly StableId[];
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly redactedFields: readonly string[];
  readonly presentation: Readonly<{ intent: string; result: string }>;
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  readonly requiresApproval: boolean;
}

export interface GameToolCall {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly toolId: StableId;
  readonly toolVersion: string;
  readonly arguments: JsonObject;
}

export interface GameToolPreview {
  readonly title: string;
  readonly target: string;
  readonly summary: string;
  readonly diff: string;
}

export type GameToolPreparationStatus = 'ready' | 'approval-required' | 'rejected' | 'stale' | 'consumed';

export interface GameToolPreparation {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly callId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly toolId: StableId;
  readonly toolVersion: '1.0.0';
  readonly effect: GameToolEffect;
  readonly risk: GameToolRisk;
  readonly documentId: StableId;
  readonly baseRevision: number;
  readonly argumentsDigest: string;
  readonly previewDigest: string;
  readonly preview: GameToolPreview;
  readonly status: GameToolPreparationStatus;
  readonly approvalId?: StableId;
  readonly expiresAt?: string;
}

export interface GameToolApproval {
  readonly schemaVersion: 1;
  readonly approvalId: StableId;
  readonly preparationId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly toolCallId: StableId;
  readonly toolId: StableId;
  readonly toolVersion: '1.0.0';
  readonly effect: Exclude<GameToolEffect, 'observe'>;
  readonly risk: Exclude<GameToolRisk, 'low'>;
  readonly argumentsDigest: string;
  readonly previewDigest: string;
  readonly documentId: StableId;
  readonly baseRevision: number;
  readonly target: string;
  readonly expiresAt?: string;
  readonly decision: GameToolApprovalDecision;
}

export interface GameToolResult {
  readonly schemaVersion: 1;
  readonly callId: StableId;
  readonly toolId: StableId;
  readonly status: 'completed' | 'rejected' | 'cancelled' | 'failed';
  readonly value: JsonObject;
  readonly documentId: StableId;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly historyLabel?: string;
}

export interface GamePreviewControl {
  start(scene: SceneSnapshot, plan: PreviewPlan, signal?: AbortSignal): Promise<PreviewRuntimeSnapshot>;
  stop(signal?: AbortSignal): Promise<PreviewRuntimeSnapshot>;
  snapshot(): PreviewRuntimeSnapshot;
}

export interface GameToolRuntimeSnapshot {
  readonly definitions: readonly GameToolDefinition[];
  readonly pendingPreparations: number;
  readonly pendingApprovals: number;
  readonly activeCalls: number;
  readonly activeApprovalGrants: number;
  readonly disposed: boolean;
}

export class GameToolProtocolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); this.name = 'GameToolProtocolError'; }
}
