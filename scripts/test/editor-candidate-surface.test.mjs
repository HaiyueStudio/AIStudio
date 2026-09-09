import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyEditorCandidateSurface as verify } from '../editor-candidate-surface.mjs';

const css = Buffer.from('.advanced{}');
const candidate = { name: 'shell', requiredRuntimeExports: ['Shell'], requiredSubpathExports: { 'advanced-authoring': ['ADVANCED_AUTHORING_API_VERSION', 'mount'] }, requiredStylesheets: { 'advanced-authoring.css': createHash('sha256').update(css).digest('hex') } };
const modules = { shell: { Shell() {} }, 'shell/advanced-authoring': { ADVANCED_AUTHORING_API_VERSION: 1, mount() {} } };
test('public candidate checks include lazy subpaths and stylesheet bytes', async () => {
  const seen = [];
  await verify(candidate, ['World'], async name => { seen.push(name); return modules[name]; }, async name => { seen.push(name); return css; });
  assert.deepEqual(seen, ['shell', 'shell/advanced-authoring', 'shell/advanced-authoring.css']);
});
test('candidate rejects incomplete, incompatible or leaking lazy modules and substituted CSS', async () => {
  for (const advanced of [{}, { ...modules['shell/advanced-authoring'], ADVANCED_AUTHORING_API_VERSION: 2 }, { ...modules['shell/advanced-authoring'], World: {} }]) {
    await assert.rejects(verify(candidate, ['World'], async name => name === 'shell' ? modules.shell : advanced, async () => css));
  }
  await assert.rejects(verify(candidate, ['World'], async name => modules[name], async () => Buffer.from('changed')));
});

test('candidate source provenance cannot retain an old aggregate after a file digest changes', async () => {
  const sourceFiles = [{ path: 'editor-shell/src/index.ts', sha256: 'a'.repeat(64) }];
  const value = { ...candidate, provenance: { sourceFiles, sourceFilesDigestAlgorithm: 'sha256-json-source-files-v1', sourceFilesDigest: createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex') } };
  const check = () => verify(value, [], async name => modules[name], async () => css);
  await check(); sourceFiles[0].sha256 = 'b'.repeat(64); await assert.rejects(check, /source list digest is stale/);
});
