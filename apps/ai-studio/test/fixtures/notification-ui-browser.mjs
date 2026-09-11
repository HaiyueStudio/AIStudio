import { mountNotificationSettings } from '../../dist/notification-ui.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../dist/notification-settings.js';
import { ConversationProjector, presentChatPanel, renderChatPanel, revealChatAttention } from '@haiyue/ai-studio-shell';
import { defineTabsComponents } from '@haiyue/ui/tabs';
defineTabsComponents();
const assert = (value, message) => { if (!value) throw new Error(message); };
window.testResult = (async () => {
  let preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES }, language = 'zh-CN'; const calls = [];
  const invoke = async (method, payload) => { calls.push(method); if (method === 'notifications/set') preferences = payload.preferences; return { preferences, supported: true, delivery: 'shown' }; };
  const settings = document.getElementById('settings'), mounted = mountNotificationSettings(document, settings, { desktop: true, language: () => language, invoke });
  await mounted.ready;
  const sound = settings.querySelector('[data-notification=sound]'); sound.focus(); assert(document.activeElement === sound, 'checkbox keyboard focus');
  sound.click(); await new Promise(resolve => setTimeout(resolve, 0)); assert(preferences.sound === false, 'mute persisted');
  settings.querySelector('#notification-test').click(); await new Promise(resolve => setTimeout(resolve, 0)); assert(calls.includes('notifications/test'), 'test command');
  const enabled = settings.querySelector('[data-notification=enabled]'); enabled.click(); await new Promise(resolve => setTimeout(resolve, 0)); assert(settings.querySelector('#notification-test').disabled && sound.disabled, 'disabled controls');
  enabled.click(); await new Promise(resolve => setTimeout(resolve, 0)); language = 'en'; mounted.refreshLocale(); await new Promise(resolve => setTimeout(resolve, 0)); assert(settings.textContent.includes('Notifications and sound') && preferences.language === 'en', 'locale and persisted notification language');
  const stamp = '2026-09-09T00:00:00.000Z', provenance = { backendId: 'backend:test', sessionId: 'session:test', turnId: 'turn:test' };
  const run = (taskId, startedAt) => ({ schemaVersion: 1, revision: 1, taskId, title: taskId, status: 'completed', phase: 'complete', startedAt, updatedAt: startedAt, ...provenance, model: { id: 'model', reasoningEffort: 'low', outputTokenLimit: 1000 }, promptProfile: { id: 'prompt:test', version: '1', digest: `sha256:${'a'.repeat(64)}` }, documentRevision: 1, repairIteration: 0, repairLimit: 2, terminalDiagnostic: null, acceptance: [], evidence: [], timeline: [] });
  const snapshot = { revision: 1, connection: 'connected', busy: false, backendId: null, backends: [], taskAccounting: null, taskRuns: [run('task:old', stamp), run('task:new', '2026-09-09T01:00:00.000Z')], executionGraphs: [], events: [{ schemaVersion: 1, sequence: 1, source: 'replay', node: { schemaVersion: 1, id: 'node:question', kind: 'question', status: 'pending', createdAt: stamp, provenance, content: { prompt: 'Confirm the editor request', options: [] } } }] };
  let mutations = 0; const chat = document.getElementById('chat');
  renderChatPanel(chat, presentChatPanel(new ConversationProjector().reset(snapshot)), () => mutations++);
  assert(revealChatAttention(chat, { nodeId: 'node:question', taskId: null }), 'question exists'); assert(document.activeElement.dataset.conversationNodeId === 'node:question', 'exact card focus');
  assert(revealChatAttention(chat, { nodeId: null, taskId: 'task:old' }), 'historical task exists'); assert(document.activeElement.dataset.taskId === 'task:old' && !document.activeElement.hidden, 'exact task revealed');
  assert(!revealChatAttention(chat, { nodeId: 'node:missing', taskId: 'task:missing' }), 'missing target ignored'); assert(mutations === 0, 'navigation never approves or resumes');
  mounted.dispose(); assert(!settings.querySelector('#notification-settings'), 'settings released');
  const reloaded = mountNotificationSettings(document, settings, { desktop: true, language: () => language, invoke }); await reloaded.ready; assert(!settings.querySelector('[data-notification=sound]').checked, 'settings reload preserved mute');
  reloaded.dispose();
  let requested = false;
  const asynchronous = mountNotificationSettings(document, settings, { desktop: true, language: () => 'en', invoke: async method => {
    if (method === 'notifications/test') { requested = true; return { supported: true, delivery: 'requested' }; }
    return { preferences: { ...preferences, language: 'en' }, supported: true, delivery: requested ? 'failed' : 'idle' };
  } });
  await asynchronous.ready; settings.querySelector('#notification-test').click();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert(settings.querySelector('[role=status]').textContent.includes('system delivery failed'), 'late native failure is visible, not reported as successful delivery');
  asynchronous.dispose();
  return 'passed';
})().catch(cause => ({ error: cause.message, stack: cause.stack }));
