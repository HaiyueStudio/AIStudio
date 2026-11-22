import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_AGENT_APPROVAL_PREFERENCES, parseAgentApprovalPreferences, type AgentApprovalPreferencesV1 } from '@haiyue/ai-studio-contracts';

/** Local device authority, kept outside projects and their journals. */
export class ApprovalPreferences {
  private value = DEFAULT_AGENT_APPROVAL_PREFERENCES;
  private disposed = false;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  async initialize(): Promise<void> {
    try { this.value = parseAgentApprovalPreferences(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.value = Object.freeze({ schemaVersion: 1, mode: 'ask' });
    }
  }
  snapshot(): AgentApprovalPreferencesV1 { return this.value; }
  configure(value: unknown): Promise<AgentApprovalPreferencesV1> {
    if (this.disposed) throw new Error('Approval preferences are disposed.');
    const next = parseAgentApprovalPreferences(value);
    const write = this.writes.then(async () => {
      if (this.disposed) throw new Error('Approval preferences are disposed.');
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      if (!this.disposed) this.value = next;
      return next;
    });
    this.writes = write.catch(() => undefined); return write;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.writes; }
}
