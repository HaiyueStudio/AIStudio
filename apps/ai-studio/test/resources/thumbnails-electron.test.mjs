import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';
test('project inventory renders engine meshes, material spheres and controlled PNG thumbnails in sandboxed Electron',{timeout:120000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'haiyue-resource-thumbnails-'));
 await build({entryPoints:[fileURLToPath(new URL('./thumbnails-browser.mjs',import.meta.url))],outfile:path.join(directory,'panel.js'),bundle:true,platform:'browser',format:'esm'});
 await copyFile(new URL('../../../../packages/studio-shell/src/panels/resources/resources.css',import.meta.url),path.join(directory,'resources.css'));
 await writeFile(path.join(directory,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('resourceBridge',{query:q=>ipcRenderer.invoke('query',q),read:id=>ipcRenderer.invoke('read',id)});`);
 await writeFile(path.join(directory,'host.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'"><link rel="stylesheet" href="resources.css"></head><body style="margin:0;background:#151b25"><main></main><script type="module" src="panel.js"></script></body></html>`);
 const result=await new Promise((resolve,reject)=>{const env={...process.env,HAIYUE_RESOURCE_TEST_ROOT:directory};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[fileURLToPath(new URL('./thumbnails-main.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();reject(Error(output+'\n'+directory))},105000);child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);resolve({code,output})})});
 assert.equal(result.code,0,result.output);console.log(result.output);
});
