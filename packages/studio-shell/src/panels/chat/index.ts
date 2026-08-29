import type { JsonObject, StableId, TaskBudgetV2 } from '@haiyue/ai-studio-contracts';
import { approvalFromNode, planFromNode, questionFromNode, safeText } from '../../conversation/validation.js';
import type {
  ChatCardAction,
  ChatCardReadModel,
  ConversationBackendReadModel,
  ConversationIntent,
  ConversationNodeReadModel,
  ConversationReadModel,
  ConversationTaskRunReadModel,
} from '../../conversation/types.js';

export interface ChatPanelReadModel {
  readonly backendId: StableId | null;
  readonly backends: readonly ConversationBackendReadModel[];
  readonly cards: readonly ChatCardReadModel[];
  readonly composer: Readonly<{ busy: boolean; blockedReason: string | null; canSend: boolean; canCancel: boolean }>;
  readonly connection: ConversationReadModel['connection'];
  readonly taskAccounting: ConversationReadModel['taskAccounting'];
  readonly taskRuns: ConversationReadModel['taskRuns'];
  readonly ariaLive: string;
}

export function presentChatPanel(snapshot: ConversationReadModel, now = Date.now()): ChatPanelReadModel {
  const cards = Object.freeze(snapshot.nodes.map((node) => presentConversationNode(node, now)));
  const selected = snapshot.backends.find((backend) => backend.id === snapshot.backendId);
  const backendReady = selected?.state === 'ready' && selected.selectedModel !== null && selected.selectedReasoningEffort !== null && selected.outputTokenLimit !== null;
  return Object.freeze({
    backendId: snapshot.backendId, backends: snapshot.backends, cards,
    composer: Object.freeze({ busy: snapshot.busy, blockedReason: snapshot.composerBlockedReason ?? (backendReady ? null : 'Authenticate and select a supported Agent model before sending.'), canSend: snapshot.composerBlockedReason === null && snapshot.backendId !== null && backendReady, canCancel: snapshot.busy }),
    connection: snapshot.connection, taskAccounting: snapshot.taskAccounting, taskRuns: snapshot.taskRuns,
    ariaLive: cards.at(-1)?.body ?? (snapshot.connection === 'connected' ? 'Agent conversation ready.' : 'Agent conversation disconnected.'),
  });
}

export function presentConversationNode(node: ConversationNodeReadModel, now = Date.now()): ChatCardReadModel {
  const metadata = Object.freeze([
    Object.freeze({ label: 'Backend', value: node.provenance.backendId }),
    Object.freeze({ label: 'Turn', value: node.provenance.turnId }),
    ...(node.provenance.stepId ? [Object.freeze({ label: 'Step', value: node.provenance.stepId })] : []),
  ]);
  const base = { id: node.id, kind: node.kind, status: node.status, provenance: node.provenance, metadata } as const;
  if (!node.knownKind) return Object.freeze({ ...base, title: `Unsupported item · ${node.kind}`, body: stringValue(node.content.summary, 'Payload hidden for safety.'), tone: 'warning', actions: Object.freeze([]) });
  switch (node.knownKind) {
    case 'text': {
      const user = node.content.role === 'user';
      return card(base, user ? '你' : 'AI 说明', stringValue(node.content.text, ''), user ? 'neutral' : node.status === 'streaming' ? 'progress' : 'neutral');
    }
    case 'progress': return card(base, stringValue(node.content.label, 'Progress'), progressBody(node.content), 'progress');
    case 'tool-call': return card(base, `调用工具 · ${toolLabel(stringValue(node.content.toolId, 'unknown'))}`, stringValue(node.content.argumentsSummary, '正在准备结构化参数。'), 'warning');
    case 'tool-result': return toolResultCard(base, node);
    case 'diagnostic': return diagnosticCard(base, node);
    case 'completion': return completionCard(base, node);
    case 'question': return questionCard(base, node);
    case 'plan': return planCard(base, node);
    case 'approval': return approvalCard(base, node, now);
  }
}

export class ChatComposerKeyboardController {
  private composing = false;
  compositionStart(): void { this.composing = true; }
  compositionEnd(): void { this.composing = false; }
  handleKeyDown(event: Readonly<{ key: string; shiftKey?: boolean; isComposing?: boolean; preventDefault(): void }>): 'send' | 'none' {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || this.composing) return 'none';
    event.preventDefault();
    return 'send';
  }
}

