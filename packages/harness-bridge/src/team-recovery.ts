import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import TeamService, { TeamId } from '@deepseek-ai/dsh-agent-team';
import Subagents from '@deepseek-ai/dsh-subagent';
import SessionQuery from '@deepseek-ai/dsh-session-query';
import LocalFs from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import { asStableId, type TeamSessionJournalPortV1, type TeamRecoveryAdmissionPortV1 } from '@haiyue/ai-studio-contracts';
import { LlmError, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { StudioTeamPersistence } from './team-persistence.js';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';

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
    if (!agent || request.provider !== 'deepseek-official') throw LlmError.fromFailure({ message: 'Team request has no managed session.', code: 'team.request-unowned' });
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
  await context.plugin(LocalFs);
  await context.plugin(WorkingDirectory);
  await context.plugin(Subagents, { maxActiveSubagents: 2, maxDepth: 1 });
  // This scope exists only after explicit Team recovery admission; product admission remains disabled.
  await context.plugin(TeamService, { maxTasks: 50, defaultEnabled: true });
  if (!context.get('agentTeams') || !context.get('subagents')) throw new Error('team.services-unavailable');
}

/** Cold continuation needs exact Session reads; no second search index is installed. */
class TeamSessionQuery extends SessionQuery {
  async searchSessions(): Promise<never> { throw new Error('team.session-search-unavailable'); }
  async searchEvents(): Promise<never> { throw new Error('team.session-search-unavailable'); }
}

/** rc.2 mailboxes are historical facts in rc.5. Append receipts without rewriting their logs. */
export async function recoverLegacyTeamMessages(context: Context, lead: Agent, signal: AbortSignal): Promise<void> {
  const events = lead.session.snapshotEvents();
  const delivered = new Set(events.flatMap(event => event.type === 'team/message/delivered' ? [String(event.data.messageId)] : []));
  const pending = events.flatMap(event => event.type === 'team/message/queued' && !delivered.has(String(event.data.message.id)) ? [event.data.message] : []);
  if (pending.length > 16) throw new Error('team.legacy-mailbox-limit');
  const handles = new Map<string, AgentHandle>();
  for (const message of pending) {
    signal.throwIfAborted();
    if (message.senderId !== lead.id || message.targetId === lead.id || Buffer.byteLength(JSON.stringify(message)) > 16384 || !message.content.every(block => block.type === 'text')) throw new Error('team.legacy-mailbox-invalid');
    const id = SessionId(message.targetId);
    const stored = await context.sessionPersistence.open(id, 'read', { signal });
    let childEvents;
    try {
      if (stored.header.parentSession !== lead.id) throw new Error('team.legacy-mailbox-unowned');
      childEvents = (await stored.read()).events;
    } finally { await stored.close(); }
    const received = childEvents.some(event => event.type === 'user/message' && event.data.source.kind === 'team-message' && event.data.source.messageId === message.id
      || event.type === 'agent/inbox/spliced' && event.data.inserted.some(input => input.source.kind === 'team-message' && input.source.messageId === message.id));
    if (!received) {
      if (handles.size >= 2 && !handles.has(id)) throw new Error('team.legacy-child-limit');
      const descriptor = [...childEvents].reverse().find(event => event.type === 'subagent/descriptor')?.data;
      if (!descriptor || !('mode' in descriptor) || descriptor.mode !== 'continuable' || !('agentProvider' in descriptor) || descriptor.agentProvider !== 'deepseek-official' || typeof descriptor.agentModel !== 'string') throw new Error('team.legacy-child-not-resumable');
      let handle = handles.get(id);
      if (!handle) {
        handle = await context.agents.resume({ resumeSessionId: id, signal,
          agentOptions: { provider: descriptor.agentProvider, model: descriptor.agentModel, reasoningEffort: ReasoningEffortId(String(descriptor.agentReasoningEffort ?? 'off')), maxTokens: lead.options.maxTokens },
          setup(childContext) {
            const native = new NativeToolExecutor(childContext, () => 1);
            // Historical children have no Studio-approved tool set; native services cannot become their tools.
            childContext.tools.setExecutor({ describe: () => native.describe([]), execute: batch => native.execute(batch) });
          },
        });
        handles.set(id, handle);
        const owned = handle;
        context.effect(() => () => owned.dispose(), 'studio.legacy-team-child');
      }
      // Keep the original source identity so a crash before the Lead receipt cannot redeliver it.
      signal.throwIfAborted();
      const input = createUserMessage({ content: [...message.content], source: { kind: 'team-message', teamId: TeamId(lead.id), messageId: message.id, senderId: lead.id, senderName: message.senderName } });
      handle.agent.steer(input);
      await context.sessions.flush(handle.agent.session);
    }
    signal.throwIfAborted();
    lead.session.append('team/message/delivered', { version: 2, teamId: TeamId(lead.id), messageId: message.id, targetId: id });
    await context.sessions.flush(lead.session);
  }
}
