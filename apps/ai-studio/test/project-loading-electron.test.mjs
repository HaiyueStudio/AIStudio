import test from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,writeFile,readFile,mkdir}from'node:fs/promises';
import{tmpdir}from'node:os';
import path from'node:path';
import{spawn}from'node:child_process';
import{fileURLToPath}from'node:url';
import{build}from'esbuild';
import electron from'electron';
test('project loading paints before work, blocks duplicate opens and restores controls after completion, cancellation, error and teardown',{timeout:45000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'project-loading-ui-')),output=process.env.HAIYUE_M14_G09_OUTPUT?path.join(process.env.HAIYUE_M14_G09_OUTPUT,'project-loading'):path.join(root,'evidence');await mkdir(output,{recursive:true});
 await build({entryPoints:[fileURLToPath(new URL('./fixtures/project-loading-browser.mjs',import.meta.url))],outfile:path.join(root,'browser.js'),bundle:true,format:'esm',platform:'browser',target:'chrome140',logLevel:'silent'});
 await writeFile(path.join(root,'styles.css'),await readFile(new URL('../renderer/styles.css',import.meta.url)));
 await writeFile(path.join(root,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head><body data-theme="dark"><main id="app"><header><strong class="brand">HaiYue AIStudio</strong><button id="open-project">打开工程</button><button>保存</button></header><div style="display:grid;place-items:center;color:#8fa2b7">场景与工程</div><footer>Ready</footer></main><section id="play-page" hidden></section><script type="module" src="browser.js"></script></body></html>');
 const env={...process.env,HAIYUE_LOADING_ROOT:root,HAIYUE_LOADING_OUTPUT:output};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','DEEPSEEK_API_KEY','HAIYUE_STUDIO_DEEPSEEK_SECRET'])delete env[key];
 const result=await new Promise((resolve,reject)=>{const child=spawn(electron,[fileURLToPath(new URL('./fixtures/project-loading-main.mjs',import.meta.url))],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';const timer=setTimeout(()=>child.kill(),35000);child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,text});});});
 assert.equal(result.code,0,result.text);const receipt=JSON.parse(await readFile(path.join(output,'result.json'),'utf8'));assert.equal(receipt.painted,true);assert.equal(receipt.oneOperation,true);assert.equal(receipt.cancelledRecovered,true);assert.equal(receipt.failureRecovered,true);assert.equal(receipt.teardownSafe,true);
});
