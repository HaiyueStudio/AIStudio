import type { JsonObject, StableId } from '@haiyue/ai-studio-contracts';
import { approvalFromNode, planFromNode, questionFromNode, safeText } from '../../conversation/validation.js';
import type {
  ChatCardAction,
  ChatCardReadModel,
  ConversationBackendReadModel,
  ConversationIntent,
  ConversationNodeReadModel,
  ConversationReadModel,
} from '../../conversation/types.js';

export interface ChatPanelReadModel {
  readonly backendId: StableId | null;
  readonly backends: readonly ConversationBackendReadModel[];
  readonly cards: readonly ChatCardReadModel[];
  readonly composer: Readonly<{ busy: boolean; blockedReason: string | null; canSend: boolean; canCancel: boolean }>;
  readonly connection: ConversationReadModel['connection'];
  readonly ariaLive: string;
}

export function presentChatPanel(snapshot: ConversationReadModel, now = Date.now()): ChatPanelReadModel {
  const cards = Object.freeze(snapshot.nodes.map((node) => presentConversationNode(node, now)));
  return Object.freeze({
    backendId: snapshot.backendId, backends: snapshot.backends, cards,
    composer: Object.freeze({ busy: snapshot.busy, blockedReason: snapshot.composerBlockedReason, canSend: snapshot.composerBlockedReason === null && snapshot.backendId !== null, canCancel: snapshot.busy }),
    connection: snapshot.connection,
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
    case 'text': return card(base, 'Agent message', stringValue(node.content.text, ''), node.status === 'streaming' ? 'progress' : 'neutral');
    case 'progress': return card(base, stringValue(node.content.label, 'Progress'), progressBody(node.content), 'progress');
    case 'tool-call': return card(base, `Tool · ${stringValue(node.content.toolId, 'unknown')}`, stringValue(node.content.argumentsSummary, 'Structured arguments are available to the host only.'), 'warning');
    case 'tool-result': return card(base, 'Tool result', stringValue(node.content.summary, 'Tool completed without a presentation summary.'), node.status === 'failed' ? 'danger' : 'success');
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
  const previousFeed = root.querySelector?.('.chat-feed') as HTMLElement | null | undefined;
  const followLatest = !previousFeed || chatFeedIsNearLatest(previousFeed);
  const preservedScrollTop = previousFeed?.scrollTop ?? 0;
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
  fragment.append(backendControls);
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
  input.disabled = !model.composer.canSend;
  const send = document.createElement('button'); send.type = 'button'; send.textContent = 'Send'; send.disabled = !model.composer.canSend;
  const sendIntent = (): void => {
    const prompt = input.value.trim();
    if (!model.backendId || !model.composer.canSend || !prompt || new TextEncoder().encode(prompt).byteLength > 16 * 1024) return;
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
  const syncLatestButton = (): void => { jumpLatest.hidden = chatFeedIsNearLatest(feed); };
  if (followLatest) feed.scrollTop = feed.scrollHeight;
  else feed.scrollTop = Math.min(preservedScrollTop, Math.max(0, feed.scrollHeight - feed.clientHeight));
  feed.addEventListener('scroll', syncLatestButton, { passive: true });
  jumpLatest.addEventListener('click', () => { feed.scrollTop = feed.scrollHeight; syncLatestButton(); });
  syncLatestButton();
}

function renderCard(document: Document, card: ChatCardReadModel, dispatch: (intent: ConversationIntent) => void): HTMLElement {
  const item = document.createElement('li');
  item.className = `chat-card tone-${card.tone}`;
  item.dataset.kind = card.kind;
  item.dataset.status = card.status;
  const title = document.createElement('h3'); title.textContent = card.title; item.append(title);
  const body = document.createElement('p'); body.textContent = card.body; item.append(body);
  if (card.approval) {
    const disclosure = document.createElement('dl');
    for (const [label, value] of [['Tool', `${card.approval.toolId}@${card.approval.toolVersion}`], ['Target', card.approval.target], ['Effect', card.approval.effect], ['Risk', card.approval.risk], ['Base revision', String(card.approval.baseRevision)], ['Expires', card.approval.expiresAt], ['Arguments', card.approval.argumentsSummary], ['Preview', card.approval.previewDiff]]) {
      const term = document.createElement('dt'); term.textContent = label; const detail = document.createElement('dd'); detail.textContent = value; disclosure.append(term, detail);
    }
    item.append(disclosure);
  }
  if (card.planItems) {
    const list = document.createElement('ul');
    for (const plan of card.planItems) { const row = document.createElement('li'); row.textContent = `${plan.label} · ${plan.status}${plan.details ? ` · ${plan.details}` : ''}`; list.append(row); }
    item.append(list);
  }
  const actions = document.createElement('div'); actions.className = 'chat-card-actions';
  for (const action of card.actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label; button.disabled = !action.enabled || !action.intent;
    button.addEventListener('click', () => { if (action.enabled && action.intent && !button.disabled) { button.disabled = true; dispatch(action.intent); } });
    actions.append(button);
  }
  if (card.actions.length) item.append(actions);
  return item;
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
  const accepted = items.filter((item) => item.status !== 'rejected').map((item) => item.id);
  const actions = node.status === 'pending' ? [Object.freeze({ id: 'accept-plan', label: 'Accept selected plan items', enabled: true, intent: Object.freeze({ type: 'conversation/accept-plan', nodeId: node.id, acceptedItemIds: Object.freeze(accepted) }) })] : [];
  return Object.freeze({ ...base, title: stringValue(node.content.title, 'Proposed plan'), body: `${items.length} structured item${items.length === 1 ? '' : 's'}. Plan acceptance does not authorize tools.`, tone: 'neutral', actions: Object.freeze(actions), planItems: items });
}

function approvalCard(base: CardBase, node: ConversationNodeReadModel, now: number): ChatCardReadModel {
  const approval = approvalFromNode(node);
  const enabled = Boolean(approval && node.status === 'pending' && approval.decision === 'pending' && Date.parse(approval.expiresAt) > now);
  const actions: ChatCardAction[] = approval ? [
    Object.freeze({ id: 'approval-allow', label: 'Allow once', enabled, intent: Object.freeze({ type: 'conversation/resolve-approval', approvalId: approval.approvalId, decision: 'allow-once' }) }),
    Object.freeze({ id: 'approval-allow-always', label: 'Allow always', enabled, intent: Object.freeze({ type: 'conversation/resolve-approval', approvalId: approval.approvalId, decision: 'allow-always' }) }),
    Object.freeze({ id: 'approval-reject', label: 'Reject', enabled, intent: Object.freeze({ type: 'conversation/resolve-approval', approvalId: approval.approvalId, decision: 'reject' }) }),
  ] : [];
  const body = approval
    ? `${approval.effect} on ${approval.target}; decision: ${approval.decision}. Allow always is limited to this tool/version and target for the current project session.`
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

type CardBase = Readonly<Pick<ChatCardReadModel, 'id' | 'kind' | 'status' | 'provenance' | 'metadata'>>;
function card(base: CardBase, title: string, body: string, tone: ChatCardReadModel['tone']): ChatCardReadModel { return Object.freeze({ ...base, title: safeText(title, 240), body: safeText(body), tone, actions: Object.freeze([]) }); }
function stringValue(value: unknown, fallback: string): string { return typeof value === 'string' ? safeText(value) : fallback; }
function progressBody(content: JsonObject): string { const message = stringValue(content.message, 'Working…'); return typeof content.current === 'number' && typeof content.total === 'number' ? `${message} ${content.current}/${content.total}` : message; }
