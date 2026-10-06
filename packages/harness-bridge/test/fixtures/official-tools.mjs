import { createHarnessStudioRoot } from '../../dist/index.js';
import { harnessOwnerContext } from '../../dist/ownership.js';
import { createPinnedHarnessAgentTransport, createHarnessOfficialToolProvider } from '../../dist/harness-agent.js';

import { officialBinding } from '../../../studio-contracts/test/fixtures/official-binding.mjs';
export { officialBinding };
export async function officialFixture(options = {}) {
  const binding = options.binding ?? officialBinding();
  const owner = createHarnessStudioRoot();
  const port = createHarnessOfficialToolProvider([binding]);
  const transport = await createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => 'fixture-only', officialTools: port });
  const ctx = harnessOwnerContext(owner);
  const stats = { bodies: 0, results: 0, around: 0, post: 0 };
  const unregister = ctx.tools.register({ name: binding.nativeName, description: 'Raw official fixture', parameters: binding.definition.inputSchema,
    output: { schema: binding.definition.outputSchema, render: (_args,value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { stats.bodies++; return options.execute ? options.execute(args, exec, ctx) : { value: args.query }; },
  });
  ctx.on('tools/execute', async (exec, next) => { if (exec.name === binding.nativeName) stats.around++; return next(); }, { global: true });
  ctx.on('tools/post-execute', async (exec, _result, next) => { if (exec.name === binding.nativeName) stats.post++; return next(); }, { global: true });
  ctx.on('tools/result', exec => { if (exec.name === binding.nativeName) stats.results++; }, { global: true });
  return { owner, transport, port, ctx, binding, stats, unregister };
}
