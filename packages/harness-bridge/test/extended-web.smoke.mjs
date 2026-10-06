import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarnessStudioRoot} from '../dist/index.js';
import {createHarnessExtendedTools,createPinnedHarnessAgentTransport} from '../dist/harness-agent.js';
test('official HTTP provider fetches a real public page without credentials',{timeout:30000},async t=>{
 const owner=createHarnessStudioRoot(),port=createHarnessExtendedTools();const transport=await createPinnedHarnessAgentTransport({owner,officialTools:port,resolveApiKey:async()=>null});t.after(()=>owner.dispose());
 await transport.openSession({sessionId:'session:web-live',model:'deepseek-flash',reasoningEffort:'off',maxTokens:1024,tools:[],prompt:'Read example public page',lastConfirmedOpId:'op:web-live'});
 const result=await port.execute({sessionId:'session:web-live',turnId:'turn:web-live',callId:'call:web-live',toolId:'official.web.fetch',arguments:{url:'https://example.com'}},AbortSignal.timeout(20000));assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.statusCode,200);assert.match(result.content,/Example Domain/);
});
