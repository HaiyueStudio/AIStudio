import type { Context } from '@deepseek-ai/cordis';
import type { StudioKernelHost, StudioPluginActivationContext } from '@haiyue/ai-studio-contracts';

// Keep the Cordis scope private while allowing composition through Studio facades.
const owners = new WeakMap<object, { context: Context; assertActive(): void }>();

export function bindHarnessOwner(owner: StudioKernelHost | StudioPluginActivationContext, context: Context, assertActive: () => void): void {
  owners.set(owner, { context, assertActive });
  context.effect(() => () => { owners.delete(owner); }, 'studio.harness-owner');
}

export function harnessOwnerContext(owner: StudioKernelHost | StudioPluginActivationContext): Context {
  const entry = owners.get(owner);
  if (!entry) throw new Error('Harness transport requires a live owner from createHarnessStudioRoot.');
  entry.assertActive();
  return entry.context;
}
