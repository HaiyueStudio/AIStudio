import { createRequire } from 'node:module';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asStableId, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { AgentBackendProtocolError, normalizeBackendFailure, type AgentBackend, type AgentBackendDescriptor, type AgentBackendEvent, type AgentBackendStatus, type AgentLoginHandoff, type AgentRateLimitSnapshot, type AgentTurnInput } from '@haiyue/ai-studio-agent-runtime';
import { backendEvent, deferred, isRecord, TurnChannel, type Deferred } from './shared.js';

type RpcId = number | string;
type RpcObject = Record<string, unknown>;

export interface CodexLineTransport {
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<Readonly<{ code: number | null; signal: string | null }>>;
  write(line: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface CodexAppServerBackendOptions {
  readonly transport?: CodexLineTransport;
  readonly createTransport?: () => Promise<CodexLineTransport>;
  readonly loginMode?: 'browser' | 'device-code';
  readonly isolatedCwd?: string;
}

export class CodexAppServerBackend implements AgentBackend {
  readonly upstream = Object.freeze({ package: '@openai/codex', version: '0.148.0', schemaSha256: 'dc3613ce823c95087e660f8d12dac89856863eff653f2c8dd8f1ad0cac98ef11' });
  readonly descriptor: AgentBackendDescriptor = Object.freeze({
    schemaVersion: 1,
    id: asStableId('backend:codex-app-server'),
    kind: 'codex-app-server',
    protocolVersion: '0.148.0',
    capabilities: Object.freeze({ resume: true, questions: true, structuredTools: true, backendApprovals: true, usage: true, rateLimits: true }),
  });

  private transport?: CodexLineTransport;
  private pump?: Promise<void>;
  private initialized?: Promise<void>;
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<RpcId, Deferred<unknown>>();
  private readonly turns = new Map<StableId, TurnChannel>();
  private readonly threadTurns = new Map<string, StableId>();
  private readonly threadToolNames = new Map<string, ReadonlyMap<string, StableId>>();
  private readonly pendingTools = new Map<StableId, RpcId>();
  private readonly pendingQuestions = new Map<StableId, RpcId>();
  private readonly turnAbortCleanups = new Map<StableId, () => void>();
  private readonly ownedCwds = new Map<StableId, string>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private readonly lastRateLimits = new Map<string, AgentRateLimitSnapshot>();

  constructor(private readonly options: CodexAppServerBackendOptions = {}) {}

  async authenticate(signal?: AbortSignal): Promise<AgentLoginHandoff | null> {
    await this.ensureInitialized(signal);
    const mode = this.options.loginMode ?? 'browser';
    const result = await this.request('account/login/start', mode === 'device-code' ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt', codexStreamlinedLogin: true, useHostedLoginSuccessPage: true }, signal);
    if (!isRecord(result) || typeof result.type !== 'string') throw this.protocol('codex.login-malformed', 'Codex returned a malformed login handoff.');
    if (result.type === 'chatgpt' && typeof result.loginId === 'string' && typeof result.authUrl === 'string') return Object.freeze({ id: asStableId(result.loginId), kind: 'browser', url: result.authUrl });
    if (result.type === 'chatgptDeviceCode' && typeof result.loginId === 'string' && typeof result.verificationUrl === 'string' && typeof result.userCode === 'string') return Object.freeze({ id: asStableId(result.loginId), kind: 'device-code', url: result.verificationUrl, userCode: result.userCode });
    if (result.type === 'apiKey' || result.type === 'chatgptAuthTokens') return null;
    throw this.protocol('codex.login-malformed', 'Codex returned an unsupported login handoff.');
  }

  async status(signal?: AbortSignal): Promise<AgentBackendStatus> {
    try {
      await this.ensureInitialized(signal);
      const account = await this.request('account/read', { refreshToken: false }, signal);
      if (!isRecord(account) || typeof account.requiresOpenaiAuth !== 'boolean') throw this.protocol('codex.account-malformed', 'Codex returned malformed account status.');
      let rateLimits: readonly AgentRateLimitSnapshot[] = Object.freeze([]);
      if (account.account) {
        const rates = await this.request('account/rateLimits/read', {}, signal);
        rateLimits = this.captureRateLimits(rates);
      }
      const accountValue = isRecord(account.account) ? account.account : undefined;
      return Object.freeze({
        state: accountValue || !account.requiresOpenaiAuth ? 'ready' : 'auth-required',
        authMode: accountValue?.type === 'apiKey' ? 'api-key' : 'chatgpt',
        ...(typeof accountValue?.planType === 'string' ? { accountPlan: accountValue.planType } : {}),
        rateLimits,
      });
    } catch (cause) {
      const failure = normalizeBackendFailure(cause);
      if (failure.code === 'agent.auth-required') return Object.freeze({ state: 'auth-required', authMode: 'chatgpt', rateLimits: Object.freeze([]), diagnostic: failure });
      return Object.freeze({ state: 'error', authMode: 'chatgpt', rateLimits: Object.freeze([]), diagnostic: failure });
    }
  }

  async logout(signal?: AbortSignal): Promise<void> { await this.ensureInitialized(signal); await this.request('account/logout', {}, signal); }

  startTurn(input: AgentTurnInput, signal?: AbortSignal): AsyncIterable<AgentBackendEvent> {
    this.assertActive();
    const channel = new TurnChannel();
    void this.beginTurn(input, channel, signal);
    return channel.stream();
  }

  resumeTurn(_sessionId: StableId, turnId: StableId): AsyncIterable<AgentBackendEvent> {
    this.assertActive();
    const channel = this.turns.get(turnId);
    if (!channel) throw new AgentBackendProtocolError('agent.resume-missing', `Codex turn ${turnId} is unavailable.`);
    return channel.stream();
  }

  async submitToolResult(toolCallId: StableId, result: JsonObject, signal?: AbortSignal): Promise<void> {
    this.assertActive(); if (signal?.aborted) throw signal.reason;
    const rpcId = this.pendingTools.get(toolCallId);
    if (rpcId === undefined) throw new AgentBackendProtocolError('agent.tool-result-unavailable', `Codex tool call ${toolCallId} is not pending.`);
    this.pendingTools.delete(toolCallId);
    await this.respond(rpcId, { contentItems: [{ type: 'inputText', text: JSON.stringify(result) }], success: true });
  }

  async answerQuestion(nodeId: StableId, answer: JsonObject, signal?: AbortSignal): Promise<void> {
    this.assertActive(); if (signal?.aborted) throw signal.reason;
    const rpcId = this.pendingQuestions.get(nodeId);
    if (rpcId === undefined) throw new AgentBackendProtocolError('agent.question-unavailable', `Codex question ${nodeId} is not pending.`);
    this.pendingQuestions.delete(nodeId); await this.respond(rpcId, { answers: answer });
  }

  async resolveBackendApproval(id: StableId, decision: 'allow' | 'reject', signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (decision === 'allow') throw new AgentBackendProtocolError('codex.builtin-effect-denied', 'Codex built-in effects cannot be authorized by Studio.');
    throw new AgentBackendProtocolError('agent.approval-unavailable', `Codex approval ${id} was already denied at the protocol boundary.`);
  }

  async cancelTurn(sessionId: StableId, turnId: StableId): Promise<void> {
    this.assertActive(); await this.ensureInitialized();
    await this.request('turn/interrupt', { threadId: sessionId, turnId });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    const error = new AgentBackendProtocolError('codex.backend-disposed', 'Codex backend was disposed.');
    for (const item of this.pending.values()) item.reject(error); this.pending.clear();
    for (const channel of this.turns.values()) channel.terminalFailure(this.descriptor.id, normalizeBackendFailure(error), 'interrupted');
    this.pendingTools.clear(); this.pendingQuestions.clear();
    for (const cleanup of this.turnAbortCleanups.values()) cleanup(); this.turnAbortCleanups.clear();
    this.threadToolNames.clear();
    for (const turnId of this.ownedCwds.keys()) this.scheduleCwdCleanup(turnId); await Promise.allSettled([...this.cleanupTasks]);
    await this.transport?.dispose(); await this.pump?.catch(() => {});
  }

  private async beginTurn(input: AgentTurnInput, channel: TurnChannel, signal?: AbortSignal): Promise<void> {
    let turnId: StableId | undefined; let unownedTempCwd: string | undefined;
    try {
      await this.ensureInitialized(signal);
      const cwd = this.options.isolatedCwd ?? await mkdtemp(join(tmpdir(), 'haiyue-codex-')); if (!this.options.isolatedCwd) unownedTempCwd = cwd;
      const dynamicTools = input.tools.map((tool, index) => ({ type: 'function', name: codexToolName(tool.id, index), description: `${tool.description}\nStudio tool id: ${tool.id}`, inputSchema: tool.inputSchema }));
      const threadResponse = await this.request('thread/start', {
        cwd, runtimeWorkspaceRoots: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: true, environments: [], selectedCapabilityRoots: [],
        config: { web_search: 'disabled', mcp_servers: {} },
        baseInstructions: 'You are the AIStudio game-authoring agent. You may act only through the dynamic Studio tools supplied in this thread.',
        developerInstructions: 'Never invoke shell, command execution, file mutation, patching, direct filesystem access, network access, MCP, apps, or web search. Use only the supplied dynamic Studio tools. If no suitable Studio tool exists, explain the limitation.',
        dynamicTools,
      }, signal);
      const thread = isRecord(threadResponse) && isRecord(threadResponse.thread) ? threadResponse.thread : undefined;
      if (!thread || typeof thread.id !== 'string') throw this.protocol('codex.thread-malformed', 'Codex returned a malformed thread identity.');
      const response = await this.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: input.prompt, text_elements: [] }], environments: [], cwd, runtimeWorkspaceRoots: [], approvalPolicy: 'never', approvalsReviewer: 'user' }, signal);
      const turn = isRecord(response) && isRecord(response.turn) ? response.turn : undefined;
      if (!turn || typeof turn.id !== 'string') throw this.protocol('codex.turn-malformed', 'Codex returned a malformed turn identity.');
      const threadId = thread.id; turnId = asStableId(turn.id); this.turns.set(turnId, channel); this.threadTurns.set(threadId, turnId);
      this.threadToolNames.set(threadId, new Map(dynamicTools.map((tool, index) => [tool.name, input.tools[index]!.id])));
      if (unownedTempCwd) { this.ownedCwds.set(turnId, unownedTempCwd); unownedTempCwd = undefined; }
      channel.emit(backendEvent(this.descriptor.id, threadId, turn.id, 'status', { status: 'running' }));
      if (signal) {
        const abort = (): void => { void this.cancelTurn(asStableId(threadId), turnId!).catch(() => {}); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        this.turnAbortCleanups.set(turnId, () => signal.removeEventListener('abort', abort));
      }
    } catch (cause) { if (unownedTempCwd) await rmdir(unownedTempCwd).catch(() => {}); channel.terminalFailure(this.descriptor.id, normalizeBackendFailure(cause)); }
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    this.assertActive();
    if (!this.initialized) this.initialized = this.initialize(signal).catch((cause) => { this.initialized = undefined; throw cause; });
    return this.initialized;
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    this.transport = this.options.transport ?? await (this.options.createTransport?.() ?? createCodexProcessTransport());
    this.pump = this.readLoop(this.transport);
    await this.request('initialize', { clientInfo: { name: 'haiyue-ai-studio', title: 'HaiYue AIStudio', version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }, signal);
    await this.notify('initialized', {});
  }

  private async request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
    if (!this.transport) throw this.protocol('codex.transport-unavailable', 'Codex transport is unavailable.');
    if (signal?.aborted) throw signal.reason;
    const id = this.nextId++; const pending = deferred<unknown>(); this.pending.set(id, pending);
    const abort = (): void => { if (this.pending.delete(id)) pending.reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    try { await this.transport.write(JSON.stringify({ id, method, params })); return await pending.promise; }
    finally { signal?.removeEventListener('abort', abort); this.pending.delete(id); }
  }

  private async notify(method: string, params: JsonObject): Promise<void> { if (!this.transport) throw this.protocol('codex.transport-unavailable', 'Codex transport is unavailable.'); await this.transport.write(JSON.stringify({ method, params })); }
  private async respond(id: RpcId, result: JsonObject): Promise<void> { if (!this.transport) throw this.protocol('codex.transport-unavailable', 'Codex transport is unavailable.'); await this.transport.write(JSON.stringify({ id, result })); }
  private async reject(id: RpcId, code: number, message: string): Promise<void> { if (!this.transport) return; await this.transport.write(JSON.stringify({ id, error: { code, message } })); }

  private async readLoop(transport: CodexLineTransport): Promise<void> {
    try {
      for await (const line of transport.lines) {
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw this.protocol('codex.malformed-json', 'Codex App Server emitted malformed JSON.'); }
        if (!isRecord(value) || ('jsonrpc' in value && value.jsonrpc !== '2.0')) throw this.protocol('codex.malformed-frame', 'Codex App Server emitted a malformed JSON-RPC frame.');
        if ('id' in value && !('method' in value)) this.onResponse(value);
        else if (typeof value.method === 'string' && 'id' in value) await this.onServerRequest(value);
        else if (typeof value.method === 'string') this.onNotification(value.method, isRecord(value.params) ? value.params : {});
        else throw this.protocol('codex.malformed-frame', 'Codex App Server emitted an unclassified JSON-RPC frame.');
      }
      const exit = await transport.exited;
      if (!this.disposed) throw this.protocol('codex.process-exited', `Codex App Server exited (${exit.code ?? exit.signal ?? 'unknown'}).`);
    } catch (cause) { if (!this.disposed) this.failAll(cause); }
  }

