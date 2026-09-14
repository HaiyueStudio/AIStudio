import { renderMarkdown } from '../markdown.js';
import type { JsonObject, StableId, TaskBudgetV2 } from '@haiyue/ai-studio-contracts';
import type { HYExpandable, HYExpandableChangeDetail } from '@haiyue/ui/expandable';
import type { HYTabs, HYTabChangeDetail } from '@haiyue/ui/tabs';
import { approvalFromNode, planFromNode, questionFromNode, safeText } from '../../conversation/validation.js';
import { layoutExecutionGraph } from '../../conversation/execution-layout.js';
import { compareExecutionGraphs, executionFailureReason, executionGraphIdentity, groupExecutionGraphsByTask } from '../../conversation/execution-graph.js';
import { attachGraphPan } from '../graph-pan.js';
import { createHoverPanel } from '../hover-panel.js';
import type {
  ChatCardAction,
  ChatCardReadModel,
  ConversationBackendReadModel,
  ConversationIntent,
  ConversationNodeReadModel,
  ConversationReadModel,
  ConversationTaskRunReadModel,
} from '../../conversation/types.js';
import type { ExecutionGraphNodeReadModel, ExecutionGraphReadModel, ExecutionGraphProductNodeStatus } from '../../conversation/execution-graph-types.js';

export interface ChatPanelReadModel {
  readonly backendId: StableId | null;
  readonly backends: readonly ConversationBackendReadModel[];
  readonly cards: readonly ChatCardReadModel[];
  readonly composer: Readonly<{ busy: boolean; blockedReason: string | null; canSend: boolean; canCancel: boolean }>;
  readonly connection: ConversationReadModel['connection'];
  readonly taskAccounting: ConversationReadModel['taskAccounting'];
  readonly taskRuns: ConversationReadModel['taskRuns'];
  readonly executionGraphs: ConversationReadModel['executionGraphs'];
  readonly ariaLive: string;
}

export function presentChatPanel(snapshot: ConversationReadModel, now = Date.now()): ChatPanelReadModel {
  const cards = Object.freeze(snapshot.nodes.map((node) => presentConversationNode(node, now)));
  const selected = snapshot.backends.find((backend) => backend.id === snapshot.backendId);
  const backendReady = selected?.state === 'ready' && selected.selectedModel !== null && selected.selectedReasoningEffort !== null && selected.outputTokenLimit !== null;
  return Object.freeze({
    backendId: snapshot.backendId, backends: snapshot.backends, cards,
    composer: Object.freeze({ busy: snapshot.busy, blockedReason: snapshot.composerBlockedReason ?? (backendReady ? null : backendBlockedReason(selected)), canSend: snapshot.composerBlockedReason === null && snapshot.backendId !== null && backendReady, canCancel: snapshot.busy }),
    connection: snapshot.connection, taskAccounting: snapshot.taskAccounting, taskRuns: snapshot.taskRuns, executionGraphs: groupExecutionGraphsByTask(snapshot.executionGraphs ?? [], snapshot.taskRuns),
    ariaLive: cards.at(-1)?.body ?? (snapshot.connection === 'connected' ? 'Agent conversation ready.' : 'Agent conversation disconnected.'),
  });
}

