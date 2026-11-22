import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import electron from 'electron';
import {fileURLToPath} from 'node:url';

test('production QR dialog renders the public UI component, refreshes stale links and cancels late starts', {timeout:60000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'haiyue-mobile-qr-')),output=process.env.HAIYUE_M14_G09_OUTPUT?path.join(process.env.HAIYUE_M14_G09_OUTPUT,'mobile-qr'):path.join(root,'evidence');await mkdir(output,{recursive:true});
 await build({entryPoints:[fileURLToPath(new URL('./fixtures/mobile-preview-ui-browser.mjs',import.meta.url))],outfile:path.join(root,'browser.js'),bundle:true,format:'esm',platform:'browser',target:'chrome140',logLevel:'silent'});
 for(const name of ['styles.css','haiyue-light.css','haiyue-dark.css'])await writeFile(path.join(root,name),await readFile(new URL('../dist/'+name,import.meta.url)));
 const markup=await readFile(new URL('../renderer/index.html',import.meta.url),'utf8'),share=markup.match(/<hy-tooltip\b[^>]*>\s*<button id="play-share"[^>]*>[\s\S]*?<\/button>\s*<\/hy-tooltip>/u)?.[0];assert.ok(share,'Production share tooltip markup is required');
 await writeFile(path.join(root,'index.html'),`<!doctype html><html lang="zh-CN" data-hy-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="haiyue-light.css"><link rel="stylesheet" href="haiyue-dark.css"><link rel="stylesheet" href="styles.css"></head><body data-theme="dark"><div class="play-toolbar">${share}</div><script type="module" src="browser.js"></script></body></html>`);
 const env={...process.env,HAIYUE_MOBILE_QR_ROOT:root,HAIYUE_MOBILE_QR_OUTPUT:output};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 const result=await new Promise((resolve,reject)=>{const child=spawn(electron,[fileURLToPath(new URL('./fixtures/mobile-preview-ui-main.mjs',import.meta.url))],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';const timer=setTimeout(()=>child.kill(),50000);child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,text});});});
 assert.equal(result.code,0,result.text);const receipt=JSON.parse(await readFile(path.join(output,'result.json'),'utf8'));assert.equal(receipt.qr.status,'ready');assert.ok(receipt.qr.modules>20);assert.equal(receipt.cancelled,true);assert.equal(receipt.staleCleared,true);assert.equal(receipt.noAutomaticStart,true);assert.equal(receipt.iconOnly,true);assert.equal(receipt.tooltipDelayMs,1000);
});
