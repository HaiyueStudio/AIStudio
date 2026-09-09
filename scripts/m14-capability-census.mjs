import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import Ajv from 'ajv';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const censusFile = 'config/contracts/m14-capability-census.json';
export const reportFile = 'config/contracts/m14-capability-verification.json';
export const scopeFile = 'config/contracts/m14-capability-first-release.json';
export const sourcesFile = 'config/contracts/m14-capability-sources.json';
export const layers = ['upstream', 'document', 'runtime', 'tool', 'ui', 'verification'];
export const digest = value => `sha256:${createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex')}`;
export function canonical(value) {
  return JSON.stringify(value, (_, child) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b, 'en'))) : child);
}
export function localPath(relative) {
  assert.equal(typeof relative, 'string');
  assert.ok(relative.length && !relative.includes('\\') && !path.isAbsolute(relative) && !relative.split('/').some(p => p === '..' || p === '.'), `non-local path: ${relative}`);
  return path.join(root, relative);
}
export const readJson = async relative => JSON.parse(await readFile(localPath(relative), 'utf8'));
export const fileDigest = async relative => digest(await readFile(localPath(relative)));
export const reference = async (relative, kind = 'source', locator = '') => ({ path: relative, sha256: await fileDigest(relative), kind, locator });

async function walk(relative, includeDistribution = false) {
  const entries = await readdir(localPath(relative), { withFileTypes: true });
  const files = await Promise.all(entries.filter(e => !['node_modules', '.git', '.aistudio', 'coverage'].includes(e.name) && (includeDistribution || e.name !== 'dist')).map(e => e.isDirectory() ? walk(`${relative}/${e.name}`, includeDistribution) : e.isFile() ? [`${relative}/${e.name}`] : []));
  return files.flat();
}

/** Include test helpers, schemas, build configuration and public package bytes, not just test entry names. */
export async function inputBinding(packages) {
  const files = (await Promise.all(['packages', 'apps', 'scripts', 'config', 'vendor', 'evals/src', 'evals/fixtures', 'evals/schemas', 'evals/suites', 'evals/test'].map(p => walk(p)))).flat()
    .filter(p => ![censusFile, reportFile].includes(p) && !p.includes('/test-output/') && !p.endsWith('.tsbuildinfo'));
  files.push('package.json', 'package-lock.json', 'tsconfig.json', 'evals/manifest.json');
  const inputs = await Promise.all([...new Set(files)].sort().map(async p => [p, await fileDigest(p)]));
  return { algorithm: 'sha256', fileCount: inputs.length, sourceDigest: digest(inputs), packageDigest: digest(packages), digest: digest({ inputs, packages }) };
}

function targets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(targets);
}

export async function collectPackages() {
  const [manifest, lock, engine, render, editor, app] = await Promise.all(['package.json', 'package-lock.json', 'config/engine-candidate.json', 'config/render-extension-candidates.json', 'config/upstream/editor-candidates.json', 'apps/ai-studio/package.json'].map(readJson));
  const candidates = [engine, ...render.candidates.map(c => ({ ...c, sourceRevision: render.sourceRevision })), ...editor.packages.map(c => ({ ...c, package: c.name, sha256: c.tarballSha256 }))];
  const names = [...new Set([...candidates.map(c => c.package), '@haiyue/ui'])].sort();
  return Promise.all(names.map(async name => {
    const folder = `node_modules/${name}`;
    const installed = await readJson(`${folder}/package.json`);
    const locked = lock.packages[folder];
    assert.equal(installed.name, name);
    assert.equal(installed.version, locked?.version, `${name} installed/lock version mismatch`);
    assert.ok(locked.integrity, `${name} missing lock integrity`);
    const candidate = candidates.find(c => c.package === name);
    if (candidate) {
      assert.equal(manifest.dependencies[name], `file:${candidate.tarball}`, `${name} manifest candidate mismatch`);
      assert.equal(locked.resolved, `file:${candidate.tarball}`, `${name} lock candidate mismatch`);
      assert.equal(installed.version, candidate.version);
      assert.equal(locked.integrity, candidate.integrity);
      assert.equal(await fileDigest(candidate.tarball), `sha256:${candidate.sha256}`, `${name} tarball mismatch`);
      for (const entry of candidate.requiredExports) assert.ok(Object.hasOwn(installed.exports, entry), `${name} missing export ${entry}`);
    } else assert.equal(app.dependencies[name], installed.version, `${name} app pin mismatch`);
    const exports = await Promise.all(Object.entries(installed.exports).sort(([a], [b]) => a.localeCompare(b, 'en')).map(async ([subpath, conditions]) => ({
      subpath,
      targets: await Promise.all([...new Set(targets(conditions))].sort().map(async target => {
        assert.ok(target.startsWith('./') && !target.includes('*'), `${name} unsupported export target ${target}`);
        return { path: target, sha256: await fileDigest(`${folder}/${target.slice(2)}`) };
      })),
    })));
    // Bind internal declaration/runtime dependencies too, so editing a re-export target invalidates evidence.
    const installedFiles = (await walk(folder, true)).sort();
    assert.ok(installedFiles.some(p => p.startsWith(`${folder}/dist/`)), `${name} distribution content must be bound`);
    const contentDigest = digest(await Promise.all(installedFiles.map(async p => [p.slice(folder.length + 1), await fileDigest(p)])));
    return { name, version: installed.version, integrity: locked.integrity, manifestDigest: await fileDigest(`${folder}/package.json`), contentDigest, installedFileCount: installedFiles.length, sourceRevision: candidate?.sourceRevision ?? null, candidate: candidate?.tarball ?? null, exports };
  }));
}

