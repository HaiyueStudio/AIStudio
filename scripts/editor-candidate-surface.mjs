import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Validate the installed public surface independently of CLI or repository paths. */
export async function verifyEditorCandidateSurface(candidate, forbidden, load, readStyle) {
  if (candidate.provenance) {
    const p = candidate.provenance;
    assert.equal(p.sourceFilesDigestAlgorithm, 'sha256-json-source-files-v1');
    assert.ok(Array.isArray(p.sourceFiles) && p.sourceFiles.length > 0);
    const paths = new Set();
    for (const file of p.sourceFiles) {
      assert.deepEqual(Object.keys(file), ['path', 'sha256']);
      assert.ok(typeof file.path === 'string' && !file.path.includes('\\') && !file.path.startsWith('/')
        && !file.path.includes(':') && !file.path.split('/').some(part => !part || part === '.' || part === '..'));
      assert.ok(!paths.has(file.path)); paths.add(file.path);
      assert.match(file.sha256, /^[a-f0-9]{64}$/u);
    }
    assert.equal(createHash('sha256').update(JSON.stringify(p.sourceFiles)).digest('hex'), p.sourceFilesDigest, 'candidate source list digest is stale');
  }
  const modules = { '': candidate.requiredRuntimeExports, ...candidate.requiredSubpathExports };
  if (candidate.requiredConformanceExports) modules.conformance = candidate.requiredConformanceExports;
  for (const [subpath, names] of Object.entries(modules)) {
    const specifier = candidate.name + (subpath ? `/${subpath}` : '');
    const runtime = await load(specifier);
    for (const name of names) assert.ok(name in runtime, `${specifier} misses ${name}`);
    for (const name of forbidden) assert.equal(name in runtime, false, `${specifier} leaks ${name}`);
    if (subpath === 'advanced-authoring') assert.equal(runtime.ADVANCED_AUTHORING_API_VERSION, 1);
  }
  for (const [subpath, hash] of Object.entries(candidate.requiredStylesheets ?? {})) {
    const bytes = await readStyle(`${candidate.name}/${subpath}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `${subpath} stylesheet changed`);
  }
}