function backendBlockedReason(backend: ConversationBackendReadModel | undefined): string {
  if (!backend) return 'Select an Agent backend before sending.';
  if (backend.state === 'auth-required') return backend.authMode === 'api-key' ? 'Configure an API key before sending.' : 'Sign in with ChatGPT, then refresh connection.';
  if (backend.state === 'authenticating') return 'Complete sign-in, then refresh connection.';
  if (backend.state !== 'ready') return 'Agent connection is unavailable. Refresh connection to retry.';
  return 'No supported model is selected. Refresh connection to load models.';
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
  const openPanels = (chatHoverControllers.get(root) ?? []).flatMap(({ className, hover }) => { const state = hover.snapshot(); return state ? [{ className, state }] : []; });
  disposeChatPanel(root);
  currentChatModels.set(root, model);
  const document = root.ownerDocument;
  for (const image of [...(root.querySelectorAll?.('.chat-evidence-preview') ?? [])] as HTMLImageElement[]) image.removeAttribute('src');
  const previousFeed = root.querySelector?.('.chat-feed') as HTMLElement | null | undefined;
  const previousTabs = root.querySelector?.('.chat-view-tabs') as HYTabs | null | undefined;
  const restoreTabFocus = previousTabs != null && document.activeElement === previousTabs;
  const view = chatViewStates.get(root) ?? { choice: null, followLatest: true, feedScrollTop: 0, stepsScrollTop: 0 };
  if (previousFeed && previousTabs?.value === 'steps') {
    view.followLatest = chatFeedIsNearLatest(previousFeed); view.feedScrollTop = previousFeed.scrollTop;
    view.stepsScrollTop = (root.querySelector?.('.chat-steps-view') as HTMLElement | null)?.scrollTop ?? 0;
  }
  chatViewStates.set(root, view);
  const previousInput = root.querySelector?.('.chat-composer textarea') as HTMLTextAreaElement | null | undefined;
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
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh connection';
  refresh.addEventListener('click', () => dispatch(Object.freeze({ type: 'conversation/reconnect' })));
  backendControls.append(refresh);
  if (selectedBackend?.diagnostic) {
    const diagnostic = document.createElement('p'); diagnostic.className = 'chat-backend-diagnostic'; diagnostic.setAttribute('role', 'status');
    diagnostic.textContent = selectedBackend.state === 'ready' && selectedBackend.diagnostic.code === 'codex.rate-limits-unavailable'
      ? '额度信息暂时无法查询，登录状态已确认。可以尝试发送任务；“刷新连接”会重新查询额度。'
      : `${safeText(selectedBackend.diagnostic.code, 96)}: ${safeText(selectedBackend.diagnostic.message, 512)}`;
    backendControls.append(diagnostic);
  }
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
  if (!model.executionGraphs?.length && model.taskAccounting) {
    const usage = chatHoverPanel(root, document, 'execution-usage-popover', '上下文与任务用量');
    usage.panel.append(renderTaskCostCard(document, model.taskAccounting));
    backendControls.append(hoverButton(document, usage, '用量', '上下文与任务用量'), usage.panel);
  }
  fragment.append(backendControls);
  const pendingCards = model.cards.filter(card => card.status === 'pending'
    && (card.kind === 'plan' || card.kind === 'question' || (card.kind === 'approval' && card.actions.some(action => action.enabled))));
  const pendingIds = new Set(pendingCards.map(card => card.id));
  if (pendingCards.length) {
    const attention = document.createElement('section'); attention.className = 'chat-attention'; attention.setAttribute('aria-label', '等待你的确认');
    const heading = document.createElement('h2'); heading.textContent = `等待你的确认 · ${pendingCards.length}`;
    const list = document.createElement('ol'); list.className = 'chat-attention-list';
    for (const card of pendingCards) list.append(renderCard(document, card, dispatch));
    attention.append(heading, list); fragment.append(attention);
  }
  const workspace = document.createElement('div'); workspace.className = 'chat-workspace';
  const tabs = document.createElement('hy-tabs') as HYTabs; tabs.className = 'chat-view-tabs'; tabs.setAttribute('aria-label', '执行展示方式');
  const hasGraph = Boolean(model.executionGraphs?.length);
  tabs.options = [{ value: 'graph', label: '拓扑图', disabled: !hasGraph }, { value: 'steps', label: '执行步骤' }];
  tabs.value = hasGraph ? view.choice ?? 'graph' : 'steps';
  const graphPanel = document.createElement('section'); graphPanel.className = 'chat-graph-view'; graphPanel.slot = 'graph'; graphPanel.hidden = tabs.value !== 'graph';
  if (hasGraph) graphPanel.append(renderExecutionWorkspace(root, document, model.executionGraphs, model.taskAccounting, dispatch));
  const stepsPanel = document.createElement('section'); stepsPanel.className = 'chat-steps-view'; stepsPanel.slot = 'steps'; stepsPanel.hidden = tabs.value !== 'steps';
  if (model.taskRuns.length) stepsPanel.append(renderTaskWorkspace(document, model.taskRuns, model.taskAccounting, dispatch));
  const status = document.createElement('p');
  status.className = 'chat-connection';
  status.textContent = `Connection: ${model.connection}`;
  stepsPanel.append(status);
  const feed = document.createElement('ol');
  feed.className = 'chat-feed';
  feed.setAttribute('role', 'log');
  feed.setAttribute('aria-live', 'polite');
  for (const card of model.cards) if (!pendingIds.has(card.id)) feed.append(renderCard(document, card, dispatch));
  stepsPanel.append(feed);
  const jumpLatest = document.createElement('button');
  jumpLatest.type = 'button';
  jumpLatest.className = 'chat-jump-latest';
  jumpLatest.textContent = '↓ Latest';
  jumpLatest.setAttribute('aria-label', 'Jump to latest agent message');
  stepsPanel.append(jumpLatest);
  tabs.append(graphPanel, stepsPanel); workspace.append(tabs);
  fragment.append(workspace);
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
    view.followLatest = true;
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
  } else if (!model.composer.canSend) {
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Refresh connection';
    retry.addEventListener('click', () => dispatch(Object.freeze({ type: 'conversation/reconnect' }))); composer.append(retry);
  }
  const composerStatus = document.createElement('span'); composerStatus.id = 'chat-composer-status'; composerStatus.textContent = model.composer.blockedReason ?? 'Ready to send.'; composer.append(composerStatus);
  fragment.append(composer);
  root.replaceChildren(fragment);
  if (restoreInputFocus) {
    input.focus();
    if (preservedSelection) input.setSelectionRange(preservedSelection.start, preservedSelection.end, preservedSelection.direction);
  }
  const syncLatestButton = (): void => {
    if (chatViewActivators.get(root) !== showView || tabs.value !== 'steps' || stepsPanel.hidden) return;
    view.followLatest = chatFeedIsNearLatest(feed); view.feedScrollTop = feed.scrollTop;
    jumpLatest.hidden = view.followLatest;
  };
  const showView = (value: 'graph' | 'steps', chosen = true): void => {
    if (chatViewActivators.get(root) !== showView || (value === 'graph' && !hasGraph)) return;
    if (chosen) view.choice = value;
    tabs.value = value; graphPanel.hidden = value !== 'graph'; stepsPanel.hidden = value !== 'steps';
    for (const { hover } of chatHoverControllers.get(root) ?? []) hover.hide();
    if (value === 'graph') executionViewportUpdates.get(root)?.();
    else {
      stepsPanel.scrollTop = view.stepsScrollTop;
      feed.scrollTop = view.followLatest ? feed.scrollHeight : Math.min(view.feedScrollTop, Math.max(0, feed.scrollHeight - feed.clientHeight));
      syncLatestButton();
    }
  };
  chatViewActivators.set(root, showView);
  tabs.addEventListener('tab-change', event => {
    if (event.target !== tabs) return;
    const value = (event as CustomEvent<HYTabChangeDetail>).detail?.value;
    if (value === 'graph' || value === 'steps') showView(value);
  });
  stepsPanel.addEventListener('scroll', () => { if (chatViewActivators.get(root) === showView && tabs.value === 'steps') view.stepsScrollTop = stepsPanel.scrollTop; }, { passive: true });
  feed.addEventListener('scroll', syncLatestButton, { passive: true });
  jumpLatest.addEventListener('click', () => { feed.scrollTop = feed.scrollHeight; syncLatestButton(); });
  showView(tabs.value as 'graph' | 'steps', false);
  if (restoreTabFocus) tabs.shadowRoot?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  for (const { className, state } of openPanels) if (tabs.value === 'graph' || !hasGraph) chatHoverControllers.get(root)?.find(item => item.className === className)?.hover.restore(state);
}

interface ChatViewState { choice: 'graph' | 'steps' | null; followLatest: boolean; feedScrollTop: number; stepsScrollTop: number; }
const chatViewStates = new WeakMap<HTMLElement, ChatViewState>();
const chatViewActivators = new WeakMap<HTMLElement, (value: 'graph' | 'steps') => void>();

interface ExecutionWorkspaceState {
  /** Product task identity, falling back to a legacy session identity. */
  sessionId: string | null;
  followLatest: boolean;
  expanded: boolean;
  mode: 'graph' | 'transcript';
  selectedNodeId: string | null;
  query: string;
  filter: 'all' | 'current' | 'waiting' | 'failed' | 'changes' | 'validation' | 'compaction' | 'approval' | 'cost-unknown';
  detailMode: 'overview' | 'expanded';
  scale: number;
  fit: boolean;
  scrollLeft: number;
  scrollTop: number;
  revealSelection: boolean;
}

