import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserWindowPreviewControl } from './fixtures/g12-browser-window-preview-control.mjs';

test('G12 preview control removes command abort listeners after a successful result', async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) { assert.equal(type, 'abort'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'abort'); listeners.delete(listener); },
  };
  const expected = { playId: 'play:g12', documentRevision: 1, scriptDigests: [], tick: 0, frame: 0, viewport: null, device: null, capturedAt: '2026-08-30T00:00:00.000Z', value: {} };
  const control = new BrowserWindowPreviewControl({ webContents: { async executeJavaScript(source) { assert.match(source, /"kind":"inspect"/u); return expected; } } });
  assert.equal(await control.inspect(signal), expected);
  assert.equal(listeners.size, 0);
});

test('G12 preview control rejects an already-aborted command before renderer dispatch', async () => {
  let dispatched = false;
  const control = new BrowserWindowPreviewControl({ webContents: { async executeJavaScript() { dispatched = true; } } });
  const reason = new Error('cancelled by runner');
  await assert.rejects(control.inspect({ aborted: true, reason }), reason);
  assert.equal(dispatched, false);
});
