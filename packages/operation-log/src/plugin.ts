import {
  asStableId,
  createStudioServiceToken,
  defineStudioPlugin,
  type JsonObject,
  type StudioPluginDefinition,
} from '@haiyue/ai-studio-contracts';
import { OperationLog } from './operation-log.js';
import type { DiagnosticsQueryService, OperationLogStatus } from './types.js';

export interface OperationLogService {
  readonly log: OperationLog;
  status(): OperationLogStatus;
}

export const operationLogServiceToken = createStudioServiceToken<OperationLogService>('studio.operation-log');
export const diagnosticsQueryServiceToken = createStudioServiceToken<DiagnosticsQueryService>('studio.diagnostics.query');

type OperationLogPluginConfig = JsonObject & Readonly<{
  rootDirectory: string;
  appVersion: string;
}>;

export function createOperationLogPlugin(): StudioPluginDefinition<OperationLogPluginConfig> {
  return defineStudioPlugin({
    manifest: {
      schemaVersion: 1,
      id: asStableId('studio.operation-log.plugin'),
      version: '0.0.0',
      apiVersion: '1.0',
      required: [],
      optional: [],
      provides: [{ id: asStableId('studio.operation-log'), version: '1.0.0' }],
      contributions: [],
      activationPolicy: 'required',
    },
    validateConfig(value): OperationLogPluginConfig {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Operation Log config must be an object.');
      const config = value as Record<string, unknown>;
      if (typeof config.rootDirectory !== 'string' || typeof config.appVersion !== 'string') {
        throw new TypeError('Operation Log config requires rootDirectory and appVersion strings.');
      }
      return Object.freeze({ rootDirectory: config.rootDirectory, appVersion: config.appVersion }) as OperationLogPluginConfig;
    },
    async activate(context, config) {
      const log = await OperationLog.open({ rootDirectory: config.rootDirectory, appVersion: config.appVersion });
      try { context.owner.assertActive(); }
      catch (cause) { await log.close(); throw cause; }
      const service = Object.freeze({ log, status: () => log.status() });
      context.services.provide(operationLogServiceToken, service);
      context.services.provide(diagnosticsQueryServiceToken, log.diagnosticsService());
      context.events.onDurable((event) => {
        void log.append({
          timestamp: event.timestamp,
          kind: normalizeEventKind(event.kind),
          severity: 'info',
          source: event.source,
          correlation: { pluginId: event.source },
          payload: Object.freeze({ ...event.payload, studioEventId: event.id }),
          provenance: { pluginVersion: '0.0.0' },
        }).catch((cause) => context.report({
          code: 'operation-log.append-failed',
          severity: 'error',
          message: 'A durable Studio event could not be persisted; protected operations are disabled.',
          cause,
        }));
      });
      context.effects.own('operation-log.close', () => log.close());
    },
  });
}

function normalizeEventKind(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9./-]+/g, '-');
  return normalized.length >= 3 && /^[a-z]/.test(normalized) ? normalized.slice(0, 96) : `studio/${normalized}`.slice(0, 96);
}