  private onResponse(value: RpcObject): void {
    const id = value.id;
    if (typeof id !== 'number' && typeof id !== 'string') throw this.protocol('codex.response-malformed', 'Codex response id is invalid.');
    const pending = this.pending.get(id); if (!pending) return;
    if (isRecord(value.error)) { const status = typeof value.error.code === 'number' && (value.error.code === 401 || value.error.code === 429) ? value.error.code : undefined; pending.reject(Object.assign(new AgentBackendProtocolError('codex.rpc-error', typeof value.error.message === 'string' ? value.error.message : 'Codex request failed.'), status ? { status } : {})); }
    else if ('result' in value) pending.resolve(value.result);
    else pending.reject(this.protocol('codex.response-malformed', 'Codex response has neither result nor error.'));
  }

  private async onServerRequest(value: RpcObject): Promise<void> {
    const id = value.id; if ((typeof id !== 'number' && typeof id !== 'string') || typeof value.method !== 'string' || !isRecord(value.params)) throw this.protocol('codex.request-malformed', 'Codex server request is malformed.');
    const params = value.params; const turnId = typeof params.turnId === 'string' ? asStableId(params.turnId) : undefined;
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const channel = turnId ? this.turns.get(turnId) : threadId ? this.turns.get(this.threadTurns.get(threadId)!) : undefined;
    if (value.method === 'item/tool/call') {
      if (!channel || !turnId || !threadId || typeof params.callId !== 'string' || typeof params.tool !== 'string' || !isJsonValue(params.arguments)) { await this.reject(id, -32602, 'Malformed dynamic tool call.'); return; }
      const studioToolId = this.threadToolNames.get(threadId)?.get(params.tool);
      if (!studioToolId) { await this.reject(id, -32601, 'Dynamic tool is not in the Studio allowlist.'); channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'diagnostic', { code: 'codex.tool-not-allowed', message: 'Codex requested an unregistered dynamic tool.', retryable: false })); return; }
      const toolCallId = asStableId(params.callId); this.pendingTools.set(toolCallId, id);
      channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'tool-request', { toolCallId, toolId: studioToolId, arguments: toJsonObject(params.arguments) })); return;
    }
    if (value.method === 'item/tool/requestUserInput') {
      if (!channel || !turnId || !threadId || typeof params.itemId !== 'string' || !Array.isArray(params.questions)) { await this.reject(id, -32602, 'Malformed user-input request.'); return; }
      const nodeId = asStableId(params.itemId); this.pendingQuestions.set(nodeId, id);
      channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'question', { nodeId, questions: jsonArray(params.questions), isBlocking: params.isBlocking === true })); return;
    }
    if (deniedServerMethods.has(value.method)) {
      await this.respond(id, denialResponse(value.method));
      if (channel && turnId && threadId) {
        const approvalId = `codex-approval:${String(params.itemId ?? id).replace(/[^A-Za-z0-9._:-]/gu, '_')}`;
        channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'approval', { approvalId, domain: 'codex-builtin', requestKind: value.method, decision: 'reject' }));
        channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'diagnostic', { code: 'codex.builtin-effect-denied', message: `Denied Codex built-in request: ${value.method}`, retryable: false }));
      }
      return;
    }
    if (forbiddenServerMethods.has(value.method)) {
      await this.reject(id, -32601, `Disabled Codex server request: ${value.method}`);
      if (channel && turnId && threadId) channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'diagnostic', { code: 'codex.builtin-effect-denied', message: `Rejected disabled Codex request: ${value.method}`, retryable: false }));
      return;
    }
    await this.reject(id, -32601, `Unsupported Codex server request: ${value.method}`);
  }

  private onNotification(method: string, params: RpcObject): void {
    if (method === 'account/rateLimits/updated') { this.captureRateLimits({ rateLimits: params.rateLimits }); for (const [turnId, channel] of this.turns) { const threadId = [...this.threadTurns].find(([, candidate]) => candidate === turnId)?.[0]; if (threadId) channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'usage', { rateLimits: [...this.lastRateLimits.values()] as unknown as JsonValue })); } return; }
    const turnIdValue = typeof params.turnId === 'string' ? params.turnId : isRecord(params.turn) && typeof params.turn.id === 'string' ? params.turn.id : undefined;
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (!turnIdValue || !threadId) return;
    const turnId = asStableId(turnIdValue); const channel = this.turns.get(turnId); if (!channel) return;
    if (method === 'item/agentMessage/delta') {
      if (typeof params.delta !== 'string') { channel.terminalFailure(this.descriptor.id, normalizeBackendFailure(this.protocol('codex.delta-malformed', 'Codex text delta is malformed.'))); return; }
      channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'conversation-node', { nodeKind: 'text', status: 'streaming', delta: params.delta, ...(typeof params.itemId === 'string' ? { nodeId: params.itemId } : {}) }));
    } else if (method === 'thread/tokenUsage/updated' && isRecord(params.tokenUsage)) {
      const total = isRecord(params.tokenUsage.total) ? params.tokenUsage.total : {};
      const last = isRecord(params.tokenUsage.last) ? params.tokenUsage.last : {};
      channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'usage', normalizedTokenUsage(last, total, params.tokenUsage.modelContextWindow)));
    } else if (method === 'error') {
      channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'diagnostic', { code: 'codex.server-error', message: diagnosticMessage(params), retryable: false }));
    } else if (method === 'turn/completed') {
      const turn = isRecord(params.turn) ? params.turn : undefined; const status = mapTurnStatus(turn?.status);
      if (status === 'failed' && isRecord(turn?.error)) channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'diagnostic', classifyTurnError(turn.error)));
      channel.emit(backendEvent(this.descriptor.id, threadId, turnId, 'completed', { status }));
      this.turnAbortCleanups.get(turnId)?.(); this.turnAbortCleanups.delete(turnId);
      this.scheduleCwdCleanup(turnId);
    }
  }

  private captureRateLimits(value: unknown): readonly AgentRateLimitSnapshot[] {
    if (!isRecord(value)) return Object.freeze([...this.lastRateLimits.values()]);
    const buckets = isRecord(value.rateLimitsByLimitId) ? value.rateLimitsByLimitId : isRecord(value.rateLimits) ? { default: value.rateLimits } : {};
    for (const [fallbackName, raw] of Object.entries(buckets)) {
      if (!isRecord(raw)) continue; const window = isRecord(raw.primary) ? raw.primary : undefined;
      const name = typeof raw.limitName === 'string' ? raw.limitName : typeof raw.limitId === 'string' ? raw.limitId : fallbackName;
      const snapshot = Object.freeze({ name, ...(typeof window?.usedPercent === 'number' ? { usedPercent: window.usedPercent } : {}), ...(typeof window?.resetsAt === 'number' ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() } : {}) });
      this.lastRateLimits.set(name, snapshot);
    }
    return Object.freeze([...this.lastRateLimits.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  private failAll(cause: unknown): void {
    const failure = normalizeBackendFailure(cause); for (const item of this.pending.values()) item.reject(cause); this.pending.clear();
    for (const channel of this.turns.values()) channel.terminalFailure(this.descriptor.id, failure, 'interrupted');
    this.pendingTools.clear(); this.pendingQuestions.clear(); for (const cleanup of this.turnAbortCleanups.values()) cleanup(); this.turnAbortCleanups.clear(); for (const turnId of this.ownedCwds.keys()) this.scheduleCwdCleanup(turnId); void this.transport?.dispose();
  }
  private scheduleCwdCleanup(turnId: StableId): void { const cwd = this.ownedCwds.get(turnId); if (!cwd) return; this.ownedCwds.delete(turnId); const task = rmdir(cwd).catch(() => {}).finally(() => this.cleanupTasks.delete(task)); this.cleanupTasks.add(task); }
  private protocol(code: string, message: string): AgentBackendProtocolError { return new AgentBackendProtocolError(code, message); }
  private assertActive(): void { if (this.disposed) throw this.protocol('agent.backend-disposed', 'Codex backend is disposed.'); }
}

export async function createCodexProcessTransport(): Promise<CodexLineTransport> {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve('@openai/codex/package.json');
  const manifest = require(packageJson) as { bin?: string | Record<string, string> };
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.codex;
  if (!relativeBin) throw new AgentBackendProtocolError('codex.binary-missing', 'Pinned @openai/codex package does not declare its binary.');
  const binary = join(packageJson, '..', relativeBin);
  const disableArgs = CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]); const enableArgs = CODEX_ENABLED_FEATURES.flatMap((feature) => ['--enable', feature]);
  const env = sanitizedCodexEnvironment(process.env);
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(process.execPath, [binary, '--strict-config', ...enableArgs, ...disableArgs, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  return new ChildProcessLineTransport(child);
}

class ChildProcessLineTransport implements CodexLineTransport {
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<Readonly<{ code: number | null; signal: string | null }>>;
  private disposed = false;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity }); this.lines = reader;
    this.exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve(Object.freeze({ code, signal }))); child.once('error', () => resolve(Object.freeze({ code: null, signal: 'spawn-error' }))); });
    child.stderr.resume();
  }
  async write(line: string): Promise<void> {
    if (this.disposed || !this.child.stdin.writable) throw new AgentBackendProtocolError('codex.transport-closed', 'Codex App Server stdin is closed.');
    await new Promise<void>((resolve, reject) => this.child.stdin.write(`${line}\n`, (error) => error ? reject(error) : resolve()));
  }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.child.stdin.end(); const timer = setTimeout(() => this.child.kill(), 1_000); await this.exited; clearTimeout(timer); }
}

