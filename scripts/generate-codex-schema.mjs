import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'docs', 'upstream', 'codex');
const jsonOut = path.join(outputRoot, 'app-server-schema-0.148.0');
const typeScriptOut = path.join(outputRoot, 'app-server-types-0.148.0');
for (const output of [jsonOut, typeScriptOut]) {
  if (!output.startsWith(`${outputRoot}${path.sep}`)) throw new Error(`Refusing unsafe generated output ${output}`);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
}
const executable = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
for (const [command, output] of [['generate-json-schema', jsonOut], ['generate-ts', typeScriptOut]]) {
  const result = spawnSync(process.execPath, [executable, 'app-server', command, '--experimental', '--out', output], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) throw new Error(`Codex ${command} failed (${result.status}): ${result.stderr || result.stdout}`);
}
console.log(`[codex] generated App Server JSON Schema and TypeScript at ${path.relative(root, outputRoot)}`);
