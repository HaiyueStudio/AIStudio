import assert from 'node:assert/strict';
import { readdir, open } from 'node:fs/promises';
import path from 'node:path';

// Scan only caller-owned test output. Never open a real credential store.
export async function scanGeneratedEvidence(directory, secrets = []) {
  const needles = secrets.filter(value => typeof value === 'string' && value.length >= 8)
    .flatMap(value => [Buffer.from(value), Buffer.from(value, 'utf16le')]);
  const patterns = [/(?:sk|sess)-[A-Za-z0-9_-]{24,}/u, /authorization["'\s:]+bearer\s+[A-Za-z0-9._-]{16,}/iu,
    /\.codex[\\/](?:auth|credentials)\.json/iu];
  let files = 0, bytes = 0, crashDumps = 0;
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Generated evidence must not link outside its owned directory.');
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(target); continue; }
      if (!entry.isFile()) continue;
      const handle = await open(target, 'r'); let tail = Buffer.alloc(0);
      try {
        const info = await handle.stat(); assert.ok(info.size <= 64 * 1024 * 1024, 'Evidence scan per-file budget exceeded.');
        files++; bytes += info.size; if (/\.(dmp|mdmp)$/iu.test(entry.name)) crashDumps++;
        assert.ok(bytes <= 512 * 1024 * 1024, 'Evidence scan total budget exceeded.');
        const block = Buffer.alloc(64 * 1024), overlap = Math.max(4096, ...needles.map(value => value.length));
        for (;;) {
          const { bytesRead } = await handle.read(block, 0, block.length, null); if (!bytesRead) break;
          const value = Buffer.concat([tail, block.subarray(0, bytesRead)]), text = value.toString('utf8');
          assert.ok(!needles.some(needle => value.includes(needle)), 'Configured secret found in generated evidence; contents suppressed.');
          assert.ok(!patterns.some(pattern => pattern.test(text)), 'Credential-like content found in generated evidence; contents suppressed.');
          tail = value.subarray(Math.max(0, value.length - overlap));
        }
      } finally { await handle.close(); }
    }
  }
  await walk(directory);
  return { schemaVersion: 1, passed: true, files, bytes, crashDumps, rules: ['configured-secret-utf8-and-utf16', 'credential-token-patterns', 'credential-store-path'], limitation: 'Pattern and configured-value scan of generated files; no real credential store is read. A zero crash-dump count means no dump was generated.' };
}
