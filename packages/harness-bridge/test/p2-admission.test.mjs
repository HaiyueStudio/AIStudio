import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessExtendedTools, HARNESS_EXPERIMENTAL_ADMISSION } from '../dist/harness-agent.js';
test('unadmitted browser backends never silently fall back to another provider',()=>{
 for(const backend of ['stagehand','stagehand-native','typo'])assert.throws(()=>createHarnessExtendedTools({browser:{backend}}),/backend-unavailable/);
 assert.equal(HARNESS_EXPERIMENTAL_ADMISSION.stagehand.enabled,false);
 assert.match(HARNESS_EXPERIMENTAL_ADMISSION.stagehand.reason,/accounting/);
 assert.equal(HARNESS_EXPERIMENTAL_ADMISSION.team.enabled,false);
 assert.ok(Object.isFrozen(HARNESS_EXPERIMENTAL_ADMISSION.stagehand));
});
