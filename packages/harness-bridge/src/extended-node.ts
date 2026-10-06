import { mkdtemp, realpath, rm, readdir, lstat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import LocalFs from '@deepseek-ai/dsh-fs-local';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import { SandboxUnavailableError, type SandboxPolicy as FilePolicy, type ConfinedArgv } from '@deepseek-ai/dsh-sandbox';
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node';
import type { JsonObject } from '@haiyue/ai-studio-contracts';
import { NODE_BINDING, type HarnessExtendedToolOptions } from './extended-tools.js';
import { currentOfficialExecution } from './official-tools.js';

/** The official file sandbox does not restrict reads/network; add those restrictions before admitting code. */
class StudioNodeSandbox extends LocalSandbox {
  override async confine(argv: readonly string[], policy: FilePolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    if (process.platform !== 'darwin') throw new SandboxUnavailableError(policy.mode, 'Studio restricted Node execution requires a reviewed platform adapter.');
    const root = await realpath(policy.workspaceRoot);
    const executable = await realpath(argv[0]!);
    const modules = await realpath(join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json'))), '..', '..'));
    const readable = [root, modules, executable, '/usr/bin/sandbox-exec', '/System', '/usr/lib', '/usr/share', '/Library/Apple', '/dev', '/private/var/db/dyld'];
    const flags = ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${modules}`, `--allow-fs-write=${root}`];
    const confined = await super.confine([argv[0]!, ...flags, ...argv.slice(1)], policy, signal);
    if (confined.enforcement !== 'full') throw new SandboxUnavailableError(policy.mode, 'Full file confinement is required.');
    const quote = (s: string) => JSON.stringify(s);
    // Extend the official Seatbelt invocation in place: macOS rejects nested sandbox_apply.
    if (!confined.argv[0]?.endsWith('sandbox-exec') || confined.argv[1] !== '-p' || typeof confined.argv[2] !== 'string') throw new SandboxUnavailableError(policy.mode, 'Unexpected sandbox runner.');
    const restrictions = `(deny network*) (deny file-read-data) (allow file-read-data (vnode-type DIRECTORY) ${readable.map(p => `(subpath ${quote(p)})`).join(' ')}) (deny file-write* (require-not (require-any (subpath ${quote(root)}) (literal "/dev/null"))))`;
    return { ...confined, argv: [confined.argv[0], '-p', `${confined.argv[2]}\n${restrictions}`, ...confined.argv.slice(3)] };
  }
}

export async function installNodeTools(context: Context, options: HarnessExtendedToolOptions): Promise<void> {
  await context.plugin(LocalFs);
  await context.plugin(LocalSubprocess);
  await context.plugin(StudioNodeSandbox);
  await context.plugin(SandboxPolicy, { mode: 'read-only' });
  await context.plugin(NodePtcRuntime, { timeoutMs: 30000, maxTimeoutMs: 120000, maxOutputBytes: 24000, maxOldGenerationSizeMb: 128, maxMessageBytes: 131072, maxPendingCalls: 4, graceMs: 500, ...(options.node?.executablePath ? { nodeExecutable: options.node.executablePath } : {}) });
  await context.plugin({ name: 'studio:official-node', inject: ['tools', 'ptcRuntime'], apply(ctx) {
    const spec = NODE_BINDING;
    ctx.tools.register({ name: spec.nativeName, description: spec.definition.description, parameters: spec.definition.inputSchema,
      output: { schema: spec.definition.outputSchema, render: (_args,value) => [{type:'text',text:JSON.stringify(value)}] },
      async execute(input, exec) {
        const args = input as JsonObject, call = currentOfficialExecution();
        if (!call) throw new Error('official.host-authorization-required');
        if (process.platform !== 'darwin' || process.versions.electron && !options.node?.executablePath) return { status: 'unavailable', code: 'official.node.restricted-runtime-unavailable' };
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'aistudio-node-')));
        try {
          exec.signal.throwIfAborted();
          const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program: String(args.code), cwd: directory, timeoutMs: Number(args.timeoutMs ?? 30000),
            sandboxPolicy: { mode: 'workspace-write', workspaceRoot: directory }, signal: exec.signal,
            bindings: [{ global: 'inputs', functions: { read: async () => JSON.parse(JSON.stringify(args.input ?? null)) } }],
          }));
          exec.signal.throwIfAborted();
          const files: JsonObject[] = [];
          let bytes = 0;
          if (!result.error) for (const name of await readdir(directory)) {
            if (files.length >= 8) throw new Error('official.node.artifact-limit');
            const path = join(directory,name), stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384 || (bytes += stat.size) > 24000) throw new Error('official.node.artifact-invalid');
            const content = await readFile(path);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
            files.push({ name, content: text, bytes: content.byteLength });
          }
          const value: JsonObject = { status: result.error ? 'error' : 'completed', value: result.value ?? null, logs: result.logs, files,
            ...(result.error ? { code: `official.node.${result.error.kind}`, message: result.error.message.slice(0,2048) } : {}),
            sandbox: { fileMode: 'workspace-write', network: 'denied', subprocess: 'denied', reads: 'runtime-and-scratch', enforcement: result.error?.kind === 'sandbox-unavailable' ? 'unavailable' : result.sandbox?.enforcement ?? 'unavailable' } };
          // The product stores bounded output in its existing artifact store before returning references.
          const artifact = options.storeArtifact ? await options.storeArtifact(value, call, exec.signal) : undefined;
          exec.signal.throwIfAborted();
          return artifact ? { ...value, files: files.map(f => ({ name: f.name!, bytes: f.bytes! })), artifact } : value;
        } finally { await rm(directory, { recursive: true, force: true }); }
      },
    });
  } });
}