const executionWorkspaceStates = new WeakMap<HTMLElement, ExecutionWorkspaceState>();
/** Selects existing UI only; a notification never approves or resumes work. */
export function revealChatAttention(root: HTMLElement, target: Readonly<{ nodeId: string | null; taskId: string | null }>): boolean {
  let found = target.nodeId ? [...root.querySelectorAll<HTMLElement>('[data-conversation-node-id]')].find(item => item.dataset.conversationNodeId === target.nodeId) : undefined;
  if (!found && target.taskId) {
    found = [...root.querySelectorAll<HTMLElement>('.chat-task-run')].find(item => item.dataset.taskId === target.taskId);
    if (found) {
      const workspace = found.closest('.chat-task-workspace')!, selector = workspace.querySelector('select')!;
      selector.value = target.taskId;
      for (const panel of workspace.querySelectorAll<HTMLElement>('.chat-task-run')) panel.hidden = panel !== found;
    }
  }
  if (!found) return false;
  if (found.closest('.chat-steps-view')) chatViewActivators.get(root)?.('steps');
  found.tabIndex = -1; found.scrollIntoView({ block: 'center' }); found.focus({ preventScroll: true }); return true;
}
const executionViewportUpdates = new WeakMap<HTMLElement, () => void>();
const executionPanDisposers = new WeakMap<HTMLElement, () => void>();
const chatHoverControllers = new WeakMap<HTMLElement, { className: string; hover: ReturnType<typeof createHoverPanel> }[]>();

export function disposeChatPanel(root: HTMLElement): void {
  executionPanDisposers.get(root)?.(); executionPanDisposers.delete(root);
  for (const { hover } of chatHoverControllers.get(root) ?? []) hover.dispose();
  chatHoverControllers.delete(root); executionViewportUpdates.delete(root); currentChatModels.delete(root); chatViewActivators.delete(root);
}

function chatHoverPanel(root: HTMLElement, document: Document, className: string, label: string): ReturnType<typeof createHoverPanel> {
  const hover = createHoverPanel(document, className, label);
  const controllers = chatHoverControllers.get(root) ?? []; controllers.push({ className, hover }); chatHoverControllers.set(root, controllers);
  return hover;
}

function hoverButton(document: Document, hover: ReturnType<typeof createHoverPanel>, text: string, label: string): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'execution-info-button';
  button.textContent = text; button.setAttribute('aria-label', label); hover.bind(button); return button;
}

function renderExecutionWorkspace(root: HTMLElement, document: Document, graphs: readonly ExecutionGraphReadModel[], accounting: ConversationReadModel['taskAccounting'], dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const ordered = [...graphs].sort(compareExecutionGraphs);
  // A provider bootstrap may arrive before its first task-bound turn. Keep following the
  // known current task until that session can be attached, instead of flashing a lone goal.
  const latest = ordered.find(graph => graph.taskId === accounting?.taskId) ?? ordered.at(-1)!;
  const prior = executionWorkspaceStates.get(root);
  const state: ExecutionWorkspaceState = prior ?? { sessionId: executionGraphIdentity(latest), followLatest: true, expanded: false, mode: 'graph', selectedNodeId: null, query: '', filter: 'all', detailMode: 'overview', scale: 1, fit: true, scrollLeft: 0, scrollTop: 0, revealSelection: false };
  const selectedGraph = graphs.find((candidate) => executionGraphIdentity(candidate) === state.sessionId);
  if (!selectedGraph) state.followLatest = true;
  const graph = state.followLatest ? latest : selectedGraph!;
  if (state.sessionId !== executionGraphIdentity(graph)) { state.selectedNodeId = null; state.query = ''; state.filter = 'all'; state.fit = true; state.scrollLeft = 0; state.scrollTop = 0; }
  state.sessionId = executionGraphIdentity(graph);
  if (state.selectedNodeId && !graph.nodes.some((node) => node.id === state.selectedNodeId)) state.selectedNodeId = null;
  executionWorkspaceStates.set(root, state);
  const workspace = document.createElement('section'); workspace.className = 'execution-workspace'; workspace.setAttribute('aria-label', 'Agent execution graph and transcript'); workspace.dataset.sessionId = graph.sessionId; if (graph.taskId) workspace.dataset.taskId = graph.taskId;
  const header = document.createElement('header'); header.className = 'execution-header';
  const heading = document.createElement('div'); const title = document.createElement('strong'); title.textContent = graph.title; const status = document.createElement('span'); status.className = `execution-status status-${graph.status}`; status.textContent = executionStatusLabel(graph.status); heading.append(title, status);
  const sessionSelect = document.createElement('select'); sessionSelect.setAttribute('aria-label', 'Agent session');
  for (const [index, candidate] of ordered.entries()) { const option = document.createElement('option'); option.value = executionGraphIdentity(candidate); option.selected = executionGraphIdentity(candidate) === executionGraphIdentity(graph); option.textContent = `${candidate.taskId ? '任务' : '第'} ${index + 1}${candidate.taskId ? '' : ' 段'} · ${candidate.nodes.length} 个步骤 · ${candidate.title} · ${executionStatusLabel(candidate.status)}`; sessionSelect.append(option); }
  sessionSelect.addEventListener('change', () => { state.sessionId = sessionSelect.value; state.followLatest = false; state.selectedNodeId = null; state.query = ''; state.filter = 'all'; state.fit = true; state.scrollLeft = 0; state.scrollTop = 0; renderChatPanel(root, currentChatModel(root), dispatch); });
  const follow = document.createElement('button'); follow.type = 'button'; follow.textContent = state.followLatest ? '正在跟随最新' : '跟随最新'; follow.disabled = state.followLatest;
  follow.addEventListener('click', () => { state.followLatest = true; renderChatPanel(root, currentChatModel(root), dispatch); });
  const historyLabel = graph.taskId ? '任务历史' : '会话历史';
  const history = chatHoverPanel(root, document, 'execution-history-popover', historyLabel);
  history.panel.append(labelled(document, historyLabel, sessionSelect), follow);
  const usage = chatHoverPanel(root, document, 'execution-usage-popover', '上下文与任务用量');
  const actions = document.createElement('div'); actions.className = 'execution-header-actions';
  actions.append(hoverButton(document, history, '历史', historyLabel), hoverButton(document, usage, '用量', '上下文与任务用量'));
  header.append(heading, actions); workspace.append(header, history.panel, usage.panel);

  const summary = document.createElement('div'); summary.className = 'execution-summary';
  const pressure = document.createElement('div'); pressure.className = `execution-pressure pressure-${graph.context.pressure?.state ?? 'unknown'}`;
  const pressureLabel = document.createElement('span'); const ratio = graph.context.pressure?.ratio; pressureLabel.textContent = `所选会话上下文 ${ratio === null || ratio === undefined ? '未知' : `${Math.round(ratio * 100)}%`} · ${contextStateLabel(graph.context.pressure?.state ?? 'unknown')}`;
  const meter = document.createElement('progress'); meter.max = 100; meter.hidden = ratio === null || ratio === undefined; meter.value = ratio === null || ratio === undefined ? 0 : Math.round(ratio * 100); meter.setAttribute('aria-label', pressureLabel.textContent);
  const compact = document.createElement('button'); compact.type = 'button'; compact.textContent = '压缩上下文'; compact.disabled = !graph.context.compactionAvailable; compact.title = graph.context.compactionBlockedReason ?? (graph.context.pressure ? '在下一个安全边界压缩模型可见上下文；完整记录不会删除。' : '当前模型尚未提供可验证的上下文容量。'); compact.addEventListener('click', () => { if (compact.disabled) return; compact.disabled = true; dispatch(Object.freeze({ type: 'conversation/request-compaction', sessionId: graph.sessionId as StableId, requestId: `compaction-request:${graph.sessionId}:${graph.revision}` as StableId })); });
  pressure.append(pressureLabel, meter, compact);
  if (graph.context.pressure) {
    const capacity = document.createElement('small'); const measured = graph.context.pressure;
    capacity.textContent = `输入 ${measured.usedInputTokens ?? '未知'} / ${measured.maxInputTokens ?? '未知'} tokens · 预留输出 ${measured.reservedOutputTokens} · 安全预留 ${measured.reservedSafetyTokens}`;
    pressure.append(capacity);
  }
  summary.append(pressure); usage.panel.append(summary);
  if (accounting) usage.panel.append(renderTaskCostCard(document, accounting));
  else { const totals = document.createElement('p'); totals.className = 'execution-totals'; totals.textContent = executionAccountingLabel(graph, null); usage.panel.append(totals); }

  const controls = document.createElement('div'); controls.className = 'execution-controls';
  const transcriptToggle = document.createElement('button'); transcriptToggle.type = 'button';
  transcriptToggle.textContent = state.mode === 'graph' ? `完整记录 ${graph.transcript.length}` : '返回拓扑图';
  transcriptToggle.addEventListener('click', () => { state.mode = state.mode === 'graph' ? 'transcript' : 'graph'; renderChatPanel(root, currentChatModel(root), dispatch); });
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索步骤、工具、实体或错误'; search.setAttribute('aria-label', 'Search execution graph'); search.value = state.query;
  search.addEventListener('change', () => { state.query = search.value; state.fit = true; renderChatPanel(root, currentChatModel(root), dispatch); });
  const filter = document.createElement('select'); filter.setAttribute('aria-label', 'Filter execution graph');
  for (const [value, label] of [['all','全部'],['current','当前'],['waiting','等待'],['failed','失败'],['changes','修改'],['validation','验证'],['compaction','压缩'],['approval','审批'],['cost-unknown','成本未知']] as const) { const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = state.filter === value; filter.append(option); }
  filter.addEventListener('change', () => { state.filter = filter.value as ExecutionWorkspaceState['filter']; state.fit = true; renderChatPanel(root, currentChatModel(root), dispatch); });
  controls.append(transcriptToggle, search, filter); workspace.append(controls);

  if (state.mode === 'transcript') workspace.append(renderExecutionTranscript(root, document, graph, state, dispatch));
  else workspace.append(renderExecutionGraph(root, document, graph, state, dispatch));
  return workspace;
}

