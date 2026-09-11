import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopNotificationService } from '../dist/desktop-notifications.js';
import { DEFAULT_NOTIFICATION_PREFERENCES as defaults } from '../dist/notification-settings.js';
import { validateStudioIpcRequest } from '../dist/ipc.js';
const notice = (id = 'notice:1', extra = {}) => ({ type: 'show', notice: { id, projectId: 'project:test', documentId: 'document:test', nodeId: 'node:approval', taskId: 'task:test', kind: 'approval', expiresAt: null, ...extra } });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-notifications-'));
  const events = [], shown = [], attention = []; let focused = false, supported = true;
  const port = { supported: () => supported, focused: () => focused, show(options, callbacks) { const n = { options, callbacks, closed: false, close() { n.closed = true; } }; shown.push(n); return n; }, focus() { events.push('focus'); }, attention() { const handle = { closed: false, close() { handle.closed = true; } }; attention.push(handle); return handle; }, beep() { events.push('beep'); }, navigate() { events.push('navigate'); } };
  const service = new DesktopNotificationService(directory, port); await service.initialize();
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service, port, shown, events, attention, focus(value) { focused = value; }, support(value) { supported = value; } };
}
test('background notification uses OS sound once, click returns a typed target without executing an approval', async t => {
  const f = await fixture(t); await f.service.configure({ ...defaults, backgroundOnly: true }); f.focus(true); f.service.receive(notice()); assert.equal(f.shown.length, 0);
  f.focus(false); f.service.receive(notice()); f.service.receive(notice()); assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].options.silent, false); assert.match(f.shown[0].options.title, /需要审批/);
  f.shown[0].callbacks.click(); assert.deepEqual(f.events, ['focus', 'navigate']);
  assert.deepEqual(f.service.takeTarget(), { projectId: 'project:test', documentId: 'document:test', nodeId: 'node:approval', taskId: 'task:test' });
  assert.equal(f.service.takeTarget(), null); f.shown[0].callbacks.click(); assert.equal(f.events.length, 2);
});
test('sound/background settings persist across restart and disabled notifications suppress delivery', async t => {
  const f = await fixture(t); await f.service.configure({ ...defaults, sound: false, backgroundOnly: false, language: 'en' });
  f.focus(true); f.service.receive(notice()); assert.equal(f.shown[0].options.silent, true); assert.match(f.shown[0].options.title, /Approval required/);
  const reloaded = new DesktopNotificationService(f.directory, f.port); await reloaded.initialize();
  assert.equal(reloaded.snapshot().preferences.sound, false); await reloaded.dispose();
  await f.service.configure({ ...defaults, enabled: false }); assert.equal(f.shown[0].closed, true);
  f.service.receive(notice('other')); assert.equal(f.shown.length, 1); assert.throws(() => f.service.test(), /disabled/);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'notifications.json'), 'utf8')).enabled, false);
});
test('withdraw, project disposal, expiry and OS closure prevent stale click actions and release handles', async t => {
  const f = await fixture(t); f.service.receive(notice()); f.service.receive({ type: 'withdraw', id: 'notice:1' });
  f.shown[0].callbacks.click(); assert.deepEqual(f.events, []);
  f.service.receive(notice('expired', { expiresAt: Date.now() - 1 })); assert.equal(f.shown.length, 1);
  f.service.receive(notice('short', { expiresAt: Date.now() + 10 })); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(f.shown[1].closed, true);
  for (let i = 0; i < 10; i++) f.service.receive(notice(`bounded:${i}`));
  assert.equal(f.shown.filter(n => !n.closed).length, 4);
  await f.service.dispose(); assert.ok(f.shown.every(n => n.closed)); f.service.receive(notice('late')); assert.equal(f.shown.length, 12);
});
test('icon attention is independent of delivery, and failure beeps once with lifecycle cleanup', async t => {
  const f = await fixture(t); f.service.receive(notice()); f.shown[0].callbacks.failed();
  assert.equal(f.service.snapshot().delivery, 'failed'); assert.deepEqual(f.events, ['beep']);
  assert.equal(f.attention.length, 1); assert.equal(f.attention[0].closed, false);
  f.shown[0].callbacks.failed(); f.shown[0].callbacks.click(); assert.deepEqual(f.events, ['beep']);
  f.service.receive({ type: 'withdraw', id: 'notice:1' }); assert.equal(f.attention[0].closed, true);
  f.support(false); assert.equal(f.service.test().delivery, 'unsupported'); assert.equal(f.shown.length, 1);
  await f.service.dispose(); assert.ok(f.attention.every(handle => handle.closed));
});
test('foreground and background turns notify by default; mute also suppresses fallback sound', async t => {
  const f = await fixture(t); f.focus(true); f.service.receive(notice('turn', { kind: 'turn-completed' }));
  assert.equal(f.shown.length, 1); assert.match(f.shown[0].options.title, /本轮执行已结束/);
  assert.equal(f.shown[0].options.silent, false); assert.equal(f.attention.length, 1);
  f.shown[0].callbacks.shown(); assert.equal(f.service.snapshot().delivery, 'shown');
  await f.service.configure({ ...defaults, sound: false }); f.focus(false); f.support(false);
  f.service.receive(notice('muted')); assert.equal(f.attention.length, 2); assert.deepEqual(f.events, []);
});
test('test notification works in foreground, is rate limited and follows mute', async t => {
  const f = await fixture(t); f.focus(true); await f.service.configure({ ...defaults, sound: false });
  f.service.test(); f.service.test(); assert.equal(f.shown.length, 1); assert.equal(f.shown[0].options.silent, true);
  f.shown[0].callbacks.click(); assert.equal(f.service.takeTarget(), null);
});
test('notification IPC is closed: no arbitrary text, sound URL, path or approval decision', () => {
  const request = (channel, payload = {}) => ({ schemaVersion: 1, id: 'request:test', correlationId: 'correlation:test', channel, payload });
  for (const channel of ['notifications/get', 'notifications/target', 'notifications/test']) {
    assert.equal(validateStudioIpcRequest(request(channel)).channel, channel);
    assert.throws(() => validateStudioIpcRequest(request(channel, { body: 'injected' })));
  }
  assert.equal(validateStudioIpcRequest(request('notifications/set', { preferences: defaults })).channel, 'notifications/set');
  for (const preferences of [{ ...defaults, sound: 'yes' }, { ...defaults, soundUrl: 'https://example.com' }, { ...defaults, schemaVersion: 2 }, { ...defaults, allowAlways: true }, { ...defaults, language: ['en'] }, { ...defaults, language: {} }]) assert.throws(() => validateStudioIpcRequest(request('notifications/set', { preferences })));
});

