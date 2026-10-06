import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHarnessStudioRoot } from '../dist/index.js';
import { createPinnedHarnessAgentTransport, createHarnessExtendedTools } from '../dist/harness-agent.js';
const input={sessionId:'session:node',model:'deepseek-flash',reasoningEffort:'off',maxTokens:1024,tools:[],prompt:'Run isolated calculations.',lastConfirmedOpId:'op:node'};
async function fixture(t){const owner=createHarnessStudioRoot(),port=createHarnessExtendedTools({node:{...(process.env.AI_STUDIO_NODE_EXECUTABLE ? {executablePath:process.env.AI_STUDIO_NODE_EXECUTABLE}: {})}});const transport=await createPinnedHarnessAgentTransport({owner,officialTools:port,resolveApiKey:async()=>null});t.after(()=>owner.dispose());await transport.openSession(input);let i=0;return {transport,run:(code,other={},signal=new AbortController().signal)=>port.execute({sessionId:input.sessionId,turnId:'turn:node',callId:`call:node-${++i}`,toolId:'official.code.run',arguments:{code,...other}},signal)};}
test('official Node PTC computes, captures bounded files and clears the environment', {timeout:20000},async t=>{
 const f=await fixture(t); const result=await f.run('const input = await inputs.read({}); const fs = await import("node:fs/promises"); await fs.writeFile("answer.txt", String(input.a+input.b)); console.log("calculated"); return {sum:input.a+input.b, env:Object.keys(process.env)};', {input:{a:2,b:3}});
 assert.equal(result.status,'completed',JSON.stringify(result)); assert.deepEqual(result.value,{sum:5,env:[]}); assert.equal(result.files[0].content,'5');
});
test('restricted Node denies external reads/writes, network and subprocess creation', {timeout:30000},async t=>{
 const f=await fixture(t); let networkRequests=0; const server=createServer((_req,res)=>{networkRequests++;res.end('unexpected');}); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const code of ['return await (await import("node:fs/promises")).readFile("/etc/passwd","utf8");','await (await import("node:fs/promises")).writeFile("/private/tmp/aistudio-forbidden-write", "forbidden"); return true;',`return await (await fetch("http://127.0.0.1:${server.address().port}")).text();`,'return (await import("node:child_process")).execSync("echo unsafe").toString();']) {
 const result=await f.run(code,{timeoutMs:2000});assert.equal(result.status,'error',JSON.stringify(result));
 }
 assert.equal(networkRequests,0);
});
test('Node timeout, cancellation and output cap settle without late success',{timeout:30000},async t=>{
 const f=await fixture(t);assert.equal((await f.run('while(true){}',{timeoutMs:200})).code,'official.node.timeout');
 assert.equal((await f.run('return "x".repeat(100000);')).code,'official.node.output-limit');
 const controller=new AbortController();const pending=assert.rejects(f.run('while(true){}',{},controller.signal));const timer=setTimeout(()=>controller.abort(),200);try { await pending; } finally { clearTimeout(timer); }
});
