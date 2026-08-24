import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { EvaluationRunner, createReferenceFixtureAdapter, loadEvaluationAssets } from '../evals/src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = async (relative) => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const text = async (relative) => readFile(path.join(root, relative), 'utf8');

const catalog = await json('config/pricing/m12-pricing-catalog-v1.json');
const pricingSchema = await json('config/contracts/schemas/m12-pricing-catalog.schema.json');
const validatePricing = new Ajv({ allErrors: true, strict: true }).compile(pricingSchema);
assert.equal(validatePricing(catalog), true, validatePricing.errors?.map((entry) => entry.message).join('; '));
assert.deepEqual(new Set(catalog.entries.map((entry) => entry.provider)), new Set(['deepseek', 'openai']));
assert.ok(catalog.entries.every((entry) => Number.isSafeInteger(entry.inputMicrosPerMillion) && Number.isSafeInteger(entry.outputMicrosPerMillion)));
assert.deepEqual(new Set(catalog.sources.map((entry) => entry.url)), new Set(['https://api-docs.deepseek.com/quick_start/pricing/', 'https://platform.openai.com/pricing']));

const assets = await loadEvaluationAssets();
const report = await new EvaluationRunner({ assets, adapterFactory: () => createReferenceFixtureAdapter(assets.referenceEvidence) }).runSuite();
const reportSchema = await json('evals/schemas/evaluation-report-v1.schema.json');
const validateReport = new Ajv2020({ allErrors: true, strict: true }).compile(reportSchema);
assert.equal(validateReport(report), true, validateReport.errors?.map((entry) => entry.message).join('; '));
assert.equal(report.runs.length, 7);
assert.ok(report.runs.every((run) => run.accounting.taskId && run.accounting.budgetId && run.accounting.turns.length === run.execution.turns && run.accounting.tools.length === run.execution.toolCalls));
assert.ok(report.runs.every((run) => run.accounting.turns.every((turn) => turn.usageRecordIds.length) && run.accounting.tools.every((tool) => tool.usageRecordIds.length)));

const harness = await text('packages/agent-backends/src/harness-backend.ts');
const codex = await text('packages/agent-backends/src/codex-backend.ts');
const runtime = await text('packages/agent-runtime/src/index.ts');
const host = await text('apps/ai-studio/src/conversation-host.ts');
const chat = await text('packages/studio-shell/src/panels/chat/index.ts');
assert.match(harness, /reasoningEffort: harnessEffort/); assert.match(harness, /cacheWriteTokens/); assert.match(harness, /finishReason/);
assert.match(codex, /allowProviderModelFallback: false/); assert.match(codex, /codex\.model-catalog-schema-drift/); assert.match(codex, /reasoningOutputTokens/);
assert.match(runtime, /agent\/config-negotiated/); assert.match(runtime, /agent\/usage-recorded/); assert.match(runtime, /event\.kind !== 'usage'/);
assert.match(host, /preflightTool/); assert.match(host, /budget\.hard-stop/); assert.match(host, /billingMode: backend\.descriptor\.kind === 'harness-api-key' \? 'api' : 'subscription'/);
for (const marker of ['Reasoning effort', 'Task usage and cost', 'cache saved', 'Cost unknown']) assert.match(chat, new RegExp(marker));

console.log(`[m12:g03] pricing=${catalog.id}@${catalog.version} models=${catalog.entries.length} evalRuns=${report.runs.length} accountingLinks=ok`);
