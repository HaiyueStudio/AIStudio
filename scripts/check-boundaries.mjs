import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json']);
const violations = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (sourceExtensions.has(path.extname(entry.name))) await inspect(target);
  }
}

async function inspect(file) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const text = await readFile(file, 'utf8');
  const deepseekImport = /(?:from\s+|import\s*\(|require\s*\()\s*['"](@deepseek-ai\/(?:dsh[^'"]*|cordis[^'"]*))['"]/g;
  for (const match of text.matchAll(deepseekImport)) {
    if (!relative.startsWith('packages/harness-bridge/')) violations.push(`${relative}: DeepSeek import ${match[1]} outside harness-bridge`);
  }
  const codexImport = /(?:from\s+|import\s*\(|require\s*\()\s*['"](@openai\/codex[^'"]*)['"]/g;
  for (const match of text.matchAll(codexImport)) {
    if (!relative.startsWith('packages/agent-backends/') && !relative.startsWith('scripts/')) violations.push(`${relative}: Codex import ${match[1]} outside agent-backends`);
  }
  if (/file:\.\.|(?:\.\.\/)+(?:Editor|Engine|UI)(?:\/|['"])/i.test(text)) violations.push(`${relative}: forbidden cross-repository path dependency`);
  if (path.basename(file) === 'package.json') {
    const pkg = JSON.parse(text);
    if (relative.startsWith('packages/') || relative.startsWith('apps/')) assert.equal(pkg.private, true, `${relative} must remain private`);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg[section] ?? {})) {
        if (name.startsWith('@deepseek-ai/') || name === '@openai/codex') {
          if (/^[~^*]|latest|master|git|file:/i.test(range)) violations.push(`${relative}: ${name} must use an exact version, got ${range}`);
        }
      }
    }
  }
}

await walk(root);
assert.deepEqual(violations, [], violations.join('\n'));
console.log('[boundaries] single Harness bridge, Codex adapter, private workspace, and cross-repository rules passed');
