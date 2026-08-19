import { Context } from '@deepseek-ai/cordis';
import { harnessBridgeUpstreamIdentity } from './index.js';

export async function runHarnessBridgeUpstreamConformance(): Promise<Readonly<{
  identity: ReturnType<typeof harnessBridgeUpstreamIdentity>;
  disposed: readonly string[];
}>> {
  const context = new Context();
  const disposed: string[] = [];
  const plugin = {
    name: 'haiyue-upstream-compatibility',
    apply(ctx: Context) {
      ctx.effect(() => () => { disposed.push('first'); }, 'compat:first');
      ctx.effect(() => () => { disposed.push('second'); }, 'compat:second');
    },
  };
  const fiber = context.plugin(plugin);
  await fiber;
  if (fiber.getEffects().length === 0) throw new Error('Pinned Cordis does not expose effect diagnostics.');
  await context.fiber.dispose();
  if (disposed.join(',') !== 'second,first') throw new Error(`Pinned Cordis teardown order changed: ${disposed.join(',')}`);
  return Object.freeze({ identity: harnessBridgeUpstreamIdentity(), disposed: Object.freeze(disposed) });
}