/* The current model is retained only for same-render interaction callbacks. */
const currentChatModels = new WeakMap<HTMLElement, ChatPanelReadModel>();
function currentChatModel(root: HTMLElement): ChatPanelReadModel { const value = currentChatModels.get(root); if (!value) throw new Error('Chat panel model is unavailable.'); return value; }

function renderExecutionGraph(root: HTMLElement, document: Document, graph: ExecutionGraphReadModel, state: ExecutionWorkspaceState, dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const container = document.createElement('hy-expandable') as HYExpandable; container.className = 'execution-graph-expandable';
  container.setAttribute('expanded-width', '96vw'); container.setAttribute('expanded-height', '94dvh');
  container.setAttribute('expand-label', '放大执行拓扑图'); container.setAttribute('restore-label', '还原执行拓扑图');
  container.toggleAttribute('expanded', state.expanded);
  container.addEventListener('expanded-change', event => {
    if (event.target !== container) return;
    state.expanded = (event as CustomEvent<HYExpandableChangeDetail>).detail.expanded;
    executionViewportUpdates.get(root)?.();
  });
  const region = document.createElement('div'); region.className = 'execution-graph-region'; container.append(region);
  const toolbar = document.createElement('div'); toolbar.className = 'execution-graph-toolbar';
  const detail = document.createElement('button'); detail.type = 'button'; detail.textContent = state.detailMode === 'overview' ? '展开全部' : '折叠已完成读取'; detail.addEventListener('click', () => { state.detailMode = state.detailMode === 'overview' ? 'expanded' : 'overview'; state.fit = true; renderChatPanel(root, currentChatModel(root), dispatch); });
  const zoomOut = document.createElement('button'); zoomOut.type = 'button'; zoomOut.textContent = '−'; zoomOut.setAttribute('aria-label', 'Zoom out execution graph'); zoomOut.addEventListener('click', () => { state.fit = false; state.scale = Math.max(0.01, state.scale / 1.25); renderChatPanel(root, currentChatModel(root), dispatch); });
  const zoomIn = document.createElement('button'); zoomIn.type = 'button'; zoomIn.textContent = '+'; zoomIn.setAttribute('aria-label', 'Zoom in execution graph'); zoomIn.addEventListener('click', () => { state.fit = false; state.scale = Math.min(1.8, state.scale * 1.25); renderChatPanel(root, currentChatModel(root), dispatch); });
  const fit = document.createElement('button'); fit.type = 'button'; fit.textContent = '适应视图'; fit.addEventListener('click', () => { state.fit = true; state.scrollLeft = 0; state.scrollTop = 0; renderChatPanel(root, currentChatModel(root), dispatch); });
  toolbar.append(detail, zoomOut, zoomIn, fit); region.append(toolbar);
  const activity = document.createElement('div'); activity.className = 'execution-current-activity'; activity.setAttribute('role', 'status');
  const current = graph.nodes.filter(node => graph.currentNodeIds.includes(node.id));
  if (current.length) {
    for (const node of current) {
      const locate = document.createElement('button'); locate.type = 'button'; locate.textContent = `${executionStatusLabel(node.status)}：${node.title}`;
      locate.addEventListener('click', () => { state.query = ''; state.filter = 'current'; selectExecutionNode(state, node.id); renderChatPanel(root, currentChatModel(root), dispatch); });
      activity.append(locate);
    }
  } else activity.textContent = `当前任务：${executionStatusLabel(graph.status)}`;
  toolbar.append(activity);
  const options = graphFilterOptions(state);
  const layout = layoutExecutionGraph(graph, { mode: state.detailMode, query: state.query, ...options });
  const count = document.createElement('span'); count.className = 'execution-node-count'; count.textContent = `显示 ${layout.visibleNodeIds.length}/${graph.nodes.length} 个步骤`; toolbar.append(count);
  const visible = new Set(layout.visibleNodeIds); const nodes = new Map(graph.nodes.map((node) => [node.id, node])); const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  const viewport = document.createElement('div'); viewport.className = 'execution-graph-viewport'; viewport.tabIndex = 0; viewport.setAttribute('aria-label', `${layout.visibleNodeIds.length} visible execution nodes. Use Tab or arrow keys to navigate.`);
  viewport.title = '滚轮缩放；按住左键或中键拖动；悬停节点查看详情，单击固定详情。';
  const nodeHover = chatHoverPanel(root, document, 'execution-detail-popover', '步骤详情');
  const panDispose = attachGraphPan(viewport, () => { nodeHover.hide(); state.fit = false; state.scrollLeft = viewport.scrollLeft; state.scrollTop = viewport.scrollTop; });
  const lifetime = new AbortController();
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => executionViewportUpdates.get(root)?.());
  resizeObserver?.observe(viewport);
  executionPanDisposers.set(root, () => { lifetime.abort(); panDispose(); resizeObserver?.disconnect(); });
  const stage = document.createElement('div'); stage.className = 'execution-graph-stage';
  const canvas = document.createElement('div'); canvas.className = 'execution-graph-canvas'; canvas.style.width = `${layout.width}px`; canvas.style.height = `${layout.height}px`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'execution-edges'); svg.setAttribute('width', String(layout.width)); svg.setAttribute('height', String(layout.height)); svg.setAttribute('aria-hidden', 'true');
  for (const edge of graph.edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
    const from = positions.get(edge.from)!; const to = positions.get(edge.to)!;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); const x1 = from.x + from.width; const y1 = from.y + from.height / 2; const x2 = to.x; const y2 = to.y + to.height / 2; const middle = (x1 + x2) / 2;
    line.setAttribute('d', `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`); line.setAttribute('class', `edge-${edge.kind}`); svg.append(line);
  }
  canvas.append(svg);
  for (const position of layout.nodes) {
    const node = nodes.get(position.id)!; const button = document.createElement('button'); button.type = 'button'; button.id = executionDomId(node.id); button.className = `execution-node kind-${node.kind} status-${node.status}${graph.criticalPathNodeIds.includes(node.id) ? ' is-critical' : ''}${state.selectedNodeId === node.id ? ' is-selected' : ''}`; button.style.left = `${position.x}px`; button.style.top = `${position.y}px`; button.style.width = `${position.width}px`; button.style.height = `${position.height}px`; button.dataset.nodeId = node.id; button.dataset.layer = String(position.layer); button.dataset.order = String(position.order); button.tabIndex = state.selectedNodeId === node.id || (!state.selectedNodeId && node.id === (graph.currentNodeIds[0] ?? layout.visibleNodeIds[0])) ? 0 : -1; button.setAttribute('aria-label', `${node.title}. ${executionStatusLabel(node.status)}. ${node.summary}`);
    const kind = document.createElement('span'); kind.className = 'execution-node-kind'; kind.textContent = `${executionKindLabel(node.kind)} · ${executionStatusLabel(node.status)}`; const label = document.createElement('strong'); label.textContent = node.title; const summary = document.createElement('span'); summary.className = 'execution-node-summary'; summary.textContent = node.summary; button.append(kind, label, summary);
    if (graph.currentNodeIds.includes(node.id) && (node.status === 'running' || node.status === 'waiting')) {
      const beam = document.createElement('hy-border-beam'); beam.className = 'execution-node-beam'; beam.setAttribute('aria-hidden', 'true');
      beam.setAttribute('thickness', '1.5'); beam.setAttribute('speed', '1.35'); beam.setAttribute('count', '2'); button.append(beam);
    }
    nodeHover.bind(button, () => { nodeHover.panel.replaceChildren(renderExecutionNodeDetail(root, document, graph, node, state, dispatch)); });
    button.addEventListener('click', () => {
      state.selectedNodeId = node.id;
      for (const item of canvas.querySelectorAll<HTMLButtonElement>('.execution-node')) { item.classList.toggle('is-selected', item === button); item.tabIndex = item === button ? 0 : -1; }
    });
    button.addEventListener('keydown', (event) => navigateGraphNode(event, root, graph, layout.nodes, node.id, state, dispatch));
    canvas.append(button);
  }
  stage.append(canvas);
  viewport.append(stage); region.append(viewport);
  viewport.addEventListener('scroll', () => { if (viewport.clientWidth > 0 && viewport.clientHeight > 0) { state.scrollLeft = viewport.scrollLeft; state.scrollTop = viewport.scrollTop; } }, { passive: true });
  // Measure after the panel is attached; scale edges, text and hit targets together.
  executionViewportUpdates.set(root, () => {
    if (!(viewport.clientWidth > 0 && viewport.clientHeight > 0)) return;
    if (state.fit) state.scale = Math.min(1, Math.max(1, viewport.clientWidth - 8) / layout.width, Math.max(1, viewport.clientHeight - 8) / layout.height);
    stage.style.width = `${layout.width * state.scale}px`; stage.style.height = `${layout.height * state.scale}px`;
    canvas.style.transform = `scale(${state.scale})`;
    const selectedPosition = state.revealSelection && state.selectedNodeId ? positions.get(state.selectedNodeId) : null;
    if (selectedPosition) { state.scrollLeft = (selectedPosition.x + selectedPosition.width / 2) * state.scale - viewport.clientWidth / 2; state.scrollTop = (selectedPosition.y + selectedPosition.height / 2) * state.scale - viewport.clientHeight / 2; }
    viewport.scrollLeft = state.fit ? 0 : state.scrollLeft; viewport.scrollTop = state.fit ? 0 : state.scrollTop;
    state.revealSelection = false;
  });
  viewport.addEventListener('wheel', event => {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault(); nodeHover.hide();
    const bounds = viewport.getBoundingClientRect();
    const x = Math.max(0, Math.min(viewport.clientWidth, event.clientX - bounds.left - viewport.clientLeft));
    const y = Math.max(0, Math.min(viewport.clientHeight, event.clientY - bounds.top - viewport.clientTop));
    const anchorX = (viewport.scrollLeft + x) / state.scale; const anchorY = (viewport.scrollTop + y) / state.scale;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
    state.fit = false; state.scale = Math.min(1.8, Math.max(Math.min(0.01, state.scale), state.scale * Math.exp(-Math.max(-400, Math.min(400, delta)) * 0.002)));
    state.scrollLeft = anchorX * state.scale - x; state.scrollTop = anchorY * state.scale - y;
    executionViewportUpdates.get(root)?.(); state.scrollLeft = viewport.scrollLeft; state.scrollTop = viewport.scrollTop;
  }, { passive: false, signal: lifetime.signal });
  region.append(nodeHover.panel);
  region.append(renderAccessibleGraphList(root, document, graph, state, dispatch));
  return container;
}

