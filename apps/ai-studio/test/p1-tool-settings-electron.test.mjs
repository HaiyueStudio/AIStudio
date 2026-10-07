import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import electron from 'electron';
test('P1 settings expose environment reasons, persist explicit switches and stay usable at narrow width',{timeout:45_000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'studio-p1-settings-'));
 await build({entryPoints:[fileURLToPath(new URL('./fixtures/tool-settings-browser.mjs',import.meta.url))],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'esm',target:'chrome132'});
 const css=await readFile(new URL('../renderer/styles.css',import.meta.url),'utf8');
 await writeFile(path.join(directory,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body{display:block;height:auto;background:#171921;padding:8px;box-sizing:border-box}main{max-width:100%}fieldset{min-width:0}input[type=checkbox]{width:18px}p,span{overflow-wrap:anywhere}</style></head><body><main class="settings-form"></main><script type="module" src="app.js"></script></body></html>`);
 const env={...process.env,HAIYUE_TOOL_SETTINGS_ROOT:directory};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 const result=await new Promise((resolve,reject)=>{const child=spawn(electron,[fileURLToPath(new URL('./fixtures/tool-settings-main.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>child.kill(),35000);child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,output});});});
 assert.equal(result.code,0,result.output);console.log(result.output);
});
