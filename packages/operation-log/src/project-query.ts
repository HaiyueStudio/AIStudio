import type { StableId } from '@haiyue/ai-studio-contracts';
import type { OperationLogQuery } from './types.js';
import { OperationLogError } from './errors.js';

/** Project entry points must use an authoritative workspace identity, never a caller's scope. */
export function projectLogQuery(query: OperationLogQuery, projectId: StableId | null | undefined): OperationLogQuery {
  if (!projectId) throw new OperationLogError('project-log-unavailable', '请先创建或打开项目，再查看项目日志。');
  if (query.projectId && query.projectId !== projectId) throw new OperationLogError('project-log-scope-mismatch', '日志请求所属项目已切换，请刷新后重试。');
  return Object.freeze({ ...query, projectId });
}