function renderExecutionTranscript(root: HTMLElement, document: Document, graph: ExecutionGraphReadModel, state: ExecutionWorkspaceState, dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const region = document.createElement('section'); region.className = 'execution-transcript'; region.setAttribute('aria-label', 'Complete human transcript');
  const list = document.createElement('ol');
  const query = state.query.trim().toLocaleLowerCase();
  for (const item of graph.transcript) {
    if (query && !`${item.title}\n${item.body}`.toLocaleLowerCase().includes(query)) continue;
    const row = document.createElement('li'); row.className = `transcript-item transcript-${item.kind} status-${item.status}`; row.id = `transcript-${executionDomId(item.id)}`;
    const header = document.createElement('div'); const title = document.createElement('strong'); title.textContent = item.title; const time = document.createElement('time'); time.dateTime = item.timestamp; time.textContent = new Date(item.timestamp).toLocaleTimeString(); header.append(title, time);
    const body = renderMarkdown(document, item.body); row.append(header, body);
    if (item.graphNodeIds.length) { const locate = document.createElement('button'); locate.type = 'button'; locate.textContent = '在拓扑中定位'; locate.addEventListener('click', () => { selectExecutionNode(state, item.graphNodeIds[0]!); renderChatPanel(root, currentChatModel(root), dispatch); }); row.append(locate); }
    list.append(row);
  }
  region.append(list); return region;
}