export function sanitizedCodexEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = new Set(['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'CODEX_HOME']);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => allow.has(key) && value !== undefined));
}

function denialResponse(method: string): JsonObject {
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { decision: { denied: { rejection: 'Codex built-in effects are disabled in AIStudio.' } } };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
  return { decision: 'decline' };
}
function mapTurnStatus(value: unknown): 'completed' | 'cancelled' | 'failed' | 'interrupted' { return value === 'completed' ? 'completed' : value === 'interrupted' ? 'cancelled' : value === 'failed' ? 'failed' : 'interrupted'; }
function diagnosticMessage(value: RpcObject): string { if (typeof value.message === 'string') return value.message; if (isRecord(value.error) && typeof value.error.message === 'string') return value.error.message; return 'Codex App Server reported an error.'; }
function classifyTurnError(value: RpcObject): JsonObject {
  const info = value.codexErrorInfo; const text = typeof info === 'string' ? info : isRecord(info) ? Object.keys(info)[0] : undefined;
  const code = info === 'unauthorized' ? 'agent.auth-required' : info === 'usageLimitExceeded' ? 'agent.rate-limited' : text ? `codex.${text}` : 'codex.turn-failed';
  return { code, message: diagnosticMessage(value), retryable: info === 'serverOverloaded' || text === 'httpConnectionFailed' || text === 'responseStreamConnectionFailed' || text === 'responseStreamDisconnected' };
}
function toJsonObject(value: JsonValue): JsonObject { return isRecord(value) ? jsonObject(value) : { value }; }
function jsonObject(value: RpcObject): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
function jsonArray(value: unknown[]): JsonValue[] { return JSON.parse(JSON.stringify(value)) as JsonValue[]; }
function normalizedTokenUsage(last: RpcObject, total: RpcObject, contextWindow: unknown): JsonObject {
  const result: Record<string, JsonValue> = {};
  copyNumber(last, 'inputTokens', result, 'inputTokens'); copyNumber(last, 'outputTokens', result, 'outputTokens'); copyNumber(last, 'cachedInputTokens', result, 'cacheReadTokens'); copyNumber(last, 'reasoningOutputTokens', result, 'reasoningTokens');
  copyNumber(total, 'inputTokens', result, 'totalInputTokens'); copyNumber(total, 'outputTokens', result, 'totalOutputTokens'); if (typeof contextWindow === 'number') result.modelContextWindow = contextWindow;
  return Object.freeze(result);
}
function copyNumber(source: RpcObject, sourceKey: string, target: Record<string, JsonValue>, targetKey: string): void { const value = source[sourceKey]; if (typeof value === 'number') target[targetKey] = value; }
function isJsonValue(value: unknown): value is JsonValue { try { return value === null || ['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'object' && JSON.stringify(value) !== undefined); } catch { return false; } }
function codexToolName(id: StableId, index: number): string { const normalized = id.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 48); return `studio_${index}_${normalized}`; }
const deniedServerMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'applyPatchApproval', 'execCommandApproval', 'mcpServer/elicitation/request']);
const forbiddenServerMethods = new Set(['account/chatgptAuthTokens/refresh', 'attestation/generate', 'currentTime/read']);
export const CODEX_DISABLED_FEATURES = Object.freeze([
  'apps', 'auth_elicitation', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
  'hooks', 'image_generation', 'in_app_browser', 'multi_agent', 'plugins', 'plugin_sharing', 'shell_snapshot', 'shell_tool',
  'skill_env_var_dependency_prompt', 'skill_mcp_dependency_install', 'skill_search', 'tool_call_mcp_elicitation', 'tool_suggest',
  'unified_exec', 'view_image', 'workspace_dependencies',
]);
export const CODEX_ENABLED_FEATURES = Object.freeze(['default_mode_request_user_input']);
