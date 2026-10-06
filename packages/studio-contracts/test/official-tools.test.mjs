import test from 'node:test';
import assert from 'node:assert/strict';
import { isOfficialToolBindingV1 } from '../dist/index.js';
import { officialBinding } from './fixtures/official-binding.mjs';

test('official mappings require complete versioned policy and reject escalation, unknown fields and secrets', () => {
  const valid = officialBinding();
  for (const effect of ['observe','external-side-effect','trusted-code','runtime-start']) assert.equal(isOfficialToolBindingV1(officialBinding(effect)), true);
  for (const value of [null, {}, { ...valid, schemaVersion: 2 }, { ...valid, apiKey: 'secret' }, { ...valid, nativeName: 'run_code' },
    ...[{ effect: 'reversible-edit' }, { effect: 'external-side-effect', requiresApproval: false }, { effect: 'trusted-code', concurrencySafe: true }, { id: 'scene.query' }, { timeoutMs: 0 }, { outputSchema: { type: 'string' } }, { description: 'Bearer SECRET_CANARY' }].map(patch => ({ ...valid, definition: { ...valid.definition, ...patch } }))]) assert.equal(isOfficialToolBindingV1(value), false);
});
