import test from 'node:test';
import assert from 'node:assert/strict';
import {extendedToolsConfiguration} from '../dist/extended-tools-config.js';
test('main configuration enables tools independently without projecting credentials',async()=>{
 const defaults=await extendedToolsConfiguration({});assert.equal(defaults.web,true);assert.ok(defaults.browser);assert.ok(defaults.node);
 const disabled=await extendedToolsConfiguration({AI_STUDIO_WEB_TOOLS:'0',AI_STUDIO_BROWSER_TOOLS:'0',AI_STUDIO_NODE_TOOLS:'0',DEEPSEEK_API_KEY:'secret-canary'});assert.deepEqual(disabled,{web:false});assert.ok(!JSON.stringify(disabled).includes('secret-canary'));
 const configured=await extendedToolsConfiguration({AI_STUDIO_NODE_EXECUTABLE:'/reviewed/node',AI_STUDIO_BROWSER_EXECUTABLE:'/reviewed/chromium',AI_STUDIO_SEARCH_BASE_URL:'https://search.example/anthropic/v1',AI_STUDIO_SEARCH_MODEL:'reviewed-model'});
 assert.equal(configured.node.executablePath,'/reviewed/node');assert.equal(configured.browser.executablePath,'/reviewed/chromium');assert.equal(configured.search.model,'reviewed-model');
});
test('alternative browsers require explicit experimental admission and reject typos',async()=>{
 await assert.rejects(extendedToolsConfiguration({AI_STUDIO_BROWSER_BACKEND:'chrome-devtools'}),/EXPERIMENTAL_BROWSER/);
 await assert.rejects(extendedToolsConfiguration({AI_STUDIO_BROWSER_BACKEND:'typo'}),/Unknown/);
 const config=await extendedToolsConfiguration({AI_STUDIO_BROWSER_BACKEND:'chrome-devtools',AI_STUDIO_EXPERIMENTAL_BROWSER:'1'});
 assert.equal(config.browser.backend,'chrome-devtools');
});
