import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inputBinding,collectPackages } from '../../../../scripts/m14-capability-census.mjs';

const root=fileURLToPath(new URL('../../../../',import.meta.url)),output=new URL('./test-output/',import.meta.url),digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
await mkdir(output,{recursive:true});const before=await inputBinding(await collectPackages());
const checks=[];
for(const [id,files] of [['advanced-adapter',['packages/studio-shell/test/advanced-editor/*.test.mjs']],['existing-shell',['packages/studio-shell/test/*.test.mjs']]]) {
  const args=['--test','--test-reporter=tap',...files],start=performance.now();
  const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);const deadline=setTimeout(()=>child.kill(),90000);child.once('error',reject);child.once('close',code=>{clearTimeout(deadline);resolve({code,text});});});
  await writeFile(new URL(`${id}.tap`,output),result.text);assert.equal(result.code,0,result.text);const count=key=>Number(result.text.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]);for(const key of ['fail','skipped','cancelled'])assert.equal(count(key),0);assert.ok(count('pass')>0);
  checks.push({id,args,passed:count('pass'),failed:count('fail'),skipped:count('skipped'),cancelled:count('cancelled'),durationMs:Math.round(performance.now()-start),outputDigest:digest(result.text)});console.log(`[advanced-studio] ${id}: ${count('pass')} passed`);
}
const pins=JSON.parse(await readFile(path.join(root,'config/upstream/editor-candidates.json'),'utf8')),lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8')),candidates=[];
for(const candidate of pins.packages) {
  const hash=digest(await readFile(path.join(root,candidate.tarball)));assert.equal(hash,`sha256:${candidate.tarballSha256}`);
  const installed=JSON.parse(await readFile(path.join(root,'node_modules',candidate.name,'package.json'),'utf8'));assert.equal(installed.version,candidate.version);assert.equal(lock.packages[`node_modules/${candidate.name}`].integrity,candidate.integrity);
  candidates.push({name:candidate.name,version:candidate.version,tarball:candidate.tarball,digest:hash,integrity:candidate.integrity,exports:installed.exports});
}
assert.equal((await inputBinding(await collectPackages())).digest,before.digest,'AIStudio sources changed during verification');
await writeFile(new URL('checks.json',output),JSON.stringify({schemaVersion:1,status:'passed',mode:'user-directed-independent-g07-acceptance',verifiedAt:new Date().toISOString(),inputDigest:before.digest,productIntegrated:false,checks,candidates,lockfileDigest:digest(await readFile(path.join(root,'package-lock.json'))),fixtureDigest:digest(await readFile(new URL('studio-view.json',output)))},null,2)+'\n');
console.log(`[advanced-studio] ${before.digest}`);
