import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StableId } from '@haiyue/ai-studio-contracts';
import { sha256 } from '@haiyue/ai-studio-operation-log';
import type { RecoveryClaimPort } from '@haiyue/ai-studio-agent-orchestration';

export interface RecoveryClaimLease { readonly sessionId: StableId; readonly claimId: StableId; readonly ownerPid: number; release(): Promise<void>; }

/** Cross-process fence for one Session recovery owner. A dead PID is recoverable; a live owner always wins. */
export class RecoveryClaimStore implements RecoveryClaimPort {
  private readonly root: string;
  constructor(rootDirectory: string) {
    if (!path.isAbsolute(rootDirectory)) throw new TypeError('Recovery claim root must be absolute.');
    this.root = path.resolve(rootDirectory);
  }

  async acquire(sessionId: StableId, claimId: StableId): Promise<RecoveryClaimLease | null> {
    await mkdir(this.root, { recursive: true });
    const directory = this.claimDirectory(sessionId); const ownerFile = path.join(directory, 'owner.json');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(directory);
        const owner = Object.freeze({ schemaVersion: 1, sessionId, claimId, pid: process.pid, createdAt: new Date().toISOString() });
        await writeFile(ownerFile, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
        let released = false;
        return Object.freeze({ sessionId, claimId, ownerPid: process.pid, release: async () => {
          if (released) return; released = true;
          const current = await readOwner(ownerFile).catch(() => null);
          if (current?.claimId === claimId && current.pid === process.pid) await removeClaimDirectory(directory, this.root);
        } });
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause;
        const owner = await readOwner(ownerFile).catch(() => null);
        if (owner && processAlive(owner.pid)) return null;
        await removeClaimDirectory(directory, this.root);
      }
    }
    return null;
  }

  private claimDirectory(sessionId: StableId): string { return path.join(this.root, `session-${sha256(sessionId).slice(0, 40)}`); }
}

async function readOwner(ownerFile: string): Promise<Readonly<{ claimId: string; pid: number }>> {
  const value = JSON.parse(await readFile(ownerFile, 'utf8')) as Record<string, unknown>;
  if (typeof value.claimId !== 'string' || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) throw new TypeError('Recovery claim owner is invalid.');
  return Object.freeze({ claimId: value.claimId, pid: Number(value.pid) });
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (cause) { return !cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'ESRCH'; } }
function isAlreadyExists(cause: unknown): boolean { return Boolean(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST'); }
async function removeClaimDirectory(directory: string, root: string): Promise<void> {
  const resolved = path.resolve(directory); const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix) || resolved === path.resolve(root)) throw new Error('Refusing to remove a recovery claim outside its root.');
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}
