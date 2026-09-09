import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanGeneratedEvidence } from './secret-scan.mjs';

test('generated evidence scan detects configured values across chunks and binary dumps without disclosing them', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'haiyue-g09-secret-scan-'));
  const filename = path.join(folder, 'generated.dmp'), canary = 'G09-private-canary-value';
  for (const encoding of ['utf8', 'utf16le']) {
    await writeFile(filename, Buffer.concat([Buffer.alloc(65530, 32), Buffer.from(canary, encoding)]));
    await assert.rejects(scanGeneratedEvidence(folder, [canary]), error => error.message.includes('contents suppressed') && !error.message.includes(canary));
  }
  await writeFile(filename, 'Generated clean crash dump fixture.');
  const result = await scanGeneratedEvidence(folder, [canary]); assert.equal(result.files, 1); assert.equal(result.crashDumps, 1); assert.equal(result.passed, true);
  await unlink(filename);
});