export interface ChatFeedScrollPosition {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

export function chatFeedIsNearLatest(position: ChatFeedScrollPosition, threshold = 24): boolean {
  return position.scrollHeight - position.clientHeight - position.scrollTop <= threshold;
}

export function renderChatPanel(root: HTMLElement, model: ChatPanelReadModel, dispatch: (intent: ConversationIntent) => void): void {
  const document = root.ownerDocument;
  for (const image of [...(root.querySelectorAll?.('.chat-evidence-preview') ?? [])] as HTMLImageElement[]) image.removeAttribute('src');
  const previousFeed = root.querySelector?.('.chat-feed') as HTMLElement | null | undefined;
  const previousInput = root.querySelector?.('.chat-composer textarea') as HTMLTextAreaElement | null | undefined;
  const followLatest = !previousFeed || chatFeedIsNearLatest(previousFeed);
  const preservedScrollTop = previousFeed?.scrollTop ?? 0;
  const preservedDraft = previousInput?.value ?? '';
  const restoreInputFocus = previousInput !== undefined && previousInput !== null && document.activeElement === previousInput;
  const preservedSelection = restoreInputFocus
    ? Object.freeze({ start: previousInput.selectionStart, end: previousInput.selectionEnd, direction: previousInput.selectionDirection ?? undefined })
    : null;
  const fragment = document.createDocumentFragment();
  const backendControls = document.createElement('div');
  backendControls.className = 'chat-backend-controls';
  const backendSelect = document.createElement('select');
  backendSelect.setAttribute('aria-label', 'Agent backend');
  for (const backend of model.backends) {
    const option = document.createElement('option');
    option.value = backend.id;
    option.selected = backend.id === model.backendId;
    option.textContent = `${backend.label} · ${backend.state}${backend.accountPlan ? ` · ${backend.accountPlan}` : ''}`;
    backendSelect.append(option);
  }
  backendSelect.addEventListener('change', () => {
    const backend = model.backends.find((item) => item.id === backendSelect.value);
    if (backend) dispatch(Object.freeze({ type: 'backend/select', backendId: backend.id }));
  });
  backendControls.append(backendSelect);
  const selectedBackend = model.backends.find((item) => item.id === model.backendId);
  if (selectedBackend?.state === 'auth-required') {
    const authenticate = document.createElement('button');
    authenticate.type = 'button'; authenticate.textContent = selectedBackend.authMode === 'api-key' ? 'Configure API key securely' : 'Sign in with ChatGPT';
    authenticate.addEventListener('click', () => dispatch(Object.freeze({ type: 'backend/authenticate', backendId: selectedBackend.id })));
    backendControls.append(authenticate);
  } else if (selectedBackend?.state === 'ready') {
    const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = 'Sign out';
    logout.addEventListener('click', () => dispatch(Object.freeze({ type: 'backend/logout', backendId: selectedBackend.id })));
    backendControls.append(logout);
  }
  if (selectedBackend?.rateLimits.length) {
    const limits = document.createElement('span'); limits.className = 'chat-rate-limits';
    limits.textContent = selectedBackend.rateLimits.map((item) => `${item.name}${item.usedPercent === undefined ? '' : ` ${item.usedPercent}%`}${item.resetsAt ? ` resets ${item.resetsAt}` : ''}`).join(' · ');
    backendControls.append(limits);
  }
  if (selectedBackend) {
    const capabilities = document.createElement('details'); capabilities.className = 'chat-backend-capabilities';
    const summary = document.createElement('summary'); summary.textContent = `Backend capabilities · ${selectedBackend.protocolVersion}`;
    const value = document.createElement('p'); value.textContent = Object.entries(selectedBackend.capabilities).map(([name, supported]) => `${supported ? '✓' : '—'} ${name}`).join(' · ');
    capabilities.append(summary, value); backendControls.append(capabilities);
  }
  if (selectedBackend?.models.length && selectedBackend.selectedModel && selectedBackend.selectedReasoningEffort && selectedBackend.outputTokenLimit) {
    const selectedModelInfo = selectedBackend.models.find((item) => item.id === selectedBackend.selectedModel)!;
    const settings = document.createElement('details'); settings.className = 'chat-agent-settings';
    const summary = document.createElement('summary'); summary.textContent = 'Model, reasoning and task budget'; settings.append(summary);
    if (selectedBackend.promptProfile) {
      const profile = document.createElement('p'); profile.className = 'chat-prompt-profile'; profile.textContent = `Prompt profile ${selectedBackend.promptProfile.id}@${selectedBackend.promptProfile.version} · ${selectedBackend.promptProfile.digest}`; settings.append(profile);
    }
    const modelSelect = document.createElement('select'); modelSelect.setAttribute('aria-label', 'Agent model');
    for (const item of selectedBackend.models) { const option = document.createElement('option'); option.value = item.id; option.selected = item.id === selectedModelInfo.id; option.textContent = item.label; modelSelect.append(option); }
    const effortSelect = document.createElement('select'); effortSelect.setAttribute('aria-label', 'Reasoning effort');
    for (const effort of selectedModelInfo.reasoningEfforts) { const option = document.createElement('option'); option.value = effort; option.selected = effort === selectedBackend.selectedReasoningEffort; option.textContent = effort; effortSelect.append(option); }
    const outputLimit = numericInput(document, 'Output token limit', selectedBackend.outputTokenLimit, 1, selectedModelInfo.maxOutputTokens);
    const budget = modelBudget(model.taskAccounting?.budget);
    const enforcement = document.createElement('select'); enforcement.setAttribute('aria-label', 'Budget enforcement');
    for (const value of ['observe', 'soft', 'hard'] as const) { const option = document.createElement('option'); option.value = value; option.selected = value === budget.enforcement; option.textContent = value; enforcement.append(option); }
    const budgetInputs = Object.fromEntries(Object.entries(budget.limits).map(([key, value]) => [key, numericInput(document, budgetLabel(key), value ?? 0, key === 'repairIterations' ? 0 : 1, 1_000_000_000)])) as Record<keyof typeof budget.limits, HTMLInputElement>;
    const apply = (): void => {
      const selectedModel = selectedBackend.models.find((item) => item.id === modelSelect.value); if (!selectedModel) return;
      if (!selectedModel.reasoningEfforts.includes(effortSelect.value as typeof selectedModel.reasoningEfforts[number])) { effortSelect.value = selectedModel.defaultReasoningEffort; }
      const limits = Object.freeze(Object.fromEntries(Object.entries(budgetInputs).map(([key, input]) => [key, Math.max(Number(input.min), Math.floor(Number(input.value)))])) as unknown as typeof budget.limits);
      dispatch(Object.freeze({ type: 'agent/configure', backendId: selectedBackend.id, model: selectedModel.id, reasoningEffort: effortSelect.value as typeof selectedModel.reasoningEfforts[number], outputTokenLimit: Math.min(selectedModel.maxOutputTokens, Math.max(1, Math.floor(Number(outputLimit.value)))), budget: Object.freeze({ schemaVersion: 2, id: budget.id, enforcement: enforcement.value as typeof budget.enforcement, limits }) }));
    };
    modelSelect.addEventListener('change', () => { const next = selectedBackend.models.find((item) => item.id === modelSelect.value); if (next) { effortSelect.replaceChildren(...next.reasoningEfforts.map((effort) => { const option = document.createElement('option'); option.value = effort; option.textContent = effort; option.selected = effort === next.defaultReasoningEffort; return option; })); outputLimit.max = String(next.maxOutputTokens); outputLimit.value = String(Math.min(Number(outputLimit.value), next.maxOutputTokens)); } apply(); });
    for (const input of [effortSelect, outputLimit, enforcement, ...Object.values(budgetInputs)]) input.addEventListener('change', apply);
    settings.append(labelled(document, 'Model', modelSelect), labelled(document, 'Reasoning', effortSelect), labelled(document, 'Max output', outputLimit), labelled(document, 'Enforcement', enforcement));
    for (const [key, input] of Object.entries(budgetInputs)) settings.append(labelled(document, budgetLabel(key), input));
    backendControls.append(settings);
  }
  fragment.append(backendControls);
  if (model.taskRuns.length) fragment.append(renderTaskWorkspace(document, model.taskRuns, model.taskAccounting, dispatch));
  if (model.taskAccounting) fragment.append(renderTaskCostCard(document, model.taskAccounting));
  const status = document.createElement('p');
  status.className = 'chat-connection';
  status.textContent = `Connection: ${model.connection}`;
  fragment.append(status);
  const feed = document.createElement('ol');
  feed.className = 'chat-feed';
  feed.setAttribute('role', 'log');
  feed.setAttribute('aria-live', 'polite');
  for (const card of model.cards) feed.append(renderCard(document, card, dispatch));
  fragment.append(feed);
  const jumpLatest = document.createElement('button');
  jumpLatest.type = 'button';
  jumpLatest.className = 'chat-jump-latest';
  jumpLatest.textContent = '↓ Latest';
  jumpLatest.setAttribute('aria-label', 'Jump to latest agent message');
  fragment.append(jumpLatest);
  const live = document.createElement('span');
  live.className = 'visually-hidden';
  live.setAttribute('aria-live', 'polite');
  live.textContent = model.ariaLive;
  fragment.append(live);
  const composer = document.createElement('div');
  composer.className = 'chat-composer';
  const input = document.createElement('textarea');
  input.setAttribute('aria-label', 'Message the game authoring Agent');
  input.setAttribute('aria-describedby', 'chat-composer-status');
  input.value = preservedDraft;
  const send = document.createElement('button'); send.type = 'button'; send.textContent = 'Send'; send.disabled = !model.composer.canSend;
  const sendIntent = (): void => {
    const prompt = input.value.trim();
    if (!model.backendId || !model.composer.canSend || !prompt || new TextEncoder().encode(prompt).byteLength > 16 * 1024) return;
    appendOptimisticTurn(document, feed, prompt);
    input.value = '';
    send.disabled = true;
    feed.scrollTop = feed.scrollHeight;
    dispatch(Object.freeze({ type: 'conversation/send', backendId: model.backendId, prompt }));
  };
  const keyboard = new ChatComposerKeyboardController();
  input.addEventListener('compositionstart', () => keyboard.compositionStart());
  input.addEventListener('compositionend', () => keyboard.compositionEnd());
  input.addEventListener('keydown', (event) => { if (keyboard.handleKeyDown(event) === 'send') sendIntent(); });
  send.addEventListener('click', sendIntent);
  composer.append(input, send);
  if (model.composer.canCancel) {
    const active = [...model.cards].reverse().find((item) => item.status === 'pending' || item.status === 'streaming');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel turn'; cancel.disabled = !active || !model.backendId;
    cancel.addEventListener('click', () => { if (active && model.backendId) dispatch(Object.freeze({ type: 'conversation/cancel', backendId: model.backendId, sessionId: active.provenance.sessionId, turnId: active.provenance.turnId })); });
    composer.append(cancel);
  }
  if (model.connection !== 'connected') {
    const reconnect = document.createElement('button'); reconnect.type = 'button'; reconnect.textContent = 'Reconnect'; reconnect.addEventListener('click', () => dispatch(Object.freeze({ type: 'conversation/reconnect' }))); composer.append(reconnect);
  }
  const composerStatus = document.createElement('span'); composerStatus.id = 'chat-composer-status'; composerStatus.textContent = model.composer.blockedReason ?? 'Ready to send.'; composer.append(composerStatus);
  fragment.append(composer);
  root.replaceChildren(fragment);
  if (restoreInputFocus) {
    input.focus();
    if (preservedSelection) input.setSelectionRange(preservedSelection.start, preservedSelection.end, preservedSelection.direction);
  }
  const syncLatestButton = (): void => { jumpLatest.hidden = chatFeedIsNearLatest(feed); };
  if (followLatest) feed.scrollTop = feed.scrollHeight;
  else feed.scrollTop = Math.min(preservedScrollTop, Math.max(0, feed.scrollHeight - feed.clientHeight));
  feed.addEventListener('scroll', syncLatestButton, { passive: true });
  jumpLatest.addEventListener('click', () => { feed.scrollTop = feed.scrollHeight; syncLatestButton(); });
  syncLatestButton();
}

function renderTaskWorkspace(document: Document, runs: readonly ConversationTaskRunReadModel[], accounting: ConversationReadModel['taskAccounting'], dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const workspace = document.createElement('section'); workspace.className = 'chat-task-workspace'; workspace.setAttribute('aria-label', 'Agent task status and acceptance evidence');
  const heading = document.createElement('div'); heading.className = 'chat-task-heading';
  const title = document.createElement('strong'); title.textContent = '任务状态与验收证据';
  const selector = document.createElement('select'); selector.setAttribute('aria-label', 'Task history');
  const panels: HTMLElement[] = [];
  const ordered = [...runs].reverse();
  for (const [index, run] of ordered.entries()) {
    const option = document.createElement('option'); option.value = run.taskId; option.selected = index === 0; option.textContent = `${run.title} · ${run.status}`; selector.append(option);
    const panel = renderTaskRun(document, run, accounting?.taskId === run.taskId ? accounting : null, dispatch); panel.hidden = index !== 0; panels.push(panel);
  }
  selector.addEventListener('change', () => { for (const panel of panels) panel.hidden = panel.dataset.taskId !== selector.value; });
  heading.append(title, selector); workspace.append(heading, ...panels); return workspace;
}

function renderTaskRun(document: Document, run: ConversationTaskRunReadModel, accounting: ConversationReadModel['taskAccounting'], dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const panel = document.createElement('article'); panel.className = `chat-task-run task-status-${run.status}`; panel.dataset.taskId = run.taskId;
  const summary = document.createElement('div'); summary.className = 'chat-task-summary';
  const status = document.createElement('strong'); status.textContent = `${taskStatusLabel(run.status)} · ${taskPhaseLabel(run.phase)}`;
  const repair = document.createElement('span'); repair.textContent = `修复 ${run.repairIteration}/${run.repairLimit}`;
  summary.append(status, repair);
  const request = document.createElement('p'); request.textContent = run.requestSummary;
  const config = document.createElement('p'); config.className = 'chat-task-config'; config.textContent = `Model ${run.model.id} · reasoning ${run.model.reasoningEffort} · max output ${run.model.outputTokenLimit} · prompt ${run.promptProfile.id}@${run.promptProfile.version} · r${run.documentRevision ?? 'unknown'}`;
  panel.append(summary, request, config);
  if (run.terminalDiagnostic) { const diagnostic = document.createElement('p'); diagnostic.className = 'chat-task-diagnostic'; diagnostic.textContent = `原因：${run.terminalDiagnostic}`; panel.append(diagnostic); }
  if (run.resumable && run.sessionId && run.turnId) {
    const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = '从安全检查点继续';
    resume.addEventListener('click', () => { resume.disabled = true; dispatch(Object.freeze({ type: 'conversation/retry', backendId: run.backendId, sessionId: run.sessionId!, turnId: run.turnId! })); }); panel.append(resume);
  }
  panel.append(renderPhaseRail(document, run));
  const acceptance = document.createElement('details'); acceptance.className = 'chat-task-acceptance'; acceptance.open = run.status === 'completed' || run.status === 'blocked' || run.status === 'failed';
  const acceptanceSummary = document.createElement('summary'); const passed = run.acceptance.filter((item) => item.status === 'pass').length;
  acceptanceSummary.textContent = run.acceptance.length ? `验收标准 ${passed}/${run.acceptance.length} 通过` : '验收标准尚未提交'; acceptance.append(acceptanceSummary);
  if (run.acceptance.length) {
    const list = document.createElement('ul');
    for (const item of run.acceptance) {
      const row = document.createElement('li'); row.className = `acceptance-${item.status}`;
      const label = document.createElement('strong'); label.textContent = `${acceptanceMark(item.status)} ${item.label}`;
      const meta = document.createElement('span'); meta.textContent = `${item.category} · ${item.required ? '必需' : '可选'} · ${item.visibility === 'runner-only' ? '仅验收器可见' : 'Agent 可见'}`;
      const assertion = document.createElement('code'); assertion.textContent = item.assertion;
      row.append(label, meta, assertion);
      if (item.diagnostic) { const diagnostic = document.createElement('small'); diagnostic.textContent = item.diagnostic; row.append(diagnostic); }
      if (item.evidenceIds.length) { const refs = document.createElement('small'); refs.textContent = `Evidence: ${item.evidenceIds.join(', ')}`; row.append(refs); }
      list.append(row);
    }
    acceptance.append(list);
  }
  panel.append(acceptance);
  const evidence = document.createElement('details'); evidence.className = 'chat-task-evidence'; evidence.open = run.status === 'completed';
  const evidenceSummary = document.createElement('summary'); evidenceSummary.textContent = `证据 ${run.evidence.length}`; evidence.append(evidenceSummary);
  const evidenceGrid = document.createElement('div'); evidenceGrid.className = 'chat-evidence-grid';
  for (const item of run.evidence) {
    const card = document.createElement('article'); card.className = `chat-evidence-card evidence-${item.provenanceStatus}`;
    const label = document.createElement('strong'); label.textContent = `${item.type} · ${item.provenanceStatus}`;
    const coordinates = document.createElement('small'); coordinates.textContent = `${item.playId} · tick ${item.tick} / frame ${item.frame} · r${item.documentRevision} · ${item.device ?? 'device unknown'} · ${item.viewport ? `${item.viewport.width}×${item.viewport.height}` : 'viewport unknown'}`;
    const id = document.createElement('code'); id.textContent = item.id; card.append(label, coordinates, id);
    if (item.previewDataUrl) { const image = document.createElement('img'); image.className = 'chat-evidence-preview'; image.alt = `Screenshot evidence at tick ${item.tick}`; image.loading = 'lazy'; image.src = item.previewDataUrl; card.append(image); }
    evidenceGrid.append(card);
  }
  evidence.append(evidenceGrid); panel.append(evidence);
  const timeline = document.createElement('details'); timeline.className = 'chat-task-timeline';
  const timelineSummary = document.createElement('summary'); timelineSummary.textContent = `任务时间线 ${run.timeline.length}`; timeline.append(timelineSummary);
  const visible = run.timeline.slice(-100); if (visible.length < run.timeline.length) { const omitted = document.createElement('p'); omitted.textContent = `较早的 ${run.timeline.length - visible.length} 项已折叠，避免长任务占用过多界面资源。`; timeline.append(omitted); }
  const timelineList = document.createElement('ol');
  for (const item of visible) { const row = document.createElement('li'); row.className = `timeline-${item.status}`; const label = document.createElement('strong'); label.textContent = item.title; const detail = document.createElement('span'); detail.textContent = `${item.phase} · ${item.detail}${item.turnId ? ` · ${item.turnId}` : ''}${item.toolCallId ? ` · ${item.toolCallId}` : ''}${item.playId ? ` · ${item.playId}` : ''}${item.tick === null ? '' : ` · tick ${item.tick}`}`; row.append(label, detail); timelineList.append(row); }
  timeline.append(timelineList); panel.append(timeline);
  if (accounting) { const budget = document.createElement('p'); budget.className = 'chat-task-inline-accounting'; budget.textContent = `Budget ${accounting.budgetStatus} · wall ${(accounting.usage.wallTimeMs / 1_000).toFixed(1)}s · cost ${accounting.cost.amountMicros === null || !accounting.cost.currency ? `unknown (${accounting.cost.explanation})` : `${(accounting.cost.amountMicros / 1_000_000).toFixed(6)} ${accounting.cost.currency}`}`; panel.append(budget); }
  return panel;
}

function renderPhaseRail(document: Document, run: ConversationTaskRunReadModel): HTMLElement {
  const rail = document.createElement('ol'); rail.className = 'chat-task-phase-rail'; rail.setAttribute('aria-label', `Current task phase: ${run.phase}`);
  const phases: readonly ConversationTaskRunReadModel['phase'][] = ['planning', 'editing', 'validating', 'playing', 'evaluating', 'repairing', 'complete', 'blocked', 'cancelled'];
  const active = phases.indexOf(run.phase);
  for (const [index, phase] of phases.entries()) { const item = document.createElement('li'); item.textContent = taskPhaseLabel(phase); item.className = phase === run.phase ? 'is-current' : active >= 0 && index < active ? 'is-complete' : ''; if (phase === run.phase) item.setAttribute('aria-current', 'step'); rail.append(item); }
  return rail;
}

function taskStatusLabel(value: ConversationTaskRunReadModel['status']): string { return ({ running: '执行中', 'waiting-user': '等待用户', blocked: '已阻塞', completed: '已完成', failed: '失败', cancelled: '已取消' } as const)[value]; }
function taskPhaseLabel(value: ConversationTaskRunReadModel['phase']): string { return ({ planning: '规划', editing: '编辑', validating: '校验', playing: '运行', evaluating: '验收', repairing: '修复', complete: '完成', blocked: '阻塞', cancelled: '取消' } as const)[value]; }
function acceptanceMark(value: ConversationTaskRunReadModel['acceptance'][number]['status']): string { return ({ pending: '○', pass: '✓', fail: '✕', blocked: '!' } as const)[value]; }

function numericInput(document: Document, ariaLabel: string, value: number, minimum: number, maximum: number): HTMLInputElement { const input = document.createElement('input'); input.type = 'number'; input.setAttribute('aria-label', ariaLabel); input.min = String(minimum); input.max = String(maximum); input.step = '1'; input.value = String(value); return input; }
function labelled(document: Document, text: string, control: HTMLElement): HTMLElement { const label = document.createElement('label'); const span = document.createElement('span'); span.textContent = text; label.append(span, control); return label; }
function budgetLabel(key: string): string { return ({ inputTokens: 'Input tokens', outputTokens: 'Output tokens', estimatedCostMicros: 'Cost limit (µ currency)', wallTimeMs: 'Wall time (ms)', turns: 'Turns', toolCalls: 'Tool calls', repairIterations: 'Repair loops', observationBytes: 'Observation bytes' } as Record<string, string>)[key] ?? key; }
function modelBudget(value: TaskBudgetV2 | undefined): TaskBudgetV2 {
  return value ?? Object.freeze({ schemaVersion: 2 as const, id: 'budget:conversation-default', enforcement: 'hard' as const, limits: Object.freeze({ inputTokens: 200_000, outputTokens: 50_000, estimatedCostMicros: 2_000_000, wallTimeMs: 600_000, turns: 12, toolCalls: 100, repairIterations: 5, observationBytes: 5_000_000 }) });
}
function renderTaskCostCard(document: Document, value: NonNullable<ConversationReadModel['taskAccounting']>): HTMLElement {
  const card = document.createElement('section'); card.className = `chat-task-cost chat-task-cost-${value.budgetStatus}`; card.setAttribute('aria-label', 'Task usage and cost');
  const title = document.createElement('strong'); title.textContent = value.cost.final ? 'Task cost · final' : 'Task cost · current estimate';
  const cost = document.createElement('p'); cost.textContent = value.cost.amountMicros === null || !value.cost.currency ? `Cost unknown — ${value.cost.explanation}` : `${value.cost.status}: ${(value.cost.amountMicros / 1_000_000).toFixed(6)} ${value.cost.currency}`;
  const usage = document.createElement('p'); usage.textContent = `Input ${value.usage.inputTokens ?? 'unknown'} · cached ${value.usage.cachedInputTokens ?? 'unknown'} · output ${value.usage.outputTokens ?? 'unknown'} · reasoning ${value.usage.reasoningTokens ?? 'unknown'} · tools ${value.usage.toolInputBytes + value.usage.toolOutputBytes} B`;
  const contextCache = value.usage.contextCache ? document.createElement('p') : null;
  if (contextCache && value.usage.contextCache) contextCache.textContent = `Context cache: local ${value.usage.contextCache.localArtifactHits} hit / ${value.usage.contextCache.localArtifactMisses} miss · delta reused ${value.usage.contextCache.deltaReuseBytes} B · provider eligible ${value.usage.contextCache.providerCacheEligibleBytes} B · provider hit ${value.usage.contextCache.providerReportedHitTokens ?? 'unknown'}`;
  const budget = document.createElement('p'); budget.textContent = `Budget: ${value.budgetStatus} (${value.budget.enforcement})${value.cost.cacheSavingMicros === null ? '' : ` · cache saved ≈ ${(value.cost.cacheSavingMicros / 1_000_000).toFixed(6)} ${value.cost.currency}`}`;
  card.append(title, cost, usage); if (contextCache) card.append(contextCache); card.append(budget); return card;
}

function renderCard(document: Document, card: ChatCardReadModel, dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const item = document.createElement('li');
  item.className = `chat-card tone-${card.tone}`;
  item.dataset.kind = card.kind;
  item.dataset.status = card.status;
  const content = createChatCardSurface(document, item, card.status === 'pending' || card.status === 'streaming');
  const title = document.createElement('h3'); title.textContent = card.title; content.append(title);
  const body = document.createElement('p'); body.textContent = card.body; content.append(body);
  if (card.details) {
    const details = document.createElement('details'); details.className = 'chat-tool-details';
    const summary = document.createElement('summary'); summary.textContent = card.details.summary;
    const detailBody = document.createElement('pre'); detailBody.textContent = card.details.body;
    details.append(summary, detailBody); content.append(details);
  }
  if (card.approval) {
    const disclosure = document.createElement('dl');
    for (const [label, value] of [['Tool', `${card.approval.toolId}@${card.approval.toolVersion}`], ['Target', card.approval.target], ['Effect', card.approval.effect], ['Risk', card.approval.risk], ['Base revision', String(card.approval.baseRevision)], ['Scope', card.approval.scope], ['Expiry', card.approval.expiresAt ?? 'No wall-clock expiry; exact revision and digests still apply'], ['Arguments', card.approval.argumentsSummary], ['Preview', card.approval.previewDiff]]) {
      const term = document.createElement('dt'); term.textContent = label; const detail = document.createElement('dd'); detail.textContent = value; disclosure.append(term, detail);
    }
    content.append(disclosure);
  }
  if (card.planItems) {
    const list = document.createElement('ul'); list.className = 'chat-plan-items';
    const selections: HTMLInputElement[] = [];
    for (const plan of card.planItems) {
      const row = document.createElement('li');
      const label = document.createElement('label');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = plan.id;
      checkbox.checked = plan.status !== 'rejected'; checkbox.disabled = card.status !== 'pending'; selections.push(checkbox);
      const title = document.createElement('strong'); title.textContent = plan.label;
      label.append(checkbox, title); row.append(label);
      if (plan.details) { const details = document.createElement('p'); details.textContent = plan.details; row.append(details); }
      list.append(row);
    }
    if (card.status === 'pending') {
      const review = document.createElement('div'); review.className = 'chat-plan-review';
      const note = document.createElement('textarea'); note.placeholder = '可选：补充约束、修改意见或实现偏好'; note.setAttribute('aria-label', 'Plan feedback');
      const approve = document.createElement('button'); approve.type = 'button'; approve.textContent = '批准并执行';
      approve.addEventListener('click', () => {
        const acceptedItemIds = selections.filter((item) => item.checked).map((item) => item.value as StableId);
        if (!acceptedItemIds.length) return;
        approve.disabled = true; revise.disabled = true;
        dispatch(Object.freeze({ type: 'conversation/accept-plan', nodeId: card.id, acceptedItemIds: Object.freeze(acceptedItemIds), mode: 'approve', ...(note.value.trim() ? { note: note.value.trim() } : {}) }));
      });
      const revise = document.createElement('button'); revise.type = 'button'; revise.textContent = '补充后重新规划';
      revise.addEventListener('click', () => {
        const feedback = note.value.trim(); if (!feedback) { note.focus(); return; }
        approve.disabled = true; revise.disabled = true;
        dispatch(Object.freeze({ type: 'conversation/accept-plan', nodeId: card.id, acceptedItemIds: Object.freeze([]), mode: 'revise', note: feedback }));
      });
      review.append(note, approve, revise); content.append(review);
    }
    content.append(list);
  }
  const actions = document.createElement('div'); actions.className = 'chat-card-actions';
  for (const action of card.actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label; button.disabled = !action.enabled || !action.intent;
    button.addEventListener('click', () => { if (action.enabled && action.intent && !button.disabled) { button.disabled = true; dispatch(action.intent); } });
    actions.append(button);
  }
  if (card.actions.length) content.append(actions);
  return item;
}

function createChatCardSurface(document: Document, item: HTMLElement, waiting: boolean): HTMLElement {
  const content = document.createElement('div');
  content.className = 'chat-card-content';
  if (!waiting) { item.append(content); return content; }
  const beam = document.createElement('hy-border-beam');
  beam.className = 'chat-wait-beam';
  beam.setAttribute('thickness', '1.5');
  beam.setAttribute('speed', '1.35');
  beam.setAttribute('count', '2');
  beam.append(content);
  item.append(beam);
  return content;
}

function appendOptimisticTurn(document: Document, feed: HTMLElement, prompt: string): void {
  const append = (kind: 'user' | 'progress', title: string, body: string, waiting: boolean): void => {
    const item = document.createElement('li');
    item.className = `chat-card tone-${waiting ? 'progress' : 'neutral'} optimistic-card`;
    item.dataset.kind = kind === 'user' ? 'text' : 'progress';
    item.dataset.status = waiting ? 'pending' : 'completed';
    const content = createChatCardSurface(document, item, waiting);
    const heading = document.createElement('h3'); heading.textContent = title;
    const message = document.createElement('p'); message.textContent = body;
    content.append(heading, message);
    feed.append(item);
  };
  append('user', '你', prompt, false);
  append('progress', '正在分析需求', 'Agent 正在读取项目上下文并规划下一步。', true);
}

function questionCard(base: CardBase, node: ConversationNodeReadModel): ChatCardReadModel {
  const question = questionFromNode(node);
  const actions: ChatCardAction[] = [];
  if (question) for (const option of question.options) actions.push(Object.freeze({
    id: `answer:${option.id}`, label: option.label, enabled: node.status === 'pending',
    intent: Object.freeze({ type: 'conversation/answer-question', nodeId: node.id, answer: Object.freeze({ optionIds: Object.freeze([option.id]) }) as JsonObject }),
  }));
  return Object.freeze({ ...base, title: 'Question', body: question?.prompt ?? 'Invalid question payload.', tone: 'warning', actions: Object.freeze(actions), ...(question ? { question } : {}) });
}

function planCard(base: CardBase, node: ConversationNodeReadModel): ChatCardReadModel {
  const items = planFromNode(node);
  const fallback = `${items.length} 个实施步骤。确认后将自动执行低风险编辑；危险能力仍会单独请求授权。`;
  const title = stringValue(node.content.title, '总体实现方案');
  return Object.freeze({ ...base, title: node.status === 'pending' ? `待批准 · ${title}` : title, body: stringValue(node.content.summary, fallback), tone: node.status === 'pending' ? 'warning' : 'neutral', actions: Object.freeze([]), planItems: items });
}

function approvalCard(base: CardBase, node: ConversationNodeReadModel, now: number): ChatCardReadModel {
  const approval = approvalFromNode(node);
  const expired = Boolean(approval?.expiresAt && Date.parse(approval.expiresAt) <= now);
  const enabled = Boolean(approval && node.status === 'pending' && approval.decision === 'pending' && !expired);
  const actions: ChatCardAction[] = approval ? [
    Object.freeze({ id: 'approval-allow', label: 'Allow once', enabled, intent: Object.freeze({ type: 'conversation/resolve-approval', approvalId: approval.approvalId, decision: 'allow-once' }) }),
    ...(approval.effect === 'reversible-edit' ? [Object.freeze({ id: 'approval-allow-always', label: 'Allow always', enabled, intent: Object.freeze({ type: 'conversation/resolve-approval', approvalId: approval.approvalId, decision: 'allow-always' as const }) })] : []),
    Object.freeze({ id: 'approval-reject', label: 'Reject', enabled, intent: Object.freeze({ type: 'conversation/resolve-approval', approvalId: approval.approvalId, decision: 'reject' }) }),
  ] : [];
  const body = approval
    ? `${approval.effect} on ${approval.target}; decision: ${expired && approval.decision === 'pending' ? 'expired' : approval.decision}. ${approval.expiresAt ? `Expires at ${approval.expiresAt}.` : 'No wall-clock expiry; exact revision, arguments and preview still invalidate it.'} Scope: ${approval.scope}.${approval.effect === 'reversible-edit' ? ' Allow always is limited to this tool/version and target for the current project session.' : ' Trusted code and runtime start require exact one-shot approval.'}`
    : 'Invalid approval payload; actions are disabled.';
  return Object.freeze({ ...base, title: 'Approval required', body, tone: 'danger', actions: Object.freeze(actions), ...(approval ? { approval } : {}) });
}

function diagnosticCard(base: CardBase, node: ConversationNodeReadModel): ChatCardReadModel {
  const retryable = node.content.retryable === true;
  const actions: ChatCardAction[] = retryable ? [Object.freeze({ id: 'retry', label: 'Retry turn', enabled: true, intent: Object.freeze({ type: 'conversation/retry', backendId: node.provenance.backendId, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId }) })] : [];
  return Object.freeze({ ...base, title: `Diagnostic · ${stringValue(node.content.code, 'unknown')}`, body: stringValue(node.content.message, 'No safe diagnostic message.'), tone: node.content.severity === 'error' ? 'danger' : 'warning', actions: Object.freeze(actions) });
}

function completionCard(base: CardBase, node: ConversationNodeReadModel): ChatCardReadModel {
  const terminal = stringValue(node.content.terminalStatus, node.status);
  const retry = terminal === 'failed' || terminal === 'cancelled' || terminal === 'interrupted';
  const actions: ChatCardAction[] = retry ? [Object.freeze({ id: 'retry', label: 'Retry turn', enabled: true, intent: Object.freeze({ type: 'conversation/retry', backendId: node.provenance.backendId, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId }) })] : [];
  return Object.freeze({ ...base, title: `Turn ${terminal}`, body: stringValue(node.content.summary, 'Turn finished.'), tone: terminal === 'completed' ? 'success' : 'danger', actions: Object.freeze(actions) });
}

function toolResultCard(base: CardBase, node: ConversationNodeReadModel): ChatCardReadModel {
  const toolId = stringValue(node.content.toolId, 'unknown');
  const status = node.status === 'failed' ? '失败' : node.status === 'cancelled' ? '已取消' : '完成';
  const result = card(base, `${status} · ${toolLabel(toolId)}`, stringValue(node.content.summary, '工具调用已完成。'), node.status === 'failed' ? 'danger' : 'success');
  const details = stringValue(node.content.details, '');
  return details ? Object.freeze({ ...result, details: Object.freeze({ summary: '查看工具返回数据', body: details }) }) : result;
}

function toolLabel(toolId: string): string {
  return ({
    'project.snapshot': '读取项目', 'scene.list-entities': '读取场景', 'entity.get': '读取物体', 'script.get': '读取脚本',
    'diagnostics.query': '读取诊断', 'entity.create': '创建物体', 'entity.rename': '重命名物体', 'transform.set': '编辑 Transform', 'material.set': '设置材质',
    'studio.plan.propose': '提交实现方案', 'script.propose': '校验脚本提案', 'script.apply': '提交脚本', 'preview.validate': '校验运行计划', 'preview.start': '启动预览', 'preview.stop': '停止预览',
  } as Record<string, string>)[toolId] ?? toolId;
}

type CardBase = Readonly<Pick<ChatCardReadModel, 'id' | 'kind' | 'status' | 'provenance' | 'metadata'>>;
function card(base: CardBase, title: string, body: string, tone: ChatCardReadModel['tone']): ChatCardReadModel { return Object.freeze({ ...base, title: safeText(title, 240), body: safeText(body), tone, actions: Object.freeze([]) }); }
function stringValue(value: unknown, fallback: string): string { return typeof value === 'string' ? safeText(value) : fallback; }
function progressBody(content: JsonObject): string { const message = stringValue(content.message, 'Working…'); return typeof content.current === 'number' && typeof content.total === 'number' ? `${message} ${content.current}/${content.total}` : message; }