function renderExecutionNodeDetail(root: HTMLElement, document: Document, graph: ExecutionGraphReadModel, node: ExecutionGraphNodeReadModel, state: ExecutionWorkspaceState, dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const aside = document.createElement('aside'); aside.className = 'execution-node-detail'; aside.setAttribute('aria-label', `Execution detail: ${node.title}`);
  const heading = document.createElement('h3'); heading.textContent = node.title; const summary = renderMarkdown(document, node.summary); aside.append(heading, summary);
  const facts = document.createElement('dl');
  for (const [label, value] of [['状态', executionStatusLabel(node.status)], ['类型', executionKindLabel(node.kind)], ['耗时', node.durationMs === null ? null : `${node.durationMs} ms`], ['项目修订', node.projectRevisionBefore === null && node.projectRevisionAfter === null ? null : `r${node.projectRevisionBefore ?? '?'} → r${node.projectRevisionAfter ?? '?'}`], ['工具', node.detail.toolId ? `${node.detail.toolId}${node.detail.toolVersion ? `@${node.detail.toolVersion}` : ''}` : null], ['执行类别', node.detail.executionClass], ['事务', node.detail.transactionId], ['诊断', node.detail.diagnostic]] as const) {
    if (!value || value === 'unknown' || value === 'none') continue;
    const term = document.createElement('dt'); term.textContent = label; const description = document.createElement('dd'); description.textContent = value; facts.append(term, description);
  }
  for (const [label, value] of [['模型说明（公开输出）', node.kind === 'model' ? node.detail.modelExplanation || '本轮未记录公开的思考摘要或说明。' : null], ['执行内容', node.detail.actionSummary], ['执行结果', node.detail.resultSummary]] as const) {
    if (!value) continue;
    const section = document.createElement('section'); const title = document.createElement('strong'); title.textContent = label;
    const body = renderMarkdown(document, safeText(value, 2048)); section.className = 'execution-detail-section'; section.append(title, body); aside.append(section);
  }
  if (node.status === 'failed' || node.status === 'cancelled' || node.status === 'outcome-unknown' || (node.status === 'waiting' && node.detail.reason)) {
    const term = document.createElement('dt'); term.textContent = node.status === 'waiting' ? '等待原因' : node.status === 'cancelled' ? '取消原因' : node.status === 'outcome-unknown' ? '待核验原因' : '失败原因';
    const reason = document.createElement('dd'); reason.className = 'execution-node-reason';
    reason.textContent = safeText(node.detail.reason ?? node.detail.diagnostic ?? '该记录未保存具体原因，请查看对应记录或日志。', 2048);
    facts.prepend(term, reason);
  }
  aside.append(facts);
  if (node.artifactRefs.length) { const artifacts = document.createElement('details'); const label = document.createElement('summary'); label.textContent = `证据与产物 ${node.artifactRefs.length}`; const list = document.createElement('ul'); for (const id of node.artifactRefs) { const item = document.createElement('li'); const code = document.createElement('code'); code.textContent = id; item.append(code); list.append(item); } artifacts.append(label, list); aside.append(artifacts); }
  if (node.detail.usageRecordIds.length || node.detail.costRecordIds.length) { const accounting = document.createElement('p'); accounting.className = 'execution-node-accounting'; accounting.textContent = `Usage ${node.detail.usageRecordIds.join(', ') || 'unknown'} · Cost ${node.detail.costRecordIds.join(', ') || 'unknown'}`; aside.append(accounting); }
  const transcriptItems = graph.transcript.filter((item) => item.graphNodeIds.includes(node.id));
  if (transcriptItems.length) { const locate = document.createElement('button'); locate.type = 'button'; locate.textContent = '查看对应记录'; locate.addEventListener('click', () => { state.mode = 'transcript'; renderChatPanel(root, currentChatModel(root), dispatch); }); aside.append(locate); }
  return aside;
}

function renderAccessibleGraphList(root: HTMLElement, document: Document, graph: ExecutionGraphReadModel, state: ExecutionWorkspaceState, dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const details = document.createElement('details'); details.className = 'execution-accessible-list'; const summary = document.createElement('summary'); summary.textContent = '使用层级列表浏览全部执行步骤'; const list = document.createElement('ol');
  for (const node of graph.nodes) { const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button'; button.textContent = `${executionKindLabel(node.kind)} · ${node.title} · ${executionStatusLabel(node.status)}`; button.addEventListener('click', () => { selectExecutionNode(state, node.id); renderChatPanel(root, currentChatModel(root), dispatch); }); item.append(button); list.append(item); }
  details.append(summary, list); return details;
}

function navigateGraphNode(event: KeyboardEvent, root: HTMLElement, graph: ExecutionGraphReadModel, layout: readonly Readonly<{ id: string; layer: number; order: number }>[], nodeId: string, state: ExecutionWorkspaceState, dispatch: (intent: ConversationIntent) => void): void {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key)) return;
  event.preventDefault(); const current = layout.find((node) => node.id === nodeId); if (!current) return;
  let candidate = event.key === 'Home' ? layout.find((node) => graph.currentNodeIds.includes(node.id)) ?? layout[0] : undefined;
  if (!candidate && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) candidate = layout.filter((node) => node.layer === current.layer).sort((left, right) => Math.abs(left.order - (current.order + (event.key === 'ArrowUp' ? -1 : 1))) - Math.abs(right.order - (current.order + (event.key === 'ArrowUp' ? -1 : 1))))[0];
  if (!candidate) { const targetLayer = current.layer + (event.key === 'ArrowLeft' ? -1 : 1); candidate = layout.filter((node) => node.layer === targetLayer).sort((left, right) => Math.abs(left.order - current.order) - Math.abs(right.order - current.order))[0]; }
  if (candidate) { selectExecutionNode(state, candidate.id); renderChatPanel(root, currentChatModel(root), dispatch); root.querySelector<HTMLElement>(`#${executionDomId(candidate.id)}`)?.focus({ preventScroll: true }); }
}

