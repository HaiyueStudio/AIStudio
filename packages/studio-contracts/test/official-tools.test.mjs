import test from 'node:test';
import assert from 'node:assert/strict';
import { isOfficialToolBindingV1, isOfficialToolReceiptV1 } from '../dist/index.js';
import { officialBinding } from './fixtures/official-binding.mjs';

test('official mappings require complete versioned policy and reject escalation, unknown fields and secrets', () => {
  const valid = officialBinding();
  for (const effect of ['observe','external-side-effect','trusted-code','runtime-start']) assert.equal(isOfficialToolBindingV1(officialBinding(effect)), true);
  for (const value of [null, {}, { ...valid, schemaVersion: 2 }, { ...valid, apiKey: 'secret' }, { ...valid, nativeName: 'run_code' },
    ...[{ effect: 'reversible-edit' }, { effect: 'external-side-effect', requiresApproval: false }, { effect: 'trusted-code', concurrencySafe: true }, { id: 'scene.query' }, { timeoutMs: 0 }, { outputSchema: { type: 'string' } }, { description: 'Bearer SECRET_CANARY' }].map(patch => ({ ...valid, definition: { ...valid.definition, ...patch } }))]) assert.equal(isOfficialToolBindingV1(value), false);
});

test('official receipts separate execution/delivery and reject unknown versions, fields and credentials', () => {
 const valid={schemaVersion:1,execution:'completed',delivery:'unavailable',reason:'oversized-result',preview:'Created 42'};
 assert.equal(isOfficialToolReceiptV1(valid),true);
 for(const value of [null,{}, {...valid,schemaVersion:2}, {...valid,execution:'succeeded'}, {...valid,apiKey:'secret'}, {...valid,preview:'Bearer SECRET_CANARY'}, {...valid,preview:'x'.repeat(8193)}, {...valid,delivery:'available'}])assert.equal(isOfficialToolReceiptV1(value),false);
});
