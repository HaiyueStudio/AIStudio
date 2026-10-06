import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessStudioRoot } from '../dist/index.js';
import { harnessOwnerContext } from '../dist/ownership.js';
import { createPinnedHarnessAgentTransport, createHarnessExtendedTools } from '../dist/harness-agent.js';
const input = { sessionId: 'session:web', model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 1024, tools: [], prompt: 'Read public sources.', lastConfirmedOpId: 'op:web' };
async function fixture(t, resolveApiKey = async () => 'fixture-credential') {
 const owner = createHarnessStudioRoot(), port = createHarnessExtendedTools();
 const transport = await createPinnedHarnessAgentTransport({ owner, officialTools: port, resolveApiKey });
 t.after(() => owner.dispose()); await transport.openSession(input); let sequence = 0;
 return { port, transport, owner, run: (toolId, args, signal = new AbortController().signal, turnId = 'turn:web') => port.execute({ sessionId: input.sessionId, turnId, callId: `call:web-${++sequence}`, toolId, arguments: args }, signal) };
}
test('official search uses credential resolver, independent Messages route, bounded sources and turn-local cache', async t => {
 const f = await fixture(t); let requests = 0;
 t.mock.method(globalThis, 'fetch', async (url, init) => {
  requests++; assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/messages'); assert.equal(init.headers['x-api-key'], 'fixture-credential');
  const body = JSON.parse(init.body); assert.equal(body.model, 'deepseek-flash'); assert.equal(body.max_tokens, 2048); assert.equal(body.tools[0].max_uses, 1);
  return new Response(JSON.stringify({ content: [{ type: 'web_search_tool_result', content: Array.from({length:8},(_,i)=>({ type:'web_search_result',url:`https://example.com/${i}`,title:`Source ${i}` })) }] }), {status:200});
 });
 const a = await f.run('official.web.search', {query:'official documentation',maxResults:2}); assert.equal(a.sources.length,2); assert.equal(a.truncated,true); assert.equal(a.auxiliaryUsage.cost,null);
 const b = await f.run('official.web.search',{query:'official documentation',maxResults:2}); assert.equal(b.cached,true); assert.equal(requests,1);
 await f.run('official.web.search',{query:'official documentation',maxResults:2},undefined,'turn:second'); assert.equal(requests,2);
});
test('missing credentials never dispatch; HTTP provider rejects private URLs and credentials', async t => {
 const f=await fixture(t,async()=>null); t.mock.method(globalThis,'fetch',()=>{ throw new Error('unexpected network'); });
 assert.equal((await f.run('official.web.search',{query:'test'})).code,'official.web.credentials-missing');
 for (const url of ['http://127.0.0.1/','http://localhost/','file:///etc/passwd','https://user:password@example.com/']) {
  const result=await f.run('official.web.fetch',{url}); assert.equal(result.status,'error'); assert.match(result.code,/^WEB_/);
 }
});
test('search errors omit raw provider text and cancellation drains', async t => {
 const f=await fixture(t); t.mock.method(globalThis,'fetch',async()=>new Response('Bearer PRIVATE_CANARY',{status:429}));
 const result=await f.run('official.web.search',{query:'failure'}); assert.equal(result.status,'error'); assert.ok(!JSON.stringify(result).includes('PRIVATE_CANARY'));
 const entered=Promise.withResolvers();
 t.mock.method(globalThis,'fetch',(_url,init)=>new Promise((_,reject)=>{entered.resolve();init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});}));
 const controller=new AbortController(); const pending=assert.rejects(f.run('official.web.search',{query:'cancel'},controller.signal)); await entered.promise; controller.abort(); await pending;
});

test('capability configuration is frozen and browser schemas are reviewed without starting processes',()=>{
 const options={web:true,browser:{},node:{}};const port=createHarnessExtendedTools(options);options.web=false;
 assert.ok(port.definitions.some(d=>d.id==='official.web.search'));assert.ok(port.definitions.some(d=>d.id==='official.code.run'));
 assert.ok(port.definitions.some(d=>d.id==='official.browser.navigate'));assert.ok(port.definitions.every(d=>!d.id.includes('unsafe')&&!d.id.includes('file_upload')));
 assert.equal(port.definitions.find(d=>d.id==='official.code.run').requiresApproval,true);
 assert.throws(()=>createHarnessExtendedTools({web:true,search:{baseURL:'https://user:secret@example.com'}}),/endpoint-invalid/);
 assert.deepEqual(createHarnessExtendedTools({web:false,search:{baseURL:'invalid disabled route'}}).definitions,[]);
});


test('Web provider loads on first use and concurrent equivalent searches use one HTTP request',async t=>{
 const f=await fixture(t),ctx=harnessOwnerContext(f.owner);assert.equal(ctx.tools.get('official_web_search'),undefined);
 let requests=0;const entered=Promise.withResolvers(),release=Promise.withResolvers();
 t.mock.method(globalThis,'fetch',async()=>{requests++;entered.resolve();await release.promise;return new Response(JSON.stringify({content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.com',title:'Evidence'}]}]}));});
 const one=f.run('official.web.search',{query:'same'}),two=f.run('official.web.search',{maxResults:5,query:'same'});
 await entered.promise;await new Promise(setImmediate);assert.equal(requests,1);release.resolve();
 const values=await Promise.all([one,two]);assert.deepEqual(values.map(v=>v.cached),[false,true]);assert.ok(ctx.tools.get('official_web_search'));
});

test('a reused provider installs fresh services and cache under a new owner',async t=>{
 const f=await fixture(t);let requests=0;
 t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(JSON.stringify({content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.com',title:'Evidence'}]}]}));});
 await f.run('official.web.search',{query:'rebind'});await f.owner.dispose();
 const owner=createHarnessStudioRoot();t.after(()=>owner.dispose());
 const transport=await createPinnedHarnessAgentTransport({owner,officialTools:f.port,resolveApiKey:async()=> 'fixture-credential'});await transport.openSession(input);
 const result=await f.run('official.web.search',{query:'rebind'});assert.equal(result.status,'completed');assert.equal(result.cached,false);assert.equal(requests,2);
});