function definitionCalls(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'definition' && ts.isStringLiteral(node.arguments[0])) calls.push(node.arguments);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

export async function collectRegistries() {
  // These are installed workspace public exports. Capture builds them before importing this module.
  const [{ ComponentRegistry }, { GAME_AUTHORING_TOOL_DEFINITIONS: definitions }] = await Promise.all([
    import('@haiyue/ai-studio-editor-plugins/components'), import('@haiyue/ai-studio-game-authoring-tools'),
  ]);
  const snapshot = new ComponentRegistry().snapshot();
  const sourceComponents = [];
  for (const [file, adapterIndex] of [['packages/editor-plugins/src/components/registry.ts', 7], ['packages/editor-plugins/src/render/components.ts', 6]]) {
    const calls = definitionCalls(await readFile(localPath(file), 'utf8'), file);
    for (const args of calls) sourceComponents.push({ type: args[0].text, capabilityId: args[1].text, runtimeAdapter: args[adapterIndex].kind === ts.SyntaxKind.NullKeyword ? null : args[adapterIndex].text, source: file });
  }
  const components = snapshot.definitions.map(d => {
    const source = sourceComponents.find(c => c.type === d.type);
    assert.ok(source, `registry type missing from current source ${d.type}`);
    assert.equal(source.capabilityId, d.capability);
    assert.equal(source.runtimeAdapter, d.runtimeAdapter);
    return { ...source, version: d.version, owner: d.owner, effect: d.effect, risk: d.risk, definitionDigest: digest(d), serialization: d.serialization, inspector: d.editor.inspector };
  });
  assert.equal(components.length, sourceComponents.length, 'source/installed registry count mismatch; rebuild');
  const toolSource = 'packages/game-authoring-tools/src/definitions.ts';
  const sourceTools = definitionCalls(await readFile(localPath(toolSource), 'utf8'), toolSource).map(args => args[0].text).sort();
  assert.deepEqual(definitions.map(d => d.id).sort(), sourceTools, 'source/installed tool ids mismatch; rebuild');
  const tools = definitions.map(d => ({ id: d.id, version: d.version, effect: d.effect, risk: d.risk, requiredCapabilities: d.requiredCapabilities, definitionDigest: digest(d), timeoutMs: d.timeoutMs, maxResultBytes: d.maxResultBytes })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return { componentDigest: snapshot.digest, components, tools, invocation: await reference('packages/game-authoring-tools/src/catalog/invocation.ts', 'source', 'studio.tool.invoke') };
}

export async function recordValidator() {
  const ajv = new Ajv({ strict: true, allErrors: true });
  ajv.addSchema(await readJson('config/contracts/schemas/m12-capability-id.schema.json'));
  return ajv.compile(await readJson('config/contracts/schemas/m14-capability-surface-record-v1.schema.json'));
}

export function checkReport(report, binding, checks) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.inputDigest, binding.digest, 'stale verification input binding; run m14:capability:capture');
  assert.deepEqual(report.checks.map(c => c.id).sort(), checks.map(c => c.id).sort(), 'verification check coverage mismatch');
  for (const check of checks) {
    const result = report.checks.find(c => c.id === check.id);
    assert.equal(result.kind, 'local-check', 'G01 does not grant adapter/product acceptance');
    assert.deepEqual(result.args, ['--test', '--test-reporter=tap', ...check.files]);
    assert.equal(result.exitCode, 0, `${check.id} failed`);
    assert.ok(Number.isInteger(result.passed) && result.passed > 0, `${check.id} has no executed tests`);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.cancelled, 0);
    assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
    assert.match(result.outputDigest, /^sha256:[a-f0-9]{64}$/);
  }
}

