import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';
test('Basic transparency composites consistently in edit and isolated Play, including legacy alpha and explicit opacity',{timeout:120000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'haiyue-basic-transparency-'));
 await build({entryPoints:[fileURLToPath(new URL('./fixtures/basic-transparency-browser.mjs',import.meta.url))],outfile:path.join(root,'basic-transparency.js'),bundle:true,platform:'browser',format:'iife'});
 let html=await readFile(new URL('./fixtures/g12-preview-host.html',import.meta.url),'utf8');
 html=html.replace('<body>','<body><div id="preview-test" style="position:relative;width:640px;height:480px"></div>').replace('document.body.append(frame)',"document.getElementById('preview-test').append(frame)").replace("script-src 'unsafe-inline'", "script-src 'self' 'unsafe-inline'; connect-src data:").replace("style-src 'unsafe-inline'", "style-src 'self' 'unsafe-inline'").replaceAll('393','640').replaceAll('852','480').replace('</body>','<script src="basic-transparency.js"></script></body>');
 await writeFile(path.join(root,'host.html'),html);
 const result=await new Promise((resolve,reject)=>{const env={...process.env,HAIYUE_MATERIAL_TEST_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[fileURLToPath(new URL('./fixtures/basic-transparency-main.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();reject(Error(output+'\n'+root))},105000);child.stdout.on('data',c=>{output+=c;process.stdout.write(c)});child.stderr.on('data',c=>{output+=c;process.stderr.write(c)});child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);resolve({code,output})})});
 assert.equal(result.code,0,result.output+'\n'+root);console.log(result.output);
});
