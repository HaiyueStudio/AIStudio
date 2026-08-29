import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installStdioErrorGuards } from '../dist/stdio-safety.js';

test('closed parent stdio pipes cannot crash the Electron GUI process', () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const unexpected = [];
  installStdioErrorGuards([stdout, stderr], (cause) => unexpected.push(cause));
  assert.doesNotThrow(() => stdout.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
  assert.doesNotThrow(() => stderr.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
  assert.deepEqual(unexpected, []);
  const other = Object.assign(new Error('unexpected stream failure'), { code: 'EIO' });
  stdout.emit('error', other);
  assert.deepEqual(unexpected, [other]);
});