export function validateScope(scope, census) {
  assert.equal(scope.schemaVersion, 1);
  assert.equal(scope.owner, 'g01-capability-surface-census');
  const ids = new Set(census.records.map(r => r.capabilityId));
  assert.equal(new Set(scope.capabilityIds).size, scope.capabilityIds.length);
  for (const id of scope.capabilityIds) assert.ok(ids.has(id), `unknown first-release capability ${id}`);
  assert.ok(scope.g08.selected.length <= 2, 'G08 permits at most two existing adapter blockers');
  assert.equal(scope.g08.maxBlockers, 2);
  assert.ok(scope.g08.reason.length > 20);
  assert.equal(new Set(scope.g08.selected.map(x => x.capabilityId)).size, scope.g08.selected.length);
  for (const item of scope.g08.selected) {
    assert.ok(scope.capabilityIds.includes(item.capabilityId), 'G08 capability outside frozen first release');
    const component = census.registry.components.find(c => c.capabilityId === item.capabilityId && c.runtimeAdapter === item.adapterId);
    assert.ok(component, `G08 adapter must already exist: ${item.adapterId}`);
    assert.equal(item.source, component.source);
    for (const key of ['gap', 'owner', 'verificationEntry', 'deferredReason']) assert.ok(typeof item[key] === 'string' && item[key].length, `G08 missing ${key}`);
    assert.ok(Number.isInteger(item.maxInstances) && item.maxInstances > 0 && Number.isFinite(item.maxRuntimeMs) && item.maxRuntimeMs > 0, 'G08 missing numeric budget');
  }
  assert.deepEqual(scope.corpus.map(c => c.kind).sort(), ['mixed', 'pure-declarative', 'pure-script']);
  for (const entry of scope.corpus) {
    assert.ok(entry.existingEvidence.length && entry.requiredAssertions.length);
    assert.equal(entry.owner, 'g05-entity-logic-explorer-runtime-trace');
    assert.ok(entry.maxEntities > 0 && entry.maxScripts >= 0 && entry.maxTicks > 0);
    if (entry.kind === 'pure-declarative') assert.equal(entry.maxScripts, 0);
    if (entry.kind === 'mixed') assert.ok(entry.maxScripts > 0 && entry.componentTypes.length > 0);
    for (const type of entry.componentTypes) assert.ok(census.registry.components.some(c => c.type === type), `unknown corpus component ${type}`);
  }
}

export function validateAdmission(record, report) {
  for (const id of record.acceptance.adapterCheckIds) assert.ok(report.checks.some(c => c.id === id && c.kind === 'adapter-acceptance' && c.capabilityIds?.includes(record.capabilityId) && c.exitCode === 0), 'unproven adapter acceptance');
  for (const id of record.acceptance.productCheckIds) assert.ok(report.checks.some(c => c.id === id && c.kind === 'product-acceptance' && c.capabilityIds?.includes(record.capabilityId) && c.exitCode === 0), 'unproven product acceptance');
  if (record.stage !== 'implementation-present') assert.ok(record.acceptance.adapterCheckIds.length > 0, 'adapter-ready requires explicit adapter acceptance');
  if (record.stage === 'product-integrated') {
    assert.ok(record.acceptance.productCheckIds.length > 0, 'product-integrated requires explicit product acceptance');
    for (const name of layers) assert.equal(record.layers[name].state, 'current', `product-integrated missing current ${name}`);
  }
}

