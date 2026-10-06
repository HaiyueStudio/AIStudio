import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHarnessStudioRoot } from '../dist/index.js';
import { harnessOwnerContext } from '../dist/ownership.js';
import { createPinnedHarnessAgentTransport, createHarnessExtendedTools } from '../dist/harness-agent.js';
const input={sessionId:'session:browser',model:'deepseek-flash',reasoningEffort:'off',maxTokens:1024,tools:[],prompt:'Check controlled preview.',lastConfirmedOpId:'op:browser'};
test('real isolated Chromium starts lazily, navigates, interacts and cleans up',{timeout:60000},async t=>{
 const server=createServer((_req,res)=>res.end('<html><body><button onclick="this.textContent=\'Clicked\'">Try</button></body></html>'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const owner=createHarnessStudioRoot(),port=createHarnessExtendedTools({browser:{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}});
 const transport=await createPinnedHarnessAgentTransport({owner,officialTools:port,resolveApiKey:async()=>null});t.after(()=>owner.dispose());await transport.openSession(input);
 const ctx=harnessOwnerContext(owner),agent=ctx.agents.get(input.sessionId);assert.equal(ctx.tools.schemas(agent).filter(t=>t.name.startsWith('mcp__')).length,0);
 let i=0;const run=(toolId,args={})=>port.execute({sessionId:input.sessionId,turnId:'turn:browser',callId:`call:browser-${++i}`,toolId:`official.browser.${toolId}`,arguments:args},new AbortController().signal);
 await assert.rejects(run('navigate',{url:'file:///etc/passwd'}),/url-denied/);
 await assert.rejects(run('snapshot',{filename:'/private/tmp/unauthorized'}),/file-destination-denied/);
 const nav=await run('navigate',{url:`http://127.0.0.1:${server.address().port}/`});assert.match(JSON.stringify(nav),/Page URL/);
 const snapshot=await run('snapshot');assert.match(JSON.stringify(snapshot),/Try/);
 const click=await run('click',{target:'button'});assert.ok(click.content.length); assert.match(JSON.stringify(await run('snapshot')),/Clicked/);
 assert.ok(ctx.tools.schemas(agent).some(t=>t.name.startsWith('mcp__')));
 const second = 'session:browser-other'; await transport.openSession({...input,sessionId:second});
 const isolated=await port.execute({sessionId:second,turnId:'turn:other',callId:'call:other',toolId:'official.browser.snapshot',arguments:{}},new AbortController().signal);assert.doesNotMatch(JSON.stringify(isolated),/Clicked/);
 await transport.closeSession(input.sessionId);assert.equal(ctx.agents.get(input.sessionId),undefined);
 await transport.closeSession(second);
});

test('cancel during lazy MCP initialization drains and a new call can recreate the browser',{timeout:30000},async t=>{
 const owner=createHarnessStudioRoot(),port=createHarnessExtendedTools({browser:{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}});
 const transport=await createPinnedHarnessAgentTransport({owner,officialTools:port,resolveApiKey:async()=>null});t.after(()=>owner.dispose());await transport.openSession(input);
 const controller=new AbortController();const pending=assert.rejects(port.execute({sessionId:input.sessionId,turnId:'turn:init',callId:'call:init',toolId:'official.browser.snapshot',arguments:{}},controller.signal));
 const timer=setTimeout(()=>controller.abort(),20);try{await pending;}finally{clearTimeout(timer);}
 const value=await port.execute({sessionId:input.sessionId,turnId:'turn:retry',callId:'call:retry',toolId:'official.browser.snapshot',arguments:{}},new AbortController().signal);assert.ok(value.content.length);
});
