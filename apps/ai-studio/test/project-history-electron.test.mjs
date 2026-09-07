import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import electronPath from 'electron';
import { build } from 'esbuild';

test('real Electron history viewer expands complete details, pages and switches projects', { timeout: 75_000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'haiyue-project-history-ui-'));
  const entry = fileURLToPath(new URL('../../../packages/studio-shell/dist/index.js', import.meta.url));
  await build({ stdin: { contents: browserSource(entry), resolveDir: path.dirname(entry), sourcefile: 'project-history.ts' }, outfile: path.join(output, 'app.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome132' });
  const styles = await readFile(new URL('../renderer/styles.css', import.meta.url), 'utf8');
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}body{height:100vh;padding:16px}main{height:100%;max-width:480px;margin:auto;border:1px solid #263447;background:#111923}</style><main><div id="agent-history-viewer"></div></main><script type="module" src="./app.js"></script></html>`);
  const fixture = fileURLToPath(new URL('./fixtures/project-history-electron-main.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [fixture], { env: { ...process.env, HAIYUE_HISTORY_UI_ROOT: output }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { text += chunk; });
    child.once('error', reject); child.once('exit', code => resolve({ code, text }));
  });
  assert.equal(result.code, 0, result.text);
  const screenshot = path.join(output, 'project-history.png');
  assert.ok((await readFile(screenshot)).byteLength > 10_000);
  console.log(`History screenshot: ${screenshot}`);
});

function browserSource(entry) { return `
import { AgentHistoryViewer } from ${JSON.stringify(entry.replaceAll('\\', '/'))};
const root = document.querySelector('#agent-history-viewer');
const record = (projectId,id) => ({schemaVersion:1,projectId,id,kind:'tool-result',status:'completed',sessionId:'session:ui',turnId:'turn:ui',toolId:'scene.query',startedAt:'2026-09-06T08:20:00.000Z',finishedAt:'2026-09-06T08:20:00.137Z',durationMs:137,dataArtifactId:'artifact:sha256:'+'a'.repeat(64)});
const longResult='完整结果'.repeat(2000);
const viewer = new AgentHistoryViewer(root, {
  async query(projectId,cursor) { return {schemaVersion:1,projectId,records:projectId==='project:b'?[]:[record(projectId,cursor?'record:earlier':'record:latest')],total:projectId==='project:b'?0:2,nextCursor:cursor||projectId==='project:b'?null:'next',storage:'project'}; },
  async detail(projectId,id) { return {schemaVersion:1,projectId,record:record(projectId,id),data:{parameters:{revision:12,request:{entityId:'entity:player',fields:['transform','components']}},result:{status:'completed',entity:{name:'Player',position:{x:0,y:1,z:0}},fullText:longResult},source:'fixture'}}; }
});
const waitFor=async test => { const end=Date.now()+5000; while(!test()){if(Date.now()>end)throw new Error('History UI assertion timeout');await new Promise(resolve=>setTimeout(resolve,20));} };
const button=text => [...root.querySelectorAll('button')].find(node=>node.textContent===text);
try {
  viewer.setProject('project:a');await waitFor(()=>root.querySelector('[data-record-id="record:latest"]'));
  const summary=root.querySelector('summary');summary.focus();summary.click();
  await waitFor(()=>root.querySelector('pre')?.textContent.includes('entity:player'));
  if(!root.textContent.includes(longResult)||!root.textContent.includes('137 ms'))throw new Error('Full data or timing lost');
  button('下一页').click();await waitFor(()=>root.querySelector('[data-record-id="record:earlier"]'));
  button('上一页').click();await waitFor(()=>root.querySelector('[data-record-id="record:latest"]'));
  viewer.setProject('project:b');await waitFor(()=>root.textContent.includes('还没有 Agent'));
  if(root.textContent.includes('entity:player')||root.querySelector('details'))throw new Error('Foreign project data remains');
  viewer.setProject('project:a');await waitFor(()=>root.querySelector('summary'));root.querySelector('summary').click();await waitFor(()=>root.querySelectorAll('pre').length===3);
  if(root.scrollWidth>root.clientWidth+1)throw new Error('History panel overflows horizontally');
  document.body.dataset.historyStatus='passed';
} catch(cause){document.body.dataset.historyError=String(cause);document.body.dataset.historyStatus='failed';}
`; }
