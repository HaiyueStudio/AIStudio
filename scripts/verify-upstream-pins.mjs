import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(await readFile(path.join(root, 'config', 'upstream', 'pins.json'), 'utf8'));
const compatibility = JSON.parse(await readFile(path.join(root, 'config', 'upstream', 'compatibility.json'), 'utf8'));
const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const bridgePackage = JSON.parse(await readFile(path.join(root, 'packages', 'harness-bridge', 'package.json'), 'utf8'));

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const packageKey = (name) => `node_modules/${name}`;

assert.match(pins.deepseekHarness.tag, /^dsh-v\d+\.\d+\.\d+-rc\.\d+$/);
assert.match(pins.deepseekHarness.commit, /^[0-9a-f]{40}$/);
assert.equal(pins.deepseekHarness.commit.startsWith('99f6f02'), true);
assert.equal(pins.deepseekHarness.license, 'MIT');

for (const snapshot of pins.deepseekHarness.snapshots) {
  const contents = await readFile(path.join(root, snapshot.path));
  assert.equal(sha256(contents), snapshot.sha256, `${snapshot.path} digest changed`);
}

for (const packagePin of pins.deepseekHarness.packages) {
  assert.equal(bridgePackage.dependencies[packagePin.name], packagePin.version, `${packagePin.name} bridge version is not exact`);
  const installed = lock.packages[packageKey(packagePin.name)];
  assert.ok(installed, `${packagePin.name} is absent from package-lock.json`);
  assert.equal(installed.version, packagePin.version, `${packagePin.name} lock version changed`);
  assert.equal(installed.integrity, packagePin.integrity, `${packagePin.name} integrity changed`);
  const manifest = JSON.parse(await readFile(path.join(root, packageKey(packagePin.name), 'package.json'), 'utf8'));
  for (const field of compatibility.deepseekHarness.requiredPackageFields) {
    if (packagePin.name === '@deepseek-ai/cordis' && field === 'exports') continue;
    assert.ok(manifest[field], `${packagePin.name} is missing ${field}`);
  }
}

assert.equal(rootPackage.devDependencies[pins.codex.package], pins.codex.version);
const codexLocked = lock.packages[packageKey(pins.codex.package)];
assert.equal(codexLocked.version, pins.codex.version);
assert.equal(codexLocked.integrity, pins.codex.integrity);
const codexManifest = JSON.parse(await readFile(path.join(root, packageKey(pins.codex.package), 'package.json'), 'utf8'));
assert.equal(codexManifest.version, pins.codex.version);
assert.equal(codexManifest.license, pins.codex.license);

const schemaRoot = path.join(root, pins.codex.schemaPath);
for (const relative of compatibility.codexAppServer.requiredSchemaFiles) {
  assert.equal((await stat(path.join(schemaRoot, relative))).isFile(), true, `missing Codex schema ${relative}`);
}

async function treeDigest(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else files.push(target);
    }
  }
  await walk(directory);
  files.sort((left, right) => left.localeCompare(right, 'en'));
  const treeHash = createHash('sha256');
  for (const file of files) {
    const relative = path.relative(directory, file).replaceAll('\\', '/');
    treeHash.update(relative);
    treeHash.update('\0');
    treeHash.update(sha256(await readFile(file)));
    treeHash.update('\n');
  }
  return { fileCount: files.length, digest: treeHash.digest('hex') };
}

const schemaTree = await treeDigest(schemaRoot);
assert.equal(schemaTree.fileCount, pins.codex.schemaFileCount);
assert.equal(schemaTree.digest, pins.codex.schemaTreeSha256, 'Codex generated schema tree changed');
const typeScriptTree = await treeDigest(path.join(root, pins.codex.typeScriptPath));
assert.equal(typeScriptTree.fileCount, pins.codex.typeScriptFileCount);
assert.equal(typeScriptTree.digest, pins.codex.typeScriptTreeSha256, 'Codex generated TypeScript tree changed');

const protocol = await readFile(path.join(schemaRoot, 'codex_app_server_protocol.schemas.json'), 'utf8');
for (const method of compatibility.codexAppServer.requiredProtocolMethods) {
  assert.ok(protocol.includes(`"${method}"`), `Codex protocol no longer contains ${method}`);
}

function dependencySpecs(manifest) {
  const values = [];
  const visit = (value) => {
    if (typeof value === 'string') values.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides']) {
    visit(manifest[field]);
  }
  return values;
}

for (const spec of [...dependencySpecs(rootPackage), ...dependencySpecs(bridgePackage)]) {
  assert.doesNotMatch(spec, /^(?:latest|master|main|\*|workspace:\*)$/i, `floating dependency specifier: ${spec}`);
}
console.log(`[upstream] DSH ${pins.deepseekHarness.tag}@${pins.deepseekHarness.commit.slice(0, 12)}, Codex ${pins.codex.version}, schemas=${schemaTree.fileCount}, types=${typeScriptTree.fileCount}`);