export async function generateCensus(report) {
  const [packages, registry, sources, scope, capabilitySchema, validate] = await Promise.all([collectPackages(), collectRegistries(), readJson(sourcesFile), readJson(scopeFile), readJson('config/contracts/schemas/m12-capability-id.schema.json'), recordValidator()]);
  const binding = await inputBinding(packages);
  checkReport(report, binding, sources.checks);
  const configuredIds = sources.groups.flatMap(g => g.capabilityIds).sort();
  assert.deepEqual(configuredIds, [...capabilitySchema.enum].sort(), 'census mapping must cover exactly the existing M12 union');
  for (const component of registry.components) assert.ok(configuredIds.includes(component.capabilityId));
  const toolIds = new Set(registry.tools.map(t => t.id));
  const records = [];
  for (const group of sources.groups) for (const capabilityId of group.capabilityIds) {
    const components = registry.components.filter(c => c.capabilityId === capabilityId);
    const mappedTools = [...new Set([...group.toolIds, ...(components.length ? sources.componentToolIds : []), ...registry.tools.filter(t => t.requiredCapabilities.includes(capabilityId)).map(t => t.id)])].sort();
    for (const id of mappedTools) assert.ok(toolIds.has(id), `unknown tool binding ${id}`);
    const evidence = {};
    for (const layer of layers) {
      let refs = [];
      if (layer === 'upstream') {
        for (const entry of group.upstream) {
          const pkg = packages.find(p => p.name === entry.package);
          assert.ok(pkg?.exports.some(e => e.subpath === entry.subpath), `missing public export ${entry.package}${entry.subpath}`);
          refs.push(await reference(`node_modules/${entry.package}/package.json`, 'public-export', entry.subpath));
        }
      } else if (layer === 'tool') {
        if (mappedTools.length) refs.push(await reference('packages/game-authoring-tools/src/definitions.ts', 'source', mappedTools.join(',')), registry.invocation);
      } else if (layer === 'verification') {
        for (const checkId of group.checkIds) {
          assert.ok(report.checks.some(c => c.id === checkId));
          refs.push(await reference(reportFile, 'local-check', checkId));
        }
        // Historical provenance is retained, but never promoted by merely hashing the old file today.
        refs.push(await reference('config/contracts/m12-capability-census.json', 'historical', capabilityId));
      } else {
        refs = await Promise.all(group[layer].map(p => reference(p)));
        if (layer === 'document') for (const source of [...new Set(components.map(c => c.source))]) refs.push(await reference(source, 'source', components.filter(c => c.source === source).map(c => c.type).join(',')));
      }
      evidence[layer] = { owner: group.owners[layer], state: !refs.length ? 'missing' : refs.every(r => r.kind === 'historical') ? 'stale' : 'current', references: refs,
        explanation: layer === 'verification' ? 'Current local regression evidence, when present, is not formal adapter or product acceptance. The M12 census remains historical.' : layer === 'document' ? 'Source coverage includes document persistence/migration when linked. Registry serialization descriptors alone do not prove round-trip.' : layer === 'upstream' ? 'Exact installed export surface; semantic coverage is limited to the linked implementation. No claim of full upstream API support.' : 'Current source or registry association; no inference of UI, runtime or formal acceptance from file existence.' };
    }
    const record = { schemaVersion: 1, capabilityId, stage: 'implementation-present', componentTypes: components.map(c => c.type), toolIds: mappedTools, layers: evidence, acceptance: { adapterCheckIds: [], productCheckIds: [] }, limitations: group.limitations };
    assert.ok(validate(record), `${capabilityId}: ${JSON.stringify(validate.errors)}`);
    validateAdmission(record, report);
    records.push(record);
  }
  const mapped = new Set(records.flatMap(r => r.toolIds));
  for (const id of toolIds) assert.ok(mapped.has(id), `uncensused registered tool ${id}`);
  const census = { schemaVersion: 1, purpose: 'offline-derived-census-not-runtime-registry', binding, packages, registry, records: records.sort((a, b) => a.capabilityId.localeCompare(b.capabilityId, 'en')) };
  validateScope(scope, census);
  for (const entry of scope.corpus) for (const p of entry.existingEvidence) await fileDigest(p);
  return census;
}
