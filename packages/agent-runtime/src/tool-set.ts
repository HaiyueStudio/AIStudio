import { createHash } from 'node:crypto';
import { canonicalStringify } from '@haiyue/ai-studio-operation-log';
import type { AgentTurnInput } from './index.js';

/** Bind a provider session to the exact ordered tool contract sent to it. */
export function toolSetSignature(tools: AgentTurnInput['tools']): string {
  return createHash('sha256').update(canonicalStringify(tools.map(tool => ({ id: tool.id, description: tool.description, inputSchema: tool.inputSchema })))).digest('hex');
}
