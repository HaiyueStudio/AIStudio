import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeepSeekCredentialStore } from '../dist/deepseek-credential-store.js';

const canary = 'SECRET_CANARY_DEEPSEEK_G07_123456789';
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
  decryptString: (value) => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString(),
};

test('DeepSeek credentials migrate out of process env into an encrypted main-process store and logout removes them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-deepseek-credential-'));
  const store = new DeepSeekCredentialStore(root, encryption);
  const environment = { HAIYUE_STUDIO_DEEPSEEK_SECRET: canary, DEEPSEEK_API_KEY: 'legacy-must-also-be-cleared', PATH: 'retained' };
  assert.equal(await store.importFromEnvironment(environment), true);
  assert.deepEqual(environment, { PATH: 'retained' });
  assert.equal(await store.resolve(), canary);
  const recordPath = path.join(root, 'credentials', 'deepseek-api-key.v1.json');
  assert.doesNotMatch(await readFile(recordPath, 'utf8'), new RegExp(canary));
  await store.set('ROTATED_SECRET_CANARY_DEEPSEEK_G07_987654321');
  assert.equal(await store.resolve(), 'ROTATED_SECRET_CANARY_DEEPSEEK_G07_987654321');
  await store.clear();
  assert.equal(await store.resolve(), null);
  await assert.rejects(stat(recordPath), (error) => error.code === 'ENOENT');
});

test('credential records and unavailable OS encryption fail closed without retaining environment secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-deepseek-credential-fault-'));
  const unavailable = new DeepSeekCredentialStore(root, { ...encryption, isEncryptionAvailable: () => false });
  const environment = { DEEPSEEK_API_KEY: canary };
  await assert.rejects(unavailable.importFromEnvironment(environment), (error) => error.code === 'credential.encryption-unavailable');
  assert.deepEqual(environment, {});

  const store = new DeepSeekCredentialStore(root, encryption);
  const recordPath = path.join(root, 'credentials', 'deepseek-api-key.v1.json');
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, JSON.stringify({ schemaVersion: 1, encryption: 'plaintext', cipherText: canary }));
  await assert.rejects(store.resolve(), (error) => error.code === 'credential.record-malformed');
});
