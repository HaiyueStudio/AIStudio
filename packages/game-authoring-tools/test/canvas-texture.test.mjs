import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { normalizeCanvasTextureRecipe, CANVAS_TEXTURE_RECIPE_SCHEMA } from '../dist/index.js';

const validate = new Ajv({ strict: false }).compile(CANVAS_TEXTURE_RECIPE_SCHEMA);
const recipe = { schemaVersion: 1, width: 256, height: 256, background: '#dabb88', commands: [
  { type: 'rect', x: 8, y: 8, width: 240, height: 240, stroke: '#111111', lineWidth: 2 },
  { type: 'circle', x: 128, y: 128, radius: 80, fill: '#ffeebb', stroke: '#aa0000' },
  { type: 'line', points: [[0, 128], [128, 256]], stroke: '#000000' },
  { type: 'polygon', points: [[0, 0], [20, 0], [10, 20]], fill: '#11223380' },
  { type: 'text', x: 128, y: 128, text: '将', fontSize: 80, fill: '#bb0000', fontFamily: 'serif', fontWeight: 'bold', align: 'center' },
] };
test('Canvas recipe schema and runtime agree on bounded drawing data including Chinese text', () => {
  assert.equal(validate(recipe), true, JSON.stringify(validate.errors));
  const normalized = normalizeCanvasTextureRecipe(recipe); assert.deepEqual(normalized, recipe); assert.notEqual(normalized.commands, recipe.commands);
});
test('Canvas rejects unknown versions, credential fields, executable content, external images and oversized input', () => {
  for (const invalid of [
    { ...recipe, schemaVersion: 2 }, { ...recipe, apiKey: 'secret-test' }, { ...recipe, script: 'fetch("https://example.com")' },
    { ...recipe, width: 2049 }, { ...recipe, height: 0 }, { ...recipe, width: 1.5 }, { ...recipe, background: 'url(https://example.com)' },
    { ...recipe, commands: [{ type: 'image', url: 'https://example.com/a.png' }] },
    { ...recipe, commands: [{ type: 'circle', x: 0, y: 0, radius: -1 }] },
    { ...recipe, commands: [{ type: 'line', points: [[0, 0]], stroke: '#ffffff' }] },
    { ...recipe, commands: [{ type: 'text', x: 0, y: 0, text: 'x', fontSize: 20, fontFamily: 'url(font)' }] },
    { ...recipe, commands: Array.from({ length: 513 }, () => recipe.commands[0]) },
  ]) { assert.equal(validate(invalid), false); assert.throws(() => normalizeCanvasTextureRecipe(invalid), /Texture recipe/); }
  assert.throws(() => normalizeCanvasTextureRecipe({ ...recipe, width: Infinity }), /Texture recipe/);
});