function selectExecutionNode(state: ExecutionWorkspaceState, id: string): void {
  state.selectedNodeId = id; state.mode = 'graph'; state.query = ''; state.filter = 'all'; state.detailMode = 'expanded'; state.fit = false; state.scale = Math.max(0.75, state.scale); state.revealSelection = true;
}

function graphFilterOptions(state: ExecutionWorkspaceState): Readonly<{ statuses?: readonly ExecutionGraphProductNodeStatus[]; kinds?: readonly ExecutionGraphNodeReadModel['kind'][]; costUnknown?: boolean }> {
  if (state.filter === 'current') return { statuses: ['running','waiting','outcome-unknown'] };
  if (state.filter === 'waiting') return { statuses: ['waiting','outcome-unknown'] };
  if (state.filter === 'failed') return { statuses: ['failed'] };
  if (state.filter === 'changes') return { kinds: ['transaction','tool'] };
  if (state.filter === 'validation') return { kinds: ['evidence','evaluation'] };
  if (state.filter === 'compaction') return { kinds: ['compaction'] };
  if (state.filter === 'approval') return { kinds: ['approval','question','plan'] };
  if (state.filter === 'cost-unknown') return { costUnknown: true };
  return {};
}

function executionDomId(id: string): string { return `execution-${id.replace(/[^a-zA-Z0-9_-]/gu, '-')}`; }
function executionStatusLabel(value: ExecutionGraphNodeReadModel['status']): string { return ({ pending:'待处理', running:'执行中', waiting:'待确认', completed:'已完成', failed:'失败', cancelled:'已取消', 'outcome-unknown':'结果待核验' } as const)[value]; }
function executionKindLabel(value: ExecutionGraphNodeReadModel['kind']): string { return ({ goal:'目标', plan:'方案', turn:'执行阶段', model:'模型', 'tool-batch':'工具批次', tool:'工具', transaction:'修改', approval:'审批', question:'问题', compaction:'上下文压缩', evidence:'证据', evaluation:'验证', repair:'修复', result:'结果', unknown:'未知步骤' } as const)[value]; }
function contextStateLabel(value: string): string { return ({ normal:'正常', warning:'接近上限', preparing:'准备压缩', 'compact-required':'需要压缩', emergency:'紧急', unknown:'容量未知' } as Record<string,string>)[value] ?? value; }
function executionAccountingLabel(graph: ExecutionGraphReadModel, accounting: ConversationReadModel['taskAccounting']): string { const usageRefs = new Set(graph.nodes.flatMap((node) => node.detail.usageRecordIds)); const costRefs = new Set(graph.nodes.flatMap((node) => node.detail.costRecordIds)); if (!accounting) return `Usage ${usageRefs.size || 'unknown'} records · Cost ${costRefs.size || 'unknown'} records`; const cost = accounting.cost.amountMicros === null || !accounting.cost.currency ? `unknown (${accounting.cost.explanation})` : `${(accounting.cost.amountMicros / 1_000_000).toFixed(6)} ${accounting.cost.currency}`; return `Input ${accounting.usage.inputTokens ?? 'unknown'} · Cached ${accounting.usage.cachedInputTokens ?? 'unknown'} · Output ${accounting.usage.outputTokens ?? 'unknown'} · Cost ${cost}`; }

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
  const panel = document.createElement('article'); panel.className = `chat-task-run task-status-${run.status === 'blocked' && run.terminalDiagnostic === 'task.acceptance-evidence-incomplete' ? 'awaiting-acceptance' : run.status}`; panel.dataset.taskId = run.taskId;
  const summary = document.createElement('div'); summary.className = 'chat-task-summary';
  const status = document.createElement('strong'); status.textContent = run.status === 'blocked' && run.terminalDiagnostic === 'task.acceptance-evidence-incomplete' ? '待继续验收' : `${taskStatusLabel(run.status)} · ${taskPhaseLabel(run.phase)}`;
  const repair = document.createElement('span'); repair.textContent = `修复 ${run.repairIteration}/${run.repairLimit}`;
  summary.append(status, repair);
  const request = document.createElement('p'); request.textContent = run.requestSummary;
  const config = document.createElement('p'); config.className = 'chat-task-config'; config.textContent = `Model ${run.model.id} · reasoning ${run.model.reasoningEffort} · max output ${run.model.outputTokenLimit} · prompt ${run.promptProfile.id}@${run.promptProfile.version} · r${run.documentRevision ?? 'unknown'}`;
  panel.append(summary, request, config);
  if (run.terminalDiagnostic) { const diagnostic = document.createElement('p'); diagnostic.className = 'chat-task-diagnostic'; diagnostic.textContent = run.terminalDiagnostic === 'task.acceptance-evidence-incomplete' ? `尚未完成验收：${run.acceptance.filter(item => item.required && (item.status !== 'pass' || item.evidenceIds.length === 0)).length} 项必需标准待验证，已保留 ${run.evidence.length} 份证据。继续后将开启新回合补齐。` : `原因：${executionFailureReason(run.terminalDiagnostic, run.timeline.filter(item => item.status === 'error').at(-1)?.detail ?? null)}`; panel.append(diagnostic); }
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
function budgetLabel(key: string): string { return ({ inputTokens: 'Net-new input tokens', outputTokens: 'Output tokens', estimatedCostMicros: 'Cost limit (µ currency)', wallTimeMs: 'Wall time (ms)', turns: 'Turns', toolCalls: 'Tool calls', repairIterations: 'Repair loops', observationBytes: 'Observation bytes' } as Record<string, string>)[key] ?? key; }
function modelBudget(value: TaskBudgetV2 | undefined): TaskBudgetV2 {
  return value ?? Object.freeze({ schemaVersion: 2 as const, id: 'budget:conversation-default', enforcement: 'hard' as const, limits: Object.freeze({ inputTokens: 200_000, outputTokens: 50_000, estimatedCostMicros: 2_000_000, wallTimeMs: 600_000, turns: 12, toolCalls: 100, repairIterations: 5, observationBytes: 5_000_000 }) });
}
function renderTaskCostCard(document: Document, value: NonNullable<ConversationReadModel['taskAccounting']>): HTMLElement {
  const card = document.createElement('section'); card.className = `chat-task-cost chat-task-cost-${value.budgetStatus}`; card.setAttribute('aria-label', 'Task usage and cost');
  const title = document.createElement('strong'); title.textContent = value.cost.final ? '当前任务用量 · 最终统计' : '当前任务用量 · 执行中';
  const cost = document.createElement('p'); cost.textContent = value.cost.amountMicros === null || !value.cost.currency ? `Cost unknown — ${value.cost.explanation}` : `${value.cost.status}: ${(value.cost.amountMicros / 1_000_000).toFixed(6)} ${value.cost.currency}`;
  const usage = document.createElement('p'); usage.textContent = `Input ${value.usage.inputTokens ?? 'unknown'} · cached ${value.usage.cachedInputTokens ?? 'unknown'} · output ${value.usage.outputTokens ?? 'unknown'} · reasoning ${value.usage.reasoningTokens ?? 'unknown'} · tools ${value.usage.toolInputBytes + value.usage.toolOutputBytes} B`;
  const contextCache = value.usage.contextCache ? document.createElement('p') : null;
  if (contextCache && value.usage.contextCache) contextCache.textContent = `Context cache: local ${value.usage.contextCache.localArtifactHits} hit / ${value.usage.contextCache.localArtifactMisses} miss · delta reused ${value.usage.contextCache.deltaReuseBytes} B · provider eligible ${value.usage.contextCache.providerCacheEligibleBytes} B · provider hit ${value.usage.contextCache.providerReportedHitTokens ?? 'unknown'}`;
  const budget = document.createElement('p'); budget.textContent = `Budget: ${value.budgetStatus} (${value.budget.enforcement})${value.cost.cacheSavingMicros === null ? '' : ` · cache saved ≈ ${(value.cost.cacheSavingMicros / 1_000_000).toFixed(6)} ${value.cost.currency}`}`;
  card.append(title, cost, usage);
  const limits = document.createElement('dl'); limits.className = 'execution-budget-limits';
  // The input limit charges net-new tokens, whereas the usage total includes cache reads/writes.
  // Keep these distinct instead of displaying a misleading total-input percentage.
  for (const [label, text] of [
    ['新增输入预算上限', `${value.budget.limits.inputTokens ?? '未设置'} tokens（输入总量含缓存）`],
    ['输出预算', `${value.usage.outputTokens ?? '未知'} / ${value.budget.limits.outputTokens ?? '未设置'} tokens`],
    ['耗时预算', `${(value.usage.wallTimeMs / 1000).toFixed(1)} / ${(value.budget.limits.wallTimeMs / 1000).toFixed(1)} 秒`],
    ['费用预算上限', value.budget.limits.estimatedCostMicros === null ? '未设置' : `${value.budget.limits.estimatedCostMicros / 1_000_000} ${value.cost.currency ?? '币种未知'}`],
  ]) { const term = document.createElement('dt'); term.textContent = label!; const detail = document.createElement('dd'); detail.textContent = text!; limits.append(term, detail); }
  card.append(limits);
  if (value.usage.outputTokens !== null && value.budget.limits.outputTokens !== null && value.budget.limits.outputTokens > 0) {
    const meter = document.createElement('progress'); meter.max = value.budget.limits.outputTokens; meter.value = value.usage.outputTokens;
    meter.setAttribute('aria-label', `输出预算已使用 ${Math.round(value.usage.outputTokens / value.budget.limits.outputTokens * 100)}%`); card.append(meter);
  }
  if (contextCache) card.append(contextCache); card.append(budget); return card;
}

