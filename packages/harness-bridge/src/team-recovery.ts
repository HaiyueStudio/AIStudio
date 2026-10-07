import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import TeamService from '@deepseek-ai/dsh-experimental-agent-team';
import Subagents from '@deepseek-ai/dsh-subagent';
import SessionQuery from '@deepseek-ai/dsh-session-query';
import { asStableId, type TeamSessionJournalPortV1, type TeamRecoveryAdmissionPortV1 } from '@haiyue/ai-studio-contracts';
import { LlmError, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { StudioTeamPersistence } from './team-persistence.js';

export interface HarnessTeamRecoveryOptions {
  readonly journal: TeamSessionJournalPortV1;
  readonly admission: TeamRecoveryAdmissionPortV1;
}
/** Install before creating any Agents. No model-facing Team task board or second Studio plan. */
export async function installTeamRecovery(context: Context, options: HarnessTeamRecoveryOptions): Promise<void> {
  await context.plugin(StudioTeamPersistence, options.journal);
  // Every request in this experimental transport is admitted, including Lead.steer and cold children.
  // Checking only subagents.start would leave both paths unguarded.
  await context.plugin({ name: 'studio:team-request-admission', inject: ['agents', 'sessions', 'llm'], apply(ctx) {
  ctx.on('llm/stream', async function* (request, next) {
    const agent = request.sessionId ? ctx.agents.get(request.sessionId) : undefined;
    if (!agent || request.provider !== 'deepseek-official') throw new LlmError('Team request has no managed session.', 'team.request-unowned');
    const lead = agent.session.header.parentSession ?? agent.id;
    const requestId = asStableId(`team-request:${createHash('sha256').update(`${agent.id}:${agent.session.seq}:${JSON.stringify({ model: request.model, messages: request.messages, tools: request.tools, maxTokens: request.maxTokens })}`).digest('hex')}`);
    const permit = await options.admission.admit({ sessionId: asStableId(String(agent.id)), leadSessionId: asStableId(String(lead)), requestId,
      model: request.model, inputTokenBound: Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools ?? [], system: request.system ?? '' })) + 1024,
      outputTokenLimit: request.maxTokens ?? 0, toolNames: (request.tools ?? []).map(tool => tool.name) }, request.signal ?? new AbortController().signal);
    const signal = request.signal ? AbortSignal.any([request.signal, permit.signal]) : permit.signal;
    const cancel = () => agent.cancel({ kind: 'user' });
    signal.addEventListener('abort', cancel, { once: true });
    let usage: TokenUsage | null = null, status: 'completed' | 'failed' | 'cancelled' = 'failed';
    try {
      signal.throwIfAborted();
      await ctx.sessions.flush(agent.session);
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = { ...chunk.usage, inputTokens: chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0) };
        if (chunk.type === 'finish') status = chunk.reason.kind === 'aborted' ? 'cancelled' : chunk.reason.kind === 'error' ? 'failed' : 'completed';
        yield chunk;
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) status = 'cancelled';
      await permit.settle(usage, status);
    }
  });
  } });
  await context.plugin(TeamSessionQuery);
  await context.plugin(Subagents, { maxActiveSubagents: 2, maxDepth: 1 });
  await context.plugin(TeamService, { maxMembers: 4, maxTasks: 50, maxPendingMessagesPerMember: 16, maxMessageBytes: 16384 });
}

/** Cold continuation needs exact Session reads; no second search index is installed. */
class TeamSessionQuery extends SessionQuery {
  async searchSessions(): Promise<never> { throw new Error('team.session-search-unavailable'); }
  async searchEvents(): Promise<never> { throw new Error('team.session-search-unavailable'); }
}
