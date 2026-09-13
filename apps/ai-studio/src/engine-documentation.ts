import { readFile } from 'node:fs/promises';
import { EngineDocumentationStore, type EngineDocBundle } from '@haiyue/ai-studio-game-authoring-tools';
import { studioScriptRuntimeDeclarations } from '@haiyue/ai-studio-script-preview';
import { sha256 } from '@haiyue/ai-studio-operation-log';

let loaded: Promise<EngineDocumentationStore> | undefined;
/** Main-process-only, read-only release resources. Never accepts a model-supplied path. */
export function loadEngineDocumentation(): Promise<EngineDocumentationStore> {
  return loaded ??= readDocumentation().catch(cause => { loaded = undefined; throw cause; });
}
async function readDocumentation(): Promise<EngineDocumentationStore> {
  const [text, bindingText] = await Promise.all([
    readFile(new URL('./engine-docs/bundle.json', import.meta.url), 'utf8'),
    readFile(new URL('./engine-docs/binding.json', import.meta.url), 'utf8'),
  ]);
  const binding: unknown = JSON.parse(bindingText);
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('engine.docs.binding-invalid');
  const scriptContractDigest = `sha256:${sha256(studioScriptRuntimeDeclarations(['read', 'scene', 'asset', 'input', 'physics', 'debug']))}`;
  if ((binding as Record<string, unknown>).scriptContractDigest !== scriptContractDigest) throw new Error('engine.docs.version-mismatch: rebuild documentation for the installed Studio runtime.');
  return new EngineDocumentationStore(JSON.parse(text) as unknown, binding as EngineDocBundle['binding']);
}