test('Electron adapter uses macOS sound/Dock bounce and Windows flash with focus/close cleanup', async () => {
  const { build } = await import('esbuild');
  const { EventEmitter } = await import('node:events');
  for (const platform of ['darwin', 'win32']) {
    const events = []; let focused = false;
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => focused, flashFrame: value => events.push(['flash', value]) });
    class Notification extends EventEmitter {
      static isSupported() { return true; }
      constructor(options) { super(); events.push(['notification', options]); }
      show() { this.emit('show'); }
      close() { events.push(['close']); }
    }
    globalThis.notificationElectronFixture = { Notification, app: { dock: { bounce: type => { events.push(['bounce', type]); return 42; }, cancelBounce: id => events.push(['cancel', id]) } }, shell: { beep: () => events.push(['beep']) } };
    try {
      const result = await build({ entryPoints: [new URL('../dist/electron-notifications.js', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node', define: { 'process.platform': JSON.stringify(platform) }, plugins: [{ name: 'electron-fixture', setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const {app, Notification, shell} = globalThis.notificationElectronFixture;' }));
      } }] });
      const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${platform}`);
      const port = module.electronNotificationPort(() => window);
      const attention = port.attention();
      assert.deepEqual(events[0], platform === 'darwin' ? ['bounce', 'informational'] : ['flash', true]);
      let shown = 0;
      const notification = port.show({ title: 'Fixture', body: 'Fixture', silent: false }, { shown() { shown++; }, click() {}, close() {}, failed() {} });
      assert.equal(shown, 1); assert.equal(events.find(e => e[0] === 'notification')[1].sound, platform === 'darwin' ? 'Glass' : undefined);
      focused = true; window.emit('focus'); attention.close(); notification.close();
      assert.equal(window.listenerCount('focus'), 0); assert.equal(window.listenerCount('closed'), 0);
      if (platform === 'darwin') assert.equal(events.filter(e => e[0] === 'cancel').length, 1);
      const count = events.length; port.attention().close(); assert.equal(events.length, count);
      const disabled = module.electronNotificationPort(() => window, true); disabled.attention().close(); disabled.beep(); assert.equal(events.length, count);
      focused = false; const pending = port.attention(); window.emit('closed'); pending.close(); assert.equal(window.listenerCount('focus'), 0);
    } finally { delete globalThis.notificationElectronFixture; }
  }
});
