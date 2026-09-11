import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { deepseekHarness: { tag, commit } } = JSON.parse(await readFile(path.join(root, 'config', 'upstream', 'pins.json'), 'utf8'));
const output = path.join(root, 'docs', 'upstream', 'deepseek-harness');
const files = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
await mkdir(output, { recursive: true });
for (const name of files) {
  const url = `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${commit}/${name}`;
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const body = await response.text();
  await writeFile(path.join(output, `${name}.snapshot`), body, { encoding: 'utf8', flag: 'w' });
}
console.log(`[upstream] captured ${files.length} DeepSeek Harness files from ${tag}`);