function renderCard(document: Document, card: ChatCardReadModel, dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const item = document.createElement('li');
  item.className = `chat-card tone-${card.tone}`;
  item.dataset.kind = card.kind;
  item.dataset.conversationNodeId = card.id;
  item.dataset.status = card.status;
  const content = createChatCardSurface(document, item, card.status === 'pending' || card.status === 'streaming');
  const title = document.createElement('h3'); title.textContent = card.title; content.append(title);
  const body = document.createElement('p'); body.textContent = card.body; content.append(body);
  if (card.kind === 'question') { body.className = 'chat-question-context'; body.style.whiteSpace = 'pre-wrap'; body.style.overflowWrap = 'anywhere'; body.style.maxHeight = 'none'; }
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
        approve.disabled = true; revise.disabled = true; review.setAttribute('aria-busy', 'true'); approve.textContent = '正在提交…';
        dispatch(Object.freeze({ type: 'conversation/accept-plan', nodeId: card.id, acceptedItemIds: Object.freeze(acceptedItemIds), mode: 'approve', ...(note.value.trim() ? { note: note.value.trim() } : {}) }));
      });
      const revise = document.createElement('button'); revise.type = 'button'; revise.textContent = '补充后重新规划';
      revise.addEventListener('click', () => {
        const feedback = note.value.trim(); if (!feedback) { note.focus(); return; }
        approve.disabled = true; revise.disabled = true; review.setAttribute('aria-busy', 'true'); approve.textContent = '正在提交…';
        dispatch(Object.freeze({ type: 'conversation/accept-plan', nodeId: card.id, acceptedItemIds: Object.freeze([]), mode: 'revise', note: feedback }));
      });
      review.append(note, approve, revise); content.append(review);
    }
    content.append(list);
  }
  const actions = document.createElement('div'); actions.className = 'chat-card-actions';
  for (const action of card.actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label; button.disabled = !action.enabled || !action.intent;
    button.addEventListener('click', () => { if (action.enabled && action.intent && !button.disabled) { for (const sibling of actions.querySelectorAll('button')) sibling.disabled = true; actions.setAttribute('aria-busy', 'true'); button.textContent = '正在提交…'; dispatch(action.intent); } });
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
  return Object.freeze({ ...base, title: node.content.queryLimit ? '查询额度确认' : 'Question', body: question?.prompt ?? 'Invalid question payload.', tone: 'warning', actions: Object.freeze(actions), ...(question ? { question } : {}) });
}

function planCard(base: CardBase, node: ConversationNodeReadModel): ChatCardReadModel {
  const items = planFromNode(node);
  const fallback = `${items.length} 个实施步骤。确认后将自动执行低风险编辑；危险能力仍会单独请求授权。`;
  const title = stringValue(node.content.title, '总体实现方案');
  return Object.freeze({ ...base, title: node.status === 'pending' ? `待批准 · ${title}` : title, body: [stringValue(node.content.summary, fallback), ...(Array.isArray(node.content.assemblies) ? node.content.assemblies : []).filter((a): a is JsonObject => a !== null && typeof a === 'object' && !Array.isArray(a)).map(a => `组合要求：${String(a.label)}；部件 ${Array.isArray(a.partKeys) ? a.partKeys.join('、') : ''}；至少 ${String(a.minimumInstances)} 个实例${a.distinctColors ? `，${String(a.distinctColors)} 种独立颜色` : ''}`)].join('\n'), tone: node.status === 'pending' ? 'warning' : 'neutral', actions: Object.freeze([]), planItems: items });
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
