import test from 'node:test';
import assert from 'node:assert/strict';
import { TextJournal } from '../dist/text-journal.js';

const event = (delta, extra = {}) => ({ schemaVersion: 1, backendId: 'backend:w5', sessionId: 'session:w5', turnId: 'turn:w5', kind: 'conversation-node', payload: { delta, status: 'streaming', ...extra } });

test('text batching preserves delivery order at tool and terminal boundaries and supports fallback', async () => {
  for (const enabled of [true, false]) {
    const writes = [];
    const journal = new TextJournal(async value => { writes.push(value); }, enabled);
    for (let i = 0; i < 100; i++) await journal.accept(event('字符'));
    if (enabled) assert.equal(writes.length, 0, 'live delivery does not wait for a per-delta append');
    await journal.accept({ ...event(''), kind: 'tool-request', payload: { toolCallId: 'call:w5' } });
    assert.equal(writes.length, enabled ? 2 : 101);
    assert.equal(writes.slice(0, -1).map(e => e.payload.delta).join(''), '字符'.repeat(100));
    await journal.accept(event('tail'));
    await journal.accept({ ...event(''), kind: 'completed', payload: { status: 'completed' } });
    assert.equal(writes.at(-2).payload.delta, 'tail');
    assert.equal(writes.at(-1).kind, 'completed');
    await journal.flush();
  }
});

test('time, byte, metadata and interrupted-stream checkpoints flush without losing text', async () => {
  const writes = [];
  const journal = new TextJournal(async value => { writes.push(value); });
  await journal.accept(event('slow'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(writes[0].payload.delta, 'slow');
  await journal.accept(event('字'.repeat(2731)));
  assert.equal(writes.length, 2, 'UTF-8 byte threshold');
  await journal.accept(event('node one', { nodeId: 'node:1' }));
  await journal.accept(event('node two', { nodeId: 'node:2' }));
  assert.equal(writes.at(-1).payload.delta, 'node one');
  await journal.flush();
  assert.equal(writes.at(-1).payload.delta, 'node two');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(writes.length, 4, 'flush clears the timer');
});

test('a timer append failure blocks the next control fact rather than silently losing its checkpoint', async () => {
  const writes = [];
  const journal = new TextJournal(async value => { writes.push(value); throw new Error('disk failure'); });
  await journal.accept(event('pending'));
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(journal.accept({ ...event(''), kind: 'completed', payload: { status: 'completed' } }), /disk failure/);
  await assert.rejects(journal.flush(), /disk failure/);
  assert.equal(writes.length, 1);
});
