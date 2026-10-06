export function officialBinding(effect = 'observe') {
  return { schemaVersion: 1, providerId: 'provider:fixture', nativeName: 'fixture_read', definition: {
    schemaVersion: 1, id: 'official.fixture.read', version: '1.0.0', title: 'Official fixture', description: 'Read official fixture evidence.', effect,
    risk: effect === 'observe' ? 'low' : 'high', requiredCapabilities: ['official.fixture'],
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 256 } }, required: ['query'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: true },
    redactedFields: [], presentation: { intent: 'official', result: 'json' }, timeoutMs: 1000, maxResultBytes: 4096,
    requiresApproval: effect !== 'observe', concurrencySafe: false,
  } };
}
